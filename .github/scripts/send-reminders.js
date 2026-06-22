// Familienkalender — Push-Erinnerungen
// Läuft alle 5 Minuten via GitHub Actions, liest fällige Reminders aus Firestore,
// schickt Web-Push an die zugeordneten Geräte.
//
// Erforderliche Env-Variablen:
//   FIREBASE_SA_JSON   — Service-Account-JSON (string)
//   VAPID_PUBLIC_KEY   — Base64-URL Public Key
//   VAPID_PRIVATE_KEY  — Base64-URL Private Key
//   VAPID_SUBJECT      — mailto:... oder URL

process.env.TZ = 'Europe/Berlin'; // alle Date-Operationen in Berlin-Zeit

const admin = require('firebase-admin');
const webpush = require('web-push');
const { DateTime } = require('luxon');

// ── Konfiguration ────────────────────────────────────────────
const ALLDAY_DEFAULT_HOUR = 9;       // all-day Events: 09:00 als Erinnerungs-Anker
const WINDOW_MIN = 7;                // Fenster: now - 7min .. now (5min Cadence + 2min Overlap)
const FIRED_TTL_MS = 24 * 3600_000;  // dedup-Einträge nach 24h löschen
const FUTURE_HORIZON_MS = 30 * 86400_000; // Instanzen-Expansion nur bis 30 Tage in die Zukunft
const MAX_ITER = 10000;              // safety cap pro Recurring-Event
const TODO_CLEANUP_DAYS = 90;        // Erledigte Todos nach 90 Tagen automatisch löschen

// ── Init ─────────────────────────────────────────────────────
const sa = JSON.parse(process.env.FIREBASE_SA_JSON);
admin.initializeApp({ credential: admin.credential.cert(sa) });
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);
const db = admin.firestore();

// ── Helfer: ISO-Datum-Parsing in Berlin-Local ───────────────
function parseLocalDate(iso) {
  // erwartet "YYYY-MM-DD"
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
}
function toISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
function instanceStartMs(dateISO, ev) {
  const d = parseLocalDate(dateISO);
  if (!d) return NaN;
  if (ev.startTime && /^\d{2}:\d{2}/.test(ev.startTime)) {
    const [hh, mm] = ev.startTime.split(':').map(Number);
    d.setHours(hh, mm, 0, 0);
  } else {
    d.setHours(ALLDAY_DEFAULT_HOUR, 0, 0, 0);
  }
  return d.getTime();
}

// ── Recurring-Expansion (mirror von app.js expandEvent) ─────
function expandEventInstances(ev, fromMs, toMs) {
  const out = [];
  const rec = ev.recurring;
  const startISO = ev.date;
  if (!startISO) return out;
  const exc = new Set((rec && rec.exceptions) || []);

  // Single (kein Recurring)
  if (!rec || !rec.type || rec.type === 'none') {
    const d = parseLocalDate(startISO);
    if (!d) return out;
    const ms = instanceStartMs(startISO, ev);
    // Hier: nicht dateMs prüfen, sondern Trigger-Window später — also alle aufnehmen,
    // die im weiten Fenster liegen.
    if (ms >= fromMs - FUTURE_HORIZON_MS && ms <= toMs + FUTURE_HORIZON_MS) {
      if (!exc.has(startISO)) out.push({ dateISO: startISO });
    }
    return out;
  }

  const interval = Math.max(1, rec.interval || 1);
  const recEndMs = rec.endDate ? (parseLocalDate(rec.endDate)?.getTime() ?? null) : null;
  const maxCount = rec.count || null;

  // Weekly mit daysOfWeek (JS-Convention: 0=So, 1=Mo, … 6=Sa)
  if (rec.type === 'weekly' && Array.isArray(rec.daysOfWeek) && rec.daysOfWeek.length) {
    const startDate = parseLocalDate(startISO);
    if (!startDate) return out;
    // Wochenstart Montag
    const weekStart = new Date(startDate);
    const dowMon = (weekStart.getDay() + 6) % 7;
    weekStart.setDate(weekStart.getDate() - dowMon);
    weekStart.setHours(0, 0, 0, 0);
    let count = 0;
    for (let i = 0; i < MAX_ITER; i++) {
      for (const dow of rec.daysOfWeek) {
        const day = new Date(weekStart);
        day.setDate(day.getDate() + ((dow + 6) % 7)); // dow→Mon-basiert
        if (day < startDate) continue;
        const ms = day.getTime();
        if (ms > toMs) return out;
        if (recEndMs != null && ms > recEndMs) return out;
        if (maxCount && count >= maxCount) return out;
        const iso = toISO(day);
        if (!exc.has(iso)) out.push({ dateISO: iso });
        count++;
      }
      weekStart.setDate(weekStart.getDate() + 7 * interval);
      if (weekStart.getTime() > toMs) break;
      if (recEndMs != null && weekStart.getTime() > recEndMs) break;
    }
    return out;
  }

  // Daily / Weekly / Monthly / Yearly (Standard-Iteration)
  const cursor = parseLocalDate(startISO);
  if (!cursor) return out;
  let count = 0;
  for (let i = 0; i < MAX_ITER; i++) {
    const ms = cursor.getTime();
    if (ms > toMs) break;
    if (recEndMs != null && ms > recEndMs) break;
    if (maxCount && count >= maxCount) break;
    const iso = toISO(cursor);
    if (!exc.has(iso) && ms >= fromMs - FUTURE_HORIZON_MS) out.push({ dateISO: iso });
    count++;
    if (rec.type === 'daily')   cursor.setDate(cursor.getDate() + interval);
    else if (rec.type === 'weekly')  cursor.setDate(cursor.getDate() + 7 * interval);
    else if (rec.type === 'monthly') cursor.setMonth(cursor.getMonth() + interval);
    else if (rec.type === 'yearly')  cursor.setFullYear(cursor.getFullYear() + interval);
    else break;
  }
  return out;
}

// ── Empfänger-Auflösung ─────────────────────────────────────
function getRecipientUids(ev, family) {
  const uidToMember = family.uidToMember || {};
  const members = family.members || [];
  // Privat: nur Owner-UIDs
  if (ev.privateMemberId) {
    return Object.keys(uidToMember).filter(uid => uidToMember[uid] === ev.privateMemberId);
  }
  // memberIds = ['all'] oder leer → alle Familien-Member-Ids
  const isAll = !ev.memberIds || ev.memberIds.length === 0 || ev.memberIds[0] === 'all';
  const targetSet = new Set(isAll ? members.map(m => m.id) : ev.memberIds);
  return Object.keys(uidToMember).filter(uid => targetSet.has(uidToMember[uid]));
}

// ── Payload-Body bauen ──────────────────────────────────────
function formatBody(ev, dateISO, offsetMinutes) {
  const dt = DateTime.fromISO(dateISO, { zone: 'Europe/Berlin' });
  const dayLabel = dt.setLocale('de').toFormat('ccc, dd.LL.');
  const timeLabel = ev.startTime ? ` ${ev.startTime}` : '';
  let vor;
  if (offsetMinutes < 60) vor = `in ${offsetMinutes} Min`;
  else if (offsetMinutes < 1440) vor = `in ${Math.round(offsetMinutes / 60)} Std`;
  else if (offsetMinutes < 10080) vor = `in ${Math.round(offsetMinutes / 1440)} Tagen`;
  else vor = `in ${Math.round(offsetMinutes / 10080)} Wochen`;
  return `${dayLabel}${timeLabel} · ${vor}`;
}
function formatTitle(ev) {
  if (ev.type === 'geburtstag') return `🎁 ${ev.title || 'Geburtstag'}`;
  if (ev.type === 'todo')       return `✅ ${ev.title || 'Todo'}`;
  return ev.title || 'Termin';
}

// ── Hauptlauf ───────────────────────────────────────────────
(async () => {
  const now = Date.now();
  const windowStart = now - WINDOW_MIN * 60_000;

  const metaRef = db.doc('_meta/scheduler');
  const metaSnap = await metaRef.get();
  const metaData = metaSnap.exists ? metaSnap.data() : {};
  const fired = metaData.firedReminders || {};

  // Voll-Scan höchstens 1×/Tag: pflegt das hasReminders-Flag (Backfill + Pruning) und
  // erledigt das 90-Tage-Todo-Cleanup. Alle anderen Läufe lesen nur geflaggte Events.
  const todayISO = toISO(new Date(now));
  const doFullScan = (metaData.lastFullScanISO || null) !== todayISO;

  const families = await db.collection('families').get();
  let pushCount = 0;
  let errCount = 0;
  let skippedDedup = 0;
  let processedEvents = 0;

  // Nur Updates am Meta-Doc, am Ende geschrieben
  const newFired = { ...fired };
  // Subscription-Cleanups gesammelt: { familyId: Set<uid> }
  const subCleanup = new Map();

  let cleanupTotal = 0;
  const cleanupCutoffMs = now - TODO_CLEANUP_DAYS * 86400_000;
  const cleanupCutoffISO = toISO(new Date(cleanupCutoffMs));

  for (const famDoc of families.docs) {
    const family = famDoc.data();
    const familyId = famDoc.id;
    const subs = family.pushSubscriptions || {};
    const todosToDelete = [];

    // Schmale Lesung im Normalfall (nur Events mit Reminder), Voll-Lesung nur beim Tages-Scan.
    const eventsSnap = doFullScan
      ? await famDoc.ref.collection('events').get()
      : await famDoc.ref.collection('events').where('hasReminders', '==', true).get();

    const flagBatch = doFullScan ? db.batch() : null;
    let flagWrites = 0;

    for (const evDoc of eventsSnap.docs) {
      const ev = { id: evDoc.id, ...evDoc.data() };

      if (doFullScan) {
        // Idee 4: Erledigte Todos nach 90 Tagen aufräumen — completedAt primär,
        // date als Fallback für Bestand ohne neuen Timestamp. (Vor Flag-Pflege, da
        // zu löschende Docs kein Flag-Update brauchen.)
        if (ev.type === 'todo' && ev.completed === true) {
          const completedAtMs = ev.completedAt && typeof ev.completedAt.toMillis === 'function'
            ? ev.completedAt.toMillis()
            : null;
          const expired = completedAtMs != null
            ? completedAtMs < cleanupCutoffMs
            : (typeof ev.date === 'string' && ev.date < cleanupCutoffISO);
          if (expired) {
            todosToDelete.push(ev.id);
            continue; // erledigte Todos haben eh keine Reminder mehr
          }
        }

        // hasReminders-Flag pflegen: true nur für Events, die noch einen Reminder feuern
        // können (Reminder vorhanden, nicht erledigt, und wiederkehrend ODER nicht vergangen).
        // Backfillt Altbestand und pruned vergangene Einzeltermine, damit die schmale Query klein bleibt.
        const remindersNonEmpty = Array.isArray(ev.reminders) && ev.reminders.length > 0;
        const isRecurring = ev.recurring && ev.recurring.type && ev.recurring.type !== 'none';
        const shouldFlag = remindersNonEmpty && ev.completed !== true
          && (isRecurring || (typeof ev.date === 'string' && ev.date >= todayISO));
        // Nur schreiben, wenn ein Doc in die "true"-Menge rein- oder rausmuss. Docs ohne Flag
        // (Altbestand ohne Reminder) bleiben unangetastet — die schmale Query matcht eh nur == true.
        const needFlagWrite = shouldFlag ? (ev.hasReminders !== true) : (ev.hasReminders === true);
        if (needFlagWrite) {
          flagBatch.update(evDoc.ref, { hasReminders: shouldFlag });
          flagWrites++;
        }
      }

      if (!Array.isArray(ev.reminders) || !ev.reminders.length) continue;
      processedEvents++;

      const instances = expandEventInstances(ev, now - 86400_000, now + FUTURE_HORIZON_MS);
      for (const inst of instances) {
        const startMs = instanceStartMs(inst.dateISO, ev);
        if (!isFinite(startMs)) continue;

        for (const r of ev.reminders) {
          const off = parseInt(r.offsetMinutes);
          if (!isFinite(off) || off <= 0) continue;
          const triggerMs = startMs - off * 60_000;
          if (triggerMs < windowStart || triggerMs > now) continue;

          const dedupKey = `${familyId}|${ev.id}|${inst.dateISO}|${off}`;
          if (newFired[dedupKey]) { skippedDedup++; continue; }

          const recipients = getRecipientUids(ev, family);
          if (!recipients.length) {
            newFired[dedupKey] = admin.firestore.Timestamp.fromMillis(now);
            continue;
          }

          const payload = {
            title: formatTitle(ev),
            body: formatBody(ev, inst.dateISO, off),
            tag: dedupKey,
            data: { eventId: ev.id, date: inst.dateISO },
          };
          const payloadStr = JSON.stringify(payload);

          for (const uid of recipients) {
            const sub = subs[uid];
            if (!sub || !sub.endpoint) continue;
            try {
              await webpush.sendNotification(sub, payloadStr);
              pushCount++;
            } catch (err) {
              errCount++;
              if (err.statusCode === 404 || err.statusCode === 410) {
                if (!subCleanup.has(familyId)) subCleanup.set(familyId, new Set());
                subCleanup.get(familyId).add(uid);
                console.warn(`Subscription expired (${err.statusCode}) for uid=${uid} in family=${familyId} — will cleanup`);
              } else {
                console.error(`Push failed for uid=${uid}, family=${familyId}: ${err.statusCode || ''} ${err.message || err}`);
              }
            }
          }
          newFired[dedupKey] = admin.firestore.Timestamp.fromMillis(now);
        }
      }
    }

    // Flag-Backfill/Pruning committen (nur Voll-Scan)
    if (flagBatch && flagWrites) {
      try {
        await flagBatch.commit();
        console.log(`Flag-Backfill: ${flagWrites} hasReminders-Update(s) in family=${familyId}`);
      } catch (e) {
        console.error(`Flag-Backfill failed for family=${familyId}: ${e.message}`);
      }
    }

    if (todosToDelete.length) {
      const batch = db.batch();
      todosToDelete.forEach(id => batch.delete(famDoc.ref.collection('events').doc(id)));
      try {
        await batch.commit();
        cleanupTotal += todosToDelete.length;
        console.log(`Cleanup: deleted ${todosToDelete.length} completed todos in family=${familyId}`);
      } catch (e) {
        console.error(`Cleanup failed for family=${familyId}: ${e.message}`);
      }
    }
  }

  // Abgelaufene Subscriptions aufräumen
  for (const [familyId, uidSet] of subCleanup.entries()) {
    const updates = {};
    for (const uid of uidSet) updates[`pushSubscriptions.${uid}`] = admin.firestore.FieldValue.delete();
    try {
      await db.collection('families').doc(familyId).update(updates);
      console.log(`Cleaned ${uidSet.size} expired subscription(s) in family=${familyId}`);
    } catch (e) {
      console.error(`Cleanup failed for family=${familyId}: ${e.message}`);
    }
  }

  // Dedup-Map trimmen: alles älter als 24h löschen
  const cutoff = now - FIRED_TTL_MS;
  let trimmed = 0;
  for (const k of Object.keys(newFired)) {
    const v = newFired[k];
    const ms = v?._seconds ? v._seconds * 1000 : (v?.seconds ? v.seconds * 1000 : 0);
    if (ms && ms < cutoff) { delete newFired[k]; trimmed++; }
  }

  await metaRef.set({
    firedReminders: newFired,
    lastRunAt: admin.firestore.Timestamp.fromMillis(now),
    ...(doFullScan ? { lastFullScanISO: todayISO } : {}),
  }, { merge: true });

  console.log(JSON.stringify({
    fullScan: doFullScan,
    pushed: pushCount,
    errors: errCount,
    dedupSkipped: skippedDedup,
    trimmedDedup: trimmed,
    eventsProcessed: processedEvents,
    families: families.size,
    todosCleanedUp: cleanupTotal,
  }));
})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
