'use strict';

// ════════════════════════════════════════════════════════════════
//  CONSTANTS
// ════════════════════════════════════════════════════════════════

const MEMBER_COLORS = [
  '#e63946','#f4a261','#e9c46a','#a8dadc',
  '#4361ee','#7b2d8b','#2ec4b6','#ff6b6b',
  '#1dd1a1','#ffd166','#6a4c93','#f77f00',
];
const BIRTHDAY_COLOR = '#e040fb';

const DE_MONTHS = ['Januar','Februar','März','April','Mai','Juni',
                   'Juli','August','September','Oktober','November','Dezember'];
const DE_MONTHS_SHORT = ['Jan','Feb','Mär','Apr','Mai','Jun',
                          'Jul','Aug','Sep','Okt','Nov','Dez'];
const DE_WEEKDAYS_SHORT = ['So','Mo','Di','Mi','Do','Fr','Sa'];
const DE_WEEKDAYS = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];

const BUNDESLAENDER = {
  BW:'Baden-Württemberg', BY:'Bayern', BE:'Berlin', BB:'Brandenburg',
  HB:'Bremen', HH:'Hamburg', HE:'Hessen', MV:'Mecklenburg-Vorpommern',
  NI:'Niedersachsen', NW:'Nordrhein-Westfalen', RP:'Rheinland-Pfalz',
  SL:'Saarland', SN:'Sachsen', ST:'Sachsen-Anhalt',
  SH:'Schleswig-Holstein', TH:'Thüringen',
};

// ════════════════════════════════════════════════════════════════
//  STATE
// ════════════════════════════════════════════════════════════════

const state = {
  familyId: null,
  family: null,
  events: [],
  currentView: 'monat',
  currentDate: new Date(),
  currentTab: 'kalender',
  todoFilter: 'offen',
  selectedDay: null,
  editingEventId: null,
  editingEventData: null,
  editingMemberId: null,
  recurringAction: null,
  unsubFamily: null,
  unsubEvents: null,
  personFilter: null,
  personFilterTouched: false,
  searchActive: false,
  searchQuery: '',
  holidays: {},
  uid: null,
  notificationStatus: 'unknown',
  hasPushSubscription: false,
  pendingOpenEvent: null,
};

// ════════════════════════════════════════════════════════════════
//  FIREBASE INIT
// ════════════════════════════════════════════════════════════════

let db;
let auth;

async function initFirebase() {
  try {
    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
    db.enablePersistence({ synchronizeTabs: true }).catch(() => {});
    auth = firebase.auth();
    // Anonymous Auth: jedes Gerät bekommt eine stabile UID (in IndexedDB persistiert).
    // Wir warten bis sie sicher verfügbar ist, BEVOR Firestore-Calls laufen.
    const user = await new Promise((resolve, reject) => {
      const unsub = auth.onAuthStateChanged(u => {
        if (u) { unsub(); resolve(u); }
      }, err => { unsub(); reject(err); });
      auth.signInAnonymously().catch(err => { unsub(); reject(err); });
    });
    state.uid = user.uid;
    return true;
  } catch (e) {
    console.error('Firebase init failed', e);
    return false;
  }
}

// ════════════════════════════════════════════════════════════════
//  DATE UTILITIES
// ════════════════════════════════════════════════════════════════

function today() {
  return fmt(new Date());
}

function fmt(d) {
  if (!d) return '';
  if (typeof d === 'string') return d;
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${dd}`;
}

function parseDate(s) {
  if (!s) return null;
  if (s instanceof Date) return s;
  const [y,m,d] = s.split('-').map(Number);
  return new Date(y, m-1, d);
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function relativeDayLabel(d) {
  const t = new Date(); t.setHours(0,0,0,0);
  const target = new Date(d); target.setHours(0,0,0,0);
  const diff = Math.round((target - t) / 86400000);
  switch (diff) {
    case -2: return 'Vorgestern';
    case -1: return 'Gestern';
    case 0:  return 'Heute';
    case 1:  return 'Morgen';
    case 2:  return 'Übermorgen';
    case 3:  return 'In 3 Tagen';
    default: return null;
  }
}

function startOfWeek(d) {
  const day = d.getDay();
  const diff = (day + 6) % 7;
  const r = addDays(d, -diff);
  // Bug 4: Wenn d die aktuelle Tageszeit hat, hatte mon dieselbe Tageszeit.
  // expandEvent vergleicht cur (Mitternacht) mit rangeStart — am Wochen-Montag
  // war Montag-Mitternacht < rangeStart-Mittag, also fielen tägliche Termine raus.
  return new Date(r.getFullYear(), r.getMonth(), r.getDate());
}

// Pt 24: 2-stelliges Jahr
function shortYear(dateStr) {
  if (!dateStr) return '';
  return dateStr.substring(2, 4);
}

function formatDisplay(dateStr) {
  const d = parseDate(dateStr);
  const day = d.getDate();
  const month = DE_MONTHS[d.getMonth()];
  const yr = shortYear(String(d.getFullYear())); // Pt 24
  const todayStr = today();
  if (dateStr === todayStr) return 'Heute';
  if (dateStr === fmt(addDays(parseDate(todayStr), 1))) return 'Morgen';
  if (dateStr === fmt(addDays(parseDate(todayStr), -1))) return 'Gestern';
  return `${DE_WEEKDAYS[d.getDay()]}, ${day}. ${month} ${yr}`;
}

function formatDisplayShort(dateStr) {
  const d = parseDate(dateStr);
  return `${d.getDate()}. ${DE_MONTHS_SHORT[d.getMonth()]} ${shortYear(String(d.getFullYear()))}`; // Pt 24
}

function formatBirthdayDate(dateStr) {
  const d = parseDate(dateStr);
  return `${d.getDate()}. ${DE_MONTHS[d.getMonth()]}`;
}

// ════════════════════════════════════════════════════════════════
//  RECURRING EVENTS
// ════════════════════════════════════════════════════════════════

function expandEvent(event, rangeStart, rangeEnd) {
  if (!event.recurring || event.recurring.type === 'none') {
    const start = parseDate(event.date);
    const end   = event.endDate ? parseDate(event.endDate) : start;
    if (start > rangeEnd || end < rangeStart) return [];

    if (!event.endDate || event.endDate === event.date) {
      return (start >= rangeStart && start <= rangeEnd) ? [{ ...event }] : [];
    }
    // Multi-day: one all-day instance per day — include original start/end for spanning (Pt 12)
    const instances = [];
    let cur = new Date(Math.max(start.getTime(), rangeStart.getTime()));
    const endMs = Math.min(end.getTime(), rangeEnd.getTime());
    while (cur.getTime() <= endMs) {
      instances.push({
        ...event,
        date: fmt(cur),
        startTime: null,
        endTime: null,
        _multiDay: true,
        _multiDayStart: event.date,
        _multiDayEnd: event.endDate,
      });
      cur = addDays(cur, 1);
    }
    return instances;
  }
  const { type, interval = 1, endDate, count } = event.recurring;
  const exceptions = new Set(event.recurring.exceptions || []);
  const instances = [];
  const startDate = parseDate(event.date);
  const endLimit  = endDate ? parseDate(endDate) : null;

  // Bug 3: wöchentliche Wiederholung mit daysOfWeek (z.B. Di+Do+Sa).
  // daysOfWeek nutzt JS getDay()-Konventionen (0=So..6=Sa, siehe wday-btn).
  // Wir iterieren in Wochenblöcken (interval Wochen) und rendern in jedem Block
  // alle ausgewählten Wochentage, deren Datum >= event.date liegt.
  if (type === 'weekly' && Array.isArray(event.recurring.daysOfWeek) && event.recurring.daysOfWeek.length) {
    const daysSet = new Set(event.recurring.daysOfWeek);
    let weekStart = startOfWeek(startDate);
    let n = 0;
    while (true) {
      if (weekStart > rangeEnd) break;
      if (endLimit && weekStart > endLimit) break;
      let stop = false;
      for (let i = 0; i < 7; i++) {
        const d = addDays(weekStart, i);
        if (d < startDate) continue;
        if (!daysSet.has(d.getDay())) continue;
        if (endLimit && d > endLimit) { stop = true; break; }
        if (count != null && n >= count) { stop = true; break; }
        if (d > rangeEnd) { stop = true; break; }
        const ds = fmt(d);
        if (d >= rangeStart && !exceptions.has(ds)) {
          instances.push({ ...event, date: ds, _recurringInstance: true });
        }
        n++;
      }
      if (stop) break;
      weekStart = addDays(weekStart, 7 * interval);
    }
    return instances;
  }

  let cur = new Date(startDate);
  let n = 0;

  while (true) {
    if (endLimit && cur > endLimit) break;
    if (count != null && n >= count) break;
    if (cur > rangeEnd) break;

    const ds = fmt(cur);
    if (cur >= rangeStart && !exceptions.has(ds)) {
      instances.push({ ...event, date: ds, _recurringInstance: true });
    }
    n++;

    const nxt = new Date(cur);
    switch (type) {
      case 'daily':   nxt.setDate(nxt.getDate() + interval); break;
      case 'weekly':  nxt.setDate(nxt.getDate() + 7 * interval); break;
      case 'monthly': nxt.setMonth(nxt.getMonth() + interval); break;
      case 'yearly':  nxt.setFullYear(nxt.getFullYear() + interval); break;
      default: return instances;
    }
    if (nxt <= cur) break;
    cur = nxt;
  }
  return instances;
}

// Idee 3: nächstes Datum einer Recurring-Kette nach event.date — null wenn Kette zu Ende.
// Nutzt expandEvent als Single Source of Truth für daysOfWeek/endDate/count/exceptions.
function nextRecurringDate(ev) {
  if (!ev.recurring || ev.recurring.type === 'none') return null;
  const startDate = parseDate(ev.date);
  const rangeStart = addDays(startDate, 1);
  const rangeEnd = new Date(startDate.getFullYear() + 10, 11, 31);
  const instances = expandEvent(ev, rangeStart, rangeEnd);
  return instances.length > 0 ? instances[0].date : null;
}

function getEventsForRange(startDate, endDate) {
  const result = [];
  for (const ev of state.events) {
    if (ev.type === 'geburtstag') {
      for (let y = startDate.getFullYear() - 1; y <= endDate.getFullYear() + 1; y++) {
        const base = parseDate(ev.date);
        const d = new Date(y, base.getMonth(), base.getDate());
        if (d >= startDate && d <= endDate) {
          result.push({ ...ev, date: fmt(d), _birthdayYear: y, _originalDate: ev.date });
        }
      }
    } else {
      result.push(...expandEvent(ev, startDate, endDate));
    }
  }
  return result;
}

function getEventsForDay(dateStr) {
  const d = parseDate(dateStr);
  return getEventsForRange(d, d).sort(sortEvents);
}

function sortEvents(a, b) {
  if (!a.startTime && !b.startTime) return 0;
  if (!a.startTime) return 1;
  if (!b.startTime) return -1;
  return (a.startTime||'').localeCompare(b.startTime||'');
}

// ════════════════════════════════════════════════════════════════
//  FIREBASE DATA OPERATIONS
// ════════════════════════════════════════════════════════════════

function subscribeFamily(familyId) {
  if (state.unsubFamily) state.unsubFamily();
  state.unsubFamily = db.collection('families').doc(familyId)
    .onSnapshot(doc => {
      if (doc.exists) {
        state.family = { id: doc.id, ...doc.data() };
        if (!state.personFilterTouched && state.family.uidToMember && state.uid) {
          const myId = state.family.uidToMember[state.uid];
          if (myId) state.personFilter = myId;
        }
        renderAll();
        const land = state.family.bundesland;
        if (land) {
          const yr = new Date().getFullYear();
          fetchHolidays(yr);
          fetchHolidays(yr + 1);
        }
        // Idee 1: UID-Person-Onboarding triggern, falls noch nicht zugeordnet
        maybeShowWhoAmI();
      } else {
        localStorage.removeItem('familyId');
        location.reload();
      }
    }, err => {
      // Phase 2: Wenn die UID aus allowedUids entfernt wurde, kommt hier ein
      // permission-denied. Dann zurück auf Pairing-Pending — kein Auto-Lockout-Loop.
      if (err && err.code === 'permission-denied') {
        showPairingPending(familyId);
      } else {
        console.error('Family listen error', err);
      }
    });
}

function subscribeEvents(familyId) {
  if (state.unsubEvents) state.unsubEvents();
  state.unsubEvents = db.collection('families').doc(familyId)
    .collection('events').onSnapshot(snap => {
      state.events = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderCalendar();
      renderTodos();
      renderBirthdays();
      // Idee 2: pending Notification-Click öffnen, sobald Event geladen ist
      if (state.pendingOpenEvent) {
        const { eventId, date } = state.pendingOpenEvent;
        if (state.events.some(e => e.id === eventId)) {
          state.pendingOpenEvent = null;
          openEventFromUrl(eventId, date);
        }
      }
    }, err => console.error('Events listen error', err));
}

async function dbCreateFamily(name, firstMemberName, pinHash = null) {
  const code = genCode();
  const member = { id: genId(), name: firstMemberName, color: MEMBER_COLORS[0] };
  const data = {
    name,
    members: [member],
    allowedUids: state.uid ? [state.uid] : [],
    // Idee 1: erstes Gerät wird direkt seinem ersten Member zugeordnet,
    // damit der Onboarding-Modal beim Familien-Ersteller nicht erscheint.
    uidToMember: state.uid ? { [state.uid]: member.id } : {},
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  };
  if (pinHash) data.pinHash = pinHash;
  await db.collection('families').doc(code).set(data);
  return code;
}

async function dbJoinFamily(code) {
  const upper = code.toUpperCase();
  const ref = db.collection('families').doc(upper);
  // Phase 2: kein automatisches arrayUnion mehr — der Caller muss permission-denied
  // abfangen und die Pairing-Pending-Logik anstoßen.
  const doc = await ref.get();
  if (!doc.exists) throw new Error('Familie nicht gefunden');
  return upper;
}

async function dbSaveEvent(data) {
  const col = db.collection('families').doc(state.familyId).collection('events');
  // hasReminders-Flag: erlaubt dem Server-Reminder-Skript, nur relevante Events zu lesen
  // (statt der kompletten Collection) → spart Firestore-Lesekontingent.
  const hasReminders = Array.isArray(data.reminders) && data.reminders.length > 0;
  if (data.id) {
    const { id, ...rest } = data;
    await col.doc(id).set({ ...rest, hasReminders, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
  } else {
    await col.add({ ...data, hasReminders, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
  }
}

async function dbDeleteEvent(id) {
  await db.collection('families').doc(state.familyId).collection('events').doc(id).delete();
}

async function dbUpdateFamily(data) {
  await db.collection('families').doc(state.familyId).update(data);
}

async function dbAddException(eventId, dateStr) {
  await db.collection('families').doc(state.familyId).collection('events').doc(eventId)
    .update({ 'recurring.exceptions': firebase.firestore.FieldValue.arrayUnion(dateStr) });
}

async function dbSavePushSubscription(uid, subJson) {
  await db.collection('families').doc(state.familyId).update({
    [`pushSubscriptions.${uid}`]: { ...subJson, createdAt: firebase.firestore.FieldValue.serverTimestamp() }
  });
}

async function dbRemovePushSubscription(uid) {
  await db.collection('families').doc(state.familyId).update({
    [`pushSubscriptions.${uid}`]: firebase.firestore.FieldValue.delete()
  });
}

// Letzter-Login pro Gerät. Throttle via localStorage, damit nicht jeder schnelle
// App-Reopen einen Firestore-Write auslöst.
async function recordLastSeen() {
  if (!state.uid || !state.familyId) return;
  const last = parseInt(localStorage.getItem('lastSeenWrittenAt') || '0', 10);
  if (Date.now() - last < 5 * 60 * 1000) return;
  try {
    await commitWrite(dbUpdateFamily({
      [`lastSeen.${state.uid}`]: firebase.firestore.FieldValue.serverTimestamp()
    }));
    localStorage.setItem('lastSeenWrittenAt', String(Date.now()));
  } catch (e) {
    console.warn('lastSeen write failed', e);
  }
}

function formatLastSeen(ts) {
  if (!ts) return '—';
  const d = (typeof ts.toDate === 'function') ? ts.toDate() : new Date(ts);
  if (isNaN(d.getTime())) return '—';
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'gerade eben';
  if (diffMin < 60) return `vor ${diffMin} Min.`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `vor ${diffH} Std.`;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const todayMid = new Date(); todayMid.setHours(0, 0, 0, 0);
  const dMid = new Date(d); dMid.setHours(0, 0, 0, 0);
  const dayDiff = Math.round((todayMid - dMid) / 86400000);
  if (dayDiff === 1) return `gestern ${hh}:${mm}`;
  if (dayDiff < 7) return `vor ${dayDiff} Tagen`;
  const day = String(d.getDate()).padStart(2, '0');
  const mon = String(d.getMonth() + 1).padStart(2, '0');
  return `${day}.${mon}.${d.getFullYear()} ${hh}:${mm}`;
}

// Bug 1+1b: Firestore-Schreibvorgänge resolven offline NICHT — die Daten landen
// zwar lokal im IndexedDB-Cache (und der lokale Listener feuert sofort), aber das
// Promise wartet bis zur Server-Bestätigung. Beim Speichern eines Termins offline
// blieb das UI deshalb mit „Speichert…" hängen. Fix: Online → await wie bisher;
// Offline → fire-and-forget, das UI darf direkt zurückkehren.
function commitWrite(promise) {
  if (navigator.onLine) return promise;
  Promise.resolve(promise).catch(err => console.warn('Offline-Sync später:', err));
  return Promise.resolve();
}

// ════════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════════

function genId() {
  return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

// Pt 17: 12-char code
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// Pt 17: display format XXXX-XXXX-XXXX
function formatCode(code) {
  if (!code) return '';
  if (code.length === 12) return `${code.substr(0,4)}-${code.substr(4,4)}-${code.substr(8,4)}`;
  return code;
}

function getMember(id) {
  if (!state.family) return null;
  return state.family.members.find(m => m.id === id) || null;
}

// Pt 10.1: birthday color; Pt 4: multi-color gradient
function getEventColor(event) {
  if (event.type === 'geburtstag') return BIRTHDAY_COLOR;
  if (event.memberIds && event.memberIds.length > 0 && event.memberIds[0] !== 'all') {
    const m = getMember(event.memberIds[0]);
    if (m) return m.color;
  }
  return '#4361ee';
}

// Pt 4: returns CSS background string (gradient for 2+ members)
function getEventBg(event) {
  if (event.type === 'geburtstag') return BIRTHDAY_COLOR;
  const ids = (event.memberIds || []).filter(id => id !== 'all');
  if (ids.length === 0) return '#1a1a2e';
  const colors = ids.map(id => { const m = getMember(id); return m ? m.color : '#4361ee'; });
  if (colors.length === 1) return colors[0];
  if (colors.length === 2) return `linear-gradient(135deg, ${colors[0]} 50%, ${colors[1]} 50%)`;
  const stop = 100 / colors.length;
  const stops = colors.map((c, i) => `${c} ${(i*stop).toFixed(0)}% ${((i+1)*stop).toFixed(0)}%`);
  return `linear-gradient(135deg, ${stops.join(', ')})`;
}

function initials(name) {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().substr(0,2);
}

// Pt 19: member avatar (photo or colored badge)
function getMemberAvatar(member, size = 'sm') {
  if (!member) return '';
  const sz = size === 'lg' ? '40px' : size === 'md' ? '32px' : '24px';
  const fs = size === 'lg' ? '1.1rem' : size === 'md' ? '.8rem' : '.65rem';
  if (member.photo) {
    return `<img src="${member.photo}" style="width:${sz};height:${sz};border-radius:50%;object-fit:cover;flex-shrink:0;vertical-align:middle" alt="">`;
  }
  return `<div class="member-dot" style="background:${member.color};width:${sz};height:${sz};font-size:${fs};flex-shrink:0">${initials(member.name)}</div>`;
}

function showEl(id)  { const e = document.getElementById(id); if (e) e.classList.remove('hidden'); }
function hideEl(id)  { const e = document.getElementById(id); if (e) e.classList.add('hidden'); }
function setHTML(id, html) { const e = document.getElementById(id); if (e) e.innerHTML = html; }

function showError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}
function hideError(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
}

function formatRecurringLabel(recurring) {
  if (!recurring || recurring.type === 'none') return '';
  const intv = recurring.interval || 1;
  const labels = { daily:'täglich', weekly:'wöchentlich', monthly:'monatlich', yearly:'jährlich' };
  const units  = { daily:['Tag','Tage'], weekly:['Woche','Wochen'], monthly:['Monat','Monate'], yearly:['Jahr','Jahre'] };
  if (intv === 1) return `Wiederholt sich ${labels[recurring.type] || recurring.type}`;
  const u = units[recurring.type] || ['',''];
  return `Alle ${intv} ${intv === 1 ? u[0] : u[1]}`;
}

function calcAge(birthdayDateStr, displayYear) {
  const base = parseDate(birthdayDateStr);
  if (!base || base.getFullYear() <= 1900) return null;
  return displayYear - base.getFullYear();
}

function daysUntil(dateStr) {
  const todayD = parseDate(today());
  const d = parseDate(dateStr);
  return Math.round((d - todayD) / 86400000);
}

// Pt 16: person filter check
function matchesPersonFilter(ev) {
  if (!state.personFilter) return true;
  const ids = ev.memberIds || [];
  return ids[0] === 'all' || ids.includes(state.personFilter);
}

// ── Idee 1: Private Termine/Todos ────────────────────────
// UID→Person-Mapping (state.family.uidToMember) ist Single Source of Truth.
// Privat-Anzeige ist UI-only (Variante A) — Daten in Firestore bleiben Klartext.

function getCurrentMemberId() {
  if (!state.uid || !state.family) return null;
  const map = state.family.uidToMember || {};
  return map[state.uid] || null;
}

function getMemberIdForUid(uid) {
  if (!uid || !state.family) return null;
  return (state.family.uidToMember || {})[uid] || null;
}

// Ein Event ist „für mich versteckt" wenn es einen privateMemberId hat,
// der nicht meiner currentMemberId entspricht. Geräte ohne Mapping bekommen
// nur Placeholder zu sehen (gleich wie Nicht-Eigentümer).
function isPrivateForOthers(ev) {
  if (!ev || !ev.privateMemberId) return false;
  const mine = getCurrentMemberId();
  return ev.privateMemberId !== mine;
}

function displayTitle(ev)       { return isPrivateForOthers(ev) ? '🔒 Privat'  : (ev.title || ''); }
function displayLocation(ev)    { return isPrivateForOthers(ev) ? ''          : (ev.location || ''); }
function displayDescription(ev) { return isPrivateForOthers(ev) ? ''          : (ev.description || ''); }

// Edit-/Delete-Schutz: nur Ersteller (privateMemberId-Owner) darf private Events ändern.
function canEditEvent(ev) {
  if (!ev || !ev.privateMemberId) return true;
  return ev.privateMemberId === getCurrentMemberId();
}

// ════════════════════════════════════════════════════════════════
//  Pt 7: FEIERTAGE
// ════════════════════════════════════════════════════════════════

async function fetchHolidays(year) {
  const land = state.family?.bundesland;
  if (!land) return;
  const key = `feiertage_${year}_${land}`;
  const cached = localStorage.getItem(key);
  if (cached) {
    try { state.holidays[year] = JSON.parse(cached); return; } catch {}
  }
  try {
    const res = await fetch(`https://feiertage-api.de/api/?jahr=${year}&nur_land=${land}`);
    const data = await res.json();
    state.holidays[year] = Object.entries(data).map(([name, val]) => ({ date: val.datum, name }));
    localStorage.setItem(key, JSON.stringify(state.holidays[year]));
    renderCalendar();
  } catch {}
}

function getHolidayName(dateStr) {
  const yr = parseInt(dateStr.substring(0, 4));
  const list = state.holidays[yr] || [];
  const h = list.find(h => h.date === dateStr);
  return h ? h.name : null;
}

// ════════════════════════════════════════════════════════════════
//  Pt 18: NIGHT MODE
// ════════════════════════════════════════════════════════════════

function applyTheme() {
  const mode = localStorage.getItem('theme_mode') || 'light';
  if (mode === 'auto') {
    checkAutoTheme();
  } else {
    setThemeAttr(mode);
  }
}

function setThemeAttr(theme) {
  document.documentElement.dataset.theme = theme;
  const tc = document.querySelector('meta[name=theme-color]');
  if (tc) tc.content = theme === 'dark' ? '#1a1a2e' : '#4361ee';
}

function checkAutoTheme() {
  const from = localStorage.getItem('theme_from') || '20:00';
  const to   = localStorage.getItem('theme_to')   || '07:00';
  const now  = new Date();
  const t    = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  const isDark = from > to ? (t >= from || t < to) : (t >= from && t < to);
  setThemeAttr(isDark ? 'dark' : 'light');
}

function toggleNightMode() {
  const chk = document.getElementById('night-mode-toggle');
  const autoWrap = document.getElementById('night-mode-auto-wrap');
  if (!chk) return;
  const currentMode = localStorage.getItem('theme_mode') || 'light';
  const isNowDark = chk.checked;
  if (!isNowDark) {
    localStorage.setItem('theme_mode', 'light');
    setThemeAttr('light');
    if (autoWrap) autoWrap.classList.add('hidden');
    const autoChk = document.getElementById('night-mode-auto');
    if (autoChk) autoChk.checked = false;
  } else {
    localStorage.setItem('theme_mode', 'dark');
    setThemeAttr('dark');
    if (autoWrap) autoWrap.classList.remove('hidden');
  }
}

function toggleAutoNightMode() {
  const autoChk = document.getElementById('night-mode-auto');
  const schedWrap = document.getElementById('night-mode-schedule');
  if (!autoChk) return;
  if (autoChk.checked) {
    localStorage.setItem('theme_mode', 'auto');
    if (schedWrap) schedWrap.classList.remove('hidden');
    checkAutoTheme();
  } else {
    localStorage.setItem('theme_mode', 'dark');
    if (schedWrap) schedWrap.classList.add('hidden');
    setThemeAttr('dark');
  }
}

function saveNightModeSchedule() {
  const from = document.getElementById('night-mode-from')?.value || '20:00';
  const to   = document.getElementById('night-mode-to')?.value   || '07:00';
  localStorage.setItem('theme_from', from);
  localStorage.setItem('theme_to',   to);
  checkAutoTheme();
}

function renderNightModeSettings() {
  const mode = localStorage.getItem('theme_mode') || 'light';
  const from = localStorage.getItem('theme_from') || '20:00';
  const to   = localStorage.getItem('theme_to')   || '07:00';

  const darkChk  = document.getElementById('night-mode-toggle');
  const autoChk  = document.getElementById('night-mode-auto');
  const autoWrap = document.getElementById('night-mode-auto-wrap');
  const schedWrap= document.getElementById('night-mode-schedule');
  const fromEl   = document.getElementById('night-mode-from');
  const toEl     = document.getElementById('night-mode-to');

  if (darkChk) darkChk.checked = (mode === 'dark' || mode === 'auto');
  if (autoWrap) autoWrap.classList.toggle('hidden', mode === 'light');
  if (autoChk) autoChk.checked = (mode === 'auto');
  if (schedWrap) schedWrap.classList.toggle('hidden', mode !== 'auto');
  if (fromEl) fromEl.value = from;
  if (toEl)   toEl.value   = to;
}

// ════════════════════════════════════════════════════════════════
//  Pt 26: PIN PROTECTION
// ════════════════════════════════════════════════════════════════

// saltB64 = null → neuen Salt generieren (beim Setzen); saltB64 = string → bestehenden Salt nutzen (beim Prüfen)
async function hashPin(pin, saltB64 = null) {
  const saltBytes = saltB64
    ? Uint8Array.from(atob(saltB64), c => c.charCodeAt(0))
    : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: 200000, hash: 'SHA-256' }, key, 256
  );
  const hex  = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2,'0')).join('');
  const salt = btoa(String.fromCharCode(...saltBytes));
  return `${salt}:${hex}`;
}

async function legacySha256Hex(pin) {
  const bits = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pin));
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2,'0')).join('');
}

function isLegacyPinHash(stored) {
  return typeof stored === 'string' && !stored.includes(':') && /^[0-9a-f]{64}$/i.test(stored);
}

function checkPinLockout() {
  const until = parseInt(localStorage.getItem('pin_locked_until') || '0');
  return Date.now() < until ? Math.ceil((until - Date.now()) / 1000) : 0;
}
function recordPinFailure() {
  const n = parseInt(localStorage.getItem('pin_attempts') || '0') + 1;
  localStorage.setItem('pin_attempts', String(n));
  if (n >= 5) {
    localStorage.setItem('pin_locked_until', String(Date.now() + 60000));
    localStorage.removeItem('pin_attempts');
    return true;
  }
  return false;
}
function clearPinLockout() {
  localStorage.removeItem('pin_attempts');
  localStorage.removeItem('pin_locked_until');
}

function isPinExpired() {
  const ts = localStorage.getItem('pin_verified_at');
  return !ts || (Date.now() - parseInt(ts)) > 86400000;
}

let pinCallback = null;

function showPinPrompt(desc, callback) {
  pinCallback = callback;
  const descEl = document.getElementById('pin-desc');
  if (descEl) descEl.textContent = desc || 'Bitte PIN eingeben';
  const inp = document.getElementById('pin-input');
  if (inp) inp.value = '';
  hideError('pin-error');
  hideEl('screen-loading');
  hideEl('screen-setup');
  hideEl('screen-app');
  showEl('screen-pin');
  setTimeout(() => inp?.focus(), 150);
}

async function confirmPin() {
  const secs = checkPinLockout();
  if (secs > 0) { showError('pin-error', `Zu viele Fehlversuche. Bitte noch ${secs}s warten.`); return; }

  const inp = document.getElementById('pin-input');
  const pin = inp?.value.trim();
  if (!pin || pin.length < 4) { showError('pin-error', 'Bitte mindestens 4 Ziffern eingeben'); return; }
  if (!/^\d+$/.test(pin))     { showError('pin-error', 'Nur Ziffern erlaubt'); return; }

  const stored = state.family?.pinHash || '';
  let ok = false;
  let needsMigration = false;

  if (isLegacyPinHash(stored)) {
    const legacyComputed = await legacySha256Hex(pin);
    ok = (legacyComputed === stored);
    needsMigration = ok;
  } else {
    const [saltB64] = stored.split(':');
    const computed  = await hashPin(pin, saltB64);
    ok = (computed === stored);
  }

  if (!ok) {
    const locked = recordPinFailure();
    const remaining = 5 - parseInt(localStorage.getItem('pin_attempts') || '0');
    showError('pin-error', locked
      ? 'Zu viele Fehlversuche. Bitte 60s warten.'
      : `Falscher PIN. Noch ${remaining} Versuch${remaining === 1 ? '' : 'e'}.`);
    if (inp) inp.value = '';
    return;
  }

  if (needsMigration) {
    try {
      const newHash = await hashPin(pin);
      await dbUpdateFamily({ pinHash: newHash });
    } catch (e) {
      console.warn('[PIN] Migration auf neues Format fehlgeschlagen:', e.message);
    }
  }
  clearPinLockout();
  localStorage.setItem('pin_verified_at', String(Date.now()));
  hideEl('screen-pin');
  const cb = pinCallback; pinCallback = null;
  if (cb) cb();
}

function renderPinSettings() {
  const hasPIN    = !!state.family?.pinHash;
  const statusEl  = document.getElementById('pin-settings-status');
  const actionsEl = document.getElementById('pin-settings-actions');
  if (statusEl) statusEl.textContent = hasPIN
    ? 'PIN-Schutz ist aktiv. Wird 1× täglich abgefragt.'
    : 'Kein PIN-Schutz. Kalender ist ohne Abfrage zugänglich.';
  if (!actionsEl) return;
  if (hasPIN) {
    actionsEl.innerHTML =
      `<button class="btn-secondary btn-full" onclick="App.openChangePIN()">PIN ändern</button>
       <button class="btn-danger-outline" onclick="App.openRemovePIN()">PIN entfernen</button>`;
  } else {
    actionsEl.innerHTML =
      `<button class="btn-secondary btn-full" onclick="App.openSetPIN()">PIN einrichten</button>`;
  }
}

let pinManageMode = null;

function openSetPIN() {
  pinManageMode = 'set';
  document.getElementById('pin-manage-title').textContent = 'PIN einrichten';
  document.getElementById('pin-manage-current-group').classList.add('hidden');
  document.getElementById('pin-manage-new-group').classList.remove('hidden');
  document.getElementById('pin-manage-current').value = '';
  document.getElementById('pin-manage-new').value = '';
  hideError('pin-manage-error');
  openSheet('sheet-pin-manage');
}

function openChangePIN() {
  pinManageMode = 'change';
  document.getElementById('pin-manage-title').textContent = 'PIN ändern';
  document.getElementById('pin-manage-current-group').classList.remove('hidden');
  document.getElementById('pin-manage-new-group').classList.remove('hidden');
  document.getElementById('pin-manage-current').value = '';
  document.getElementById('pin-manage-new').value = '';
  hideError('pin-manage-error');
  openSheet('sheet-pin-manage');
}

function openRemovePIN() {
  pinManageMode = 'remove';
  document.getElementById('pin-manage-title').textContent = 'PIN entfernen';
  document.getElementById('pin-manage-current-group').classList.remove('hidden');
  document.getElementById('pin-manage-new-group').classList.add('hidden');
  document.getElementById('pin-manage-current').value = '';
  hideError('pin-manage-error');
  openSheet('sheet-pin-manage');
}

async function savePinManage() {
  const currentVal = document.getElementById('pin-manage-current')?.value.trim();
  const newVal     = document.getElementById('pin-manage-new')?.value.trim();

  if (pinManageMode === 'change' || pinManageMode === 'remove') {
    const secs = checkPinLockout();
    if (secs > 0) { showError('pin-manage-error', `Gesperrt. Bitte noch ${secs}s warten.`); return; }
    if (!currentVal || currentVal.length < 4) {
      showError('pin-manage-error', 'Bitte aktuellen PIN eingeben (mind. 4 Ziffern)'); return;
    }
    const storedCur = state.family.pinHash || '';
    let curOk = false;
    if (isLegacyPinHash(storedCur)) {
      curOk = (await legacySha256Hex(currentVal)) === storedCur;
    } else {
      const [saltB64cur] = storedCur.split(':');
      curOk = (await hashPin(currentVal, saltB64cur)) === storedCur;
    }
    if (!curOk) {
      const locked = recordPinFailure();
      const remaining = 5 - parseInt(localStorage.getItem('pin_attempts') || '0');
      showError('pin-manage-error', locked
        ? 'Zu viele Fehlversuche. Bitte 60s warten.'
        : `Falscher PIN. Noch ${remaining} Versuch${remaining === 1 ? '' : 'e'}.`);
      return;
    }
    clearPinLockout();
  }

  if (pinManageMode === 'remove') {
    try {
      await dbUpdateFamily({ pinHash: null });
      localStorage.removeItem('pin_verified_at');
      closeSheet('sheet-pin-manage');
      renderPinSettings();
    } catch(e) { showError('pin-manage-error', 'Fehler: ' + e.message); }
    return;
  }

  if (!newVal || newVal.length < 4) { showError('pin-manage-error', 'Neuer PIN: mind. 4 Ziffern'); return; }
  if (!/^\d+$/.test(newVal))        { showError('pin-manage-error', 'Nur Ziffern erlaubt'); return; }

  try {
    const newHash = await hashPin(newVal);
    await dbUpdateFamily({ pinHash: newHash });
    localStorage.setItem('pin_verified_at', String(Date.now()));
    closeSheet('sheet-pin-manage');
    renderPinSettings();
  } catch(e) { showError('pin-manage-error', 'Fehler: ' + e.message); }
}

// ════════════════════════════════════════════════════════════════
//  RENDER: CALENDAR HEADER TITLE
// ════════════════════════════════════════════════════════════════

function renderHeaderTitle() {
  const d = state.currentDate;
  let title = '';
  let badge = '';
  if (state.currentView === 'monat') {
    title = `${DE_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  } else if (state.currentView === 'woche') {
    const mon = startOfWeek(d);
    const sun = addDays(mon, 6);
    if (mon.getMonth() === sun.getMonth()) {
      title = `${mon.getDate()}. – ${sun.getDate()}. ${DE_MONTHS_SHORT[mon.getMonth()]} ${mon.getFullYear()}`;
    } else {
      title = `${mon.getDate()}. ${DE_MONTHS_SHORT[mon.getMonth()]} – ${sun.getDate()}. ${DE_MONTHS_SHORT[sun.getMonth()]}`;
    }
  } else {
    title = `${d.getDate()}. ${DE_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    const rel = relativeDayLabel(d);
    if (rel) badge = ` <span class="header-today-badge">${rel}</span>`;
  }
  const el = document.getElementById('header-title');
  if (el) el.innerHTML = title + badge;
}

// ════════════════════════════════════════════════════════════════
//  RENDER: PERSON FILTER BAR (Pt 16)
// ════════════════════════════════════════════════════════════════

function renderPersonFilter() {
  const members = state.family?.members || [];
  if (members.length === 0) {
    ['person-filter-bar','person-filter-bar-todos'].forEach(id => hideEl(id));
    return;
  }

  const chips = members.map(m => {
    const active = state.personFilter === m.id;
    return `<button class="person-filter-chip${active?' active':''}" onclick="App.setPersonFilter('${m.id}')" style="${active?`--chip-color:${m.color}`:''}">
      ${getMemberAvatar(m,'sm')}
      <span>${m.name}</span>
    </button>`;
  }).join('');

  const allActive = !state.personFilter;
  const html = `<button class="person-filter-chip${allActive?' active':''}${allActive?' all':''}" onclick="App.setPersonFilter(null)">Alle</button>${chips}`;

  ['person-filter-bar','person-filter-bar-todos'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = html;
    el.classList.remove('hidden');
  });
}

function setPersonFilter(id) {
  state.personFilter = id || null;
  state.personFilterTouched = true;
  renderPersonFilter();
  renderCalendar();
  renderTodos();
}

// ════════════════════════════════════════════════════════════════
//  RENDER: MONTH VIEW
// ════════════════════════════════════════════════════════════════

function renderMonthView() {
  const d = state.currentDate;
  const year = d.getFullYear();
  const month = d.getMonth();
  const todayStr = today();

  const firstDay = new Date(year, month, 1);
  const lastDay  = new Date(year, month+1, 0);
  const startDow = (firstDay.getDay() + 6) % 7;

  const rangeStart = addDays(firstDay, -startDow);
  const rangeEnd   = addDays(lastDay, 42 - lastDay.getDate() - startDow);

  // Pt 13: exclude todos from calendar
  const eventsInRange = getEventsForRange(rangeStart, rangeEnd).filter(e => e.type !== 'todo');

  const byDate = {};
  for (const ev of eventsInRange) {
    if (!matchesPersonFilter(ev)) continue;
    if (!byDate[ev.date]) byDate[ev.date] = [];
    byDate[ev.date].push(ev);
  }

  let html = '';
  for (let i = 0; i < startDow; i++) {
    const pd = addDays(firstDay, -(startDow - i));
    const ds = fmt(pd);
    html += renderMonthCell(ds, pd.getDate(), true, byDate[ds] || [], todayStr);
  }
  for (let day = 1; day <= lastDay.getDate(); day++) {
    const pd = new Date(year, month, day);
    const ds = fmt(pd);
    html += renderMonthCell(ds, day, false, byDate[ds] || [], todayStr);
  }
  const cellsUsed = startDow + lastDay.getDate();
  const pad = (7 - (cellsUsed % 7)) % 7;
  for (let i = 1; i <= pad; i++) {
    const pd = new Date(year, month+1, i);
    const ds = fmt(pd);
    html += renderMonthCell(ds, pd.getDate(), true, byDate[ds] || [], todayStr);
  }

  setHTML('month-grid', html);
}

function renderMonthCell(ds, dayNum, otherMonth, events, todayStr) {
  const d = parseDate(ds);
  const dow = d.getDay();
  const isWeekend = dow === 0 || dow === 6;
  const isToday = ds === todayStr;
  const isSelected = ds === state.selectedDay;
  const holiday = getHolidayName(ds); // Pt 7

  let cls = 'month-cell';
  if (otherMonth) cls += ' other-month';
  if (isToday) cls += ' today';
  if (isSelected) cls += ' selected';
  if ((isWeekend || holiday) && !otherMonth) cls += ' weekend';

  // Sort: regular events first, birthdays last
  const sorted = [...events].sort((a,b) => {
    if (a.type === 'geburtstag' && b.type !== 'geburtstag') return 1;
    if (b.type === 'geburtstag' && a.type !== 'geburtstag') return -1;
    return (a.startTime||'').localeCompare(b.startTime||'');
  });

  let chipsHtml = '';
  const MAX = 3;
  for (let i = 0; i < Math.min(sorted.length, MAX); i++) {
    const ev = sorted[i];
    const bg = getEventBg(ev); // Pt 4: multi-color gradient
    const icon = ev.type === 'geburtstag' ? '🎁 ' : '';
    // Idee 1: Privat-Anzeige
    const hidden = isPrivateForOthers(ev);
    const ownPriv = (ev.privateMemberId && !hidden) ? '🔒 ' : '';
    const titleDisp = hidden ? '🔒 Privat' : ev.title;
    const label = hidden ? '🔒 Privat' : `${icon}${ownPriv}${ev.title}`;

    // Pt 12: multi-day spanning indicator
    let spanCls = '';
    if (ev._multiDay) {
      if (ev._multiDayStart === ds) spanCls = ' span-start';
      else if (ev._multiDayEnd === ds) spanCls = ' span-end';
      else spanCls = ' span-mid';
    }

    chipsHtml += `<div class="cell-event-chip${spanCls}" style="background:${bg}" title="${titleDisp}" onclick="event.stopPropagation();App.openEventDetail('${ev.id}','${ev.date}')">${label}</div>`;
  }
  if (sorted.length > MAX) {
    chipsHtml += `<div class="cell-more">+${sorted.length - MAX}</div>`;
  }

  // Pt 7: Feiertag badge
  const holidayHtml = holiday ? `<div class="cell-holiday" title="${holiday}">${holiday}</div>` : '';

  const weekdayShort = DE_WEEKDAYS_SHORT[dow];
  return `<div class="${cls}" onclick="App.selectDay('${ds}')">
    <div class="cell-day-row">
      <span class="cell-weekday">${weekdayShort}</span>
      <div class="cell-day">${dayNum}</div>
    </div>
    <div class="cell-events">${chipsHtml}</div>
    ${holidayHtml}
  </div>`;
}

function renderDayPanel(dateStr) {
  const d = parseDate(dateStr);
  const label = `${DE_WEEKDAYS[d.getDay()]}, ${d.getDate()}. ${DE_MONTHS[d.getMonth()]}`;
  setHTML('day-detail-label', label);

  // Pt 8: wire up add button with prefilled date
  const addBtn = document.getElementById('day-detail-add-btn');
  if (addBtn) addBtn.onclick = () => openAddEvent('termin', dateStr);

  // Pt 13: exclude todos from day panel
  const events = getEventsForDay(dateStr).filter(e => e.type !== 'todo');
  const filtered = events.filter(matchesPersonFilter);

  if (filtered.length === 0) {
    setHTML('day-detail-events', '<p style="color:var(--text-2);font-size:.9rem;padding:8px 4px">Keine Termine</p>');
  } else {
    setHTML('day-detail-events', filtered.map(ev => renderEventCard(ev)).join(''));
  }
  showEl('day-detail-panel');
}

// ════════════════════════════════════════════════════════════════
//  RENDER: WEEK VIEW
// ════════════════════════════════════════════════════════════════

function renderWeekView() {
  const mon = startOfWeek(state.currentDate);
  const todayStr = today();
  const H = 48;

  let hdrDays = '';
  for (let i = 0; i < 7; i++) {
    const d = addDays(mon, i);
    const ds = fmt(d);
    const isToday = ds === todayStr;
    hdrDays += `<div class="wg-day wh-cell${isToday?' today':''}">
      <div class="wh-weekday">${DE_WEEKDAYS_SHORT[d.getDay()]}</div>
      <div class="wh-day" onclick="App.goToDay('${ds}')">${d.getDate()}</div>
    </div>`;
  }
  setHTML('week-header',
    `<div class="wg-wrap"><div class="wg-times"></div><div class="wg-days">${hdrDays}</div></div>`);

  const rangeStart = mon;
  const rangeEnd   = addDays(mon, 6);
  // Pt 13: exclude todos
  const allEvents  = getEventsForRange(rangeStart, rangeEnd)
    .filter(e => e.type !== 'todo')
    .filter(matchesPersonFilter);

  const allDay = allEvents.filter(e => !e.startTime);
  // Pt 2.2 Bug fix: only events with valid HH:MM startTime
  const timed  = allEvents.filter(e => e.startTime && e.startTime.length === 5);

  // All-day row — Pt 12: multi-day spanning chips + Pt 7: feiertage
  const alldayByDay = {};
  const seenMultiday = new Set();
  for (let i = 0; i < 7; i++) {
    const ds = fmt(addDays(mon, i));
    alldayByDay[ds] = [];
  }
  // Feiertage as all-day entries
  for (let i = 0; i < 7; i++) {
    const ds = fmt(addDays(mon, i));
    const hol = getHolidayName(ds);
    if (hol) alldayByDay[ds].push({ _isHoliday: true, title: hol, date: ds });
  }
  for (const ev of allDay) {
    if (ev._multiDay) {
      // For multi-day in week view: show once per event (start or first visible day)
      const startDs = ev._multiDayStart >= fmt(mon) ? ev._multiDayStart : fmt(mon);
      if (!seenMultiday.has(ev.id + ev._multiDayStart)) {
        seenMultiday.add(ev.id + ev._multiDayStart);
        // Calculate span (days within this week)
        let spanCount = 0;
        let cur = parseDate(startDs);
        const endD = parseDate(ev._multiDayEnd);
        const weekEnd = addDays(mon, 6);
        while (cur <= endD && cur <= weekEnd) { spanCount++; cur = addDays(cur, 1); }
        if (!alldayByDay[startDs]) alldayByDay[startDs] = [];
        alldayByDay[startDs].push({ ...ev, _weekSpan: spanCount });
      }
    } else {
      if (!alldayByDay[ev.date]) alldayByDay[ev.date] = [];
      alldayByDay[ev.date].push(ev);
    }
  }

  let alldayDays = '';
  let hasAllday = false;
  for (let i = 0; i < 7; i++) {
    const ds = fmt(addDays(mon, i));
    const evs = alldayByDay[ds] || [];
    if (evs.length) hasAllday = true;
    alldayDays += `<div class="wg-day" style="min-height:${evs.length?28:4}px;overflow:visible;position:relative">${evs.map(ev => {
      if (ev._isHoliday) {
        return `<div class="cell-event-chip holiday-chip" title="${ev.title}">${ev.title}</div>`;
      }
      const bg = getEventBg(ev);
      const icon = ev.type === 'geburtstag' ? '🎁 ' : '';
      const span = ev._weekSpan || 1;
      // Pt 12: spanning style
      const spanStyle = span > 1 ? `position:absolute;left:0;width:calc(${span*100}% + ${(span-1)}px);z-index:2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;` : '';
      // Idee 1: Privat-Anzeige
      const hidden = isPrivateForOthers(ev);
      const ownPriv = (ev.privateMemberId && !hidden) ? '🔒 ' : '';
      const titleHtml = hidden ? '🔒 Privat' : `${icon}${ownPriv}${ev.title}`;
      return `<div class="cell-event-chip${ev._multiDay?' multi-day-chip':''}" style="background:${bg};margin:1px;cursor:pointer;${spanStyle}" onclick="App.openEventDetail('${ev.id}','${ev.date}')">${titleHtml}</div>`;
    }).join('')}</div>`;
  }

  const alldayEl = document.getElementById('week-allday');
  if (hasAllday) {
    alldayEl.innerHTML = `<div class="wg-wrap"><div class="wg-times"></div><div class="wg-days" style="position:relative">${alldayDays}</div></div>`;
    alldayEl.classList.remove('hidden');
  } else {
    alldayEl.classList.add('hidden');
  }

  // Time grid
  let timesHtml = '';
  for (let h = 0; h < 24; h++) {
    timesHtml += `<div class="wg-time-label">${h > 0 ? h+':00' : ''}</div>`;
  }

  let daysHtml = '';
  for (let day = 0; day < 7; day++) {
    const ds = fmt(addDays(mon, day));
    const dayEvents = timed.filter(e => e.date === ds);

    let colHtml = '';
    for (let h = 0; h < 24; h++) {
      // Pt 8: click on time slot to create event
      colHtml += `<div class="wg-hour" onclick="App.openAddEvent('termin','${ds}','${String(h).padStart(2,'0')}:00')"></div>`;
    }

    for (const ev of dayEvents) {
      const [sh, sm] = ev.startTime.split(':').map(Number);
      const [eh, em] = (ev.endTime || `${String(sh+1).padStart(2,'0')}:00`).split(':').map(Number);
      const top    = sh * H + sm / 60 * H;
      const height = Math.max(22, (eh-sh)*H + (em-sm)/60*H);
      const bg     = getEventBg(ev);
      // Idee 1: Privat-Anzeige
      const hidden = isPrivateForOthers(ev);
      const descDisp = displayDescription(ev);
      const noteHtml = descDisp ? `<span class="eb-note">${descDisp}</span>` : '';
      const ownPriv = (ev.privateMemberId && !hidden) ? '🔒 ' : '';
      const titleHtml = hidden ? '🔒 Privat' : `${ev.type==='geburtstag'?'🎁 ':''}${ownPriv}${ev.title}`;
      colHtml += `<div class="event-block" style="background:${bg};top:${top}px;height:${height}px" onclick="event.stopPropagation();App.openEventDetail('${ev.id}','${ev.date}')">
        <span>${titleHtml}</span>
        <span class="eb-time">${ev.startTime}${ev.endTime?'–'+ev.endTime:''}</span>
        ${noteHtml}
      </div>`;
    }
    daysHtml += `<div class="wg-day">${colHtml}</div>`;
  }

  // Pt 2.1 Bug fix: now-line spans all columns (outside individual column divs)
  let nowLineHtml = '';
  const weekDates = Array.from({length:7}, (_,i) => fmt(addDays(mon,i)));
  if (weekDates.includes(todayStr)) {
    const nowD = new Date();
    const nowTop = nowD.getHours() * H + nowD.getMinutes() / 60 * H;
    nowLineHtml = `<div class="week-now-line" style="top:${nowTop}px"><div class="now-dot"></div></div>`;
  }

  setHTML('week-grid',
    `<div class="wg-wrap"><div class="wg-times">${timesHtml}</div><div class="wg-days" style="position:relative">${daysHtml}${nowLineHtml}</div></div>`);

  setTimeout(() => {
    const wrap = document.querySelector('#view-woche .time-scroll-wrap');
    if (wrap) wrap.scrollTop = 8 * H;
  }, 150);
}

// ════════════════════════════════════════════════════════════════
//  RENDER: DAY VIEW
// ════════════════════════════════════════════════════════════════

function renderDayView() {
  const ds     = fmt(state.currentDate);
  const dayItems = getEventsForDay(ds).filter(matchesPersonFilter);
  // Pt 13: Termine (ohne Todos)
  const events = dayItems.filter(e => e.type !== 'todo');
  // Pt 2.2 / 1 Bug fix: only valid HH:MM startTime
  const timed  = events.filter(e => e.startTime && e.startTime.length === 5)
                       .sort((a, b) => a.startTime.localeCompare(b.startTime));
  const allDay = events.filter(e => !e.startTime);
  const holName = getHolidayName(ds);
  // Sektion 3: offene Todos, die auf diesen Tag fallen
  const todos = dayItems.filter(e => e.type === 'todo' && !e.completed);

  let html = '';

  // Sektion 1: Ganztags (Feiertag + ganztägige Events)
  if (holName || allDay.length > 0) {
    const allDayCount = (holName ? 1 : 0) + allDay.length;
    html += `<div class="day-section-label">Ganztags <span class="day-section-count">· ${allDayCount}</span></div>`;
    if (holName) {
      html += `<div class="day-holiday-card">🎉 ${holName}</div>`;
    }
    html += allDay.map(ev => renderEventCard(ev)).join('');
  }

  // Sektion 2: Mit Uhrzeit
  if (timed.length > 0) {
    html += `<div class="day-section-label">Mit Uhrzeit <span class="day-section-count">· ${timed.length}</span></div>`;
    html += timed.map(ev => renderEventCard(ev)).join('');
  }

  // Sektion 3: Todos
  if (todos.length > 0) {
    html += `<div class="day-section-label">Todos <span class="day-section-count">· ${todos.length}</span></div>`;
    html += todos.map(ev => renderTodoCard(ev, false)).join('');
  }

  // Empty state
  if (!holName && allDay.length === 0 && timed.length === 0 && todos.length === 0) {
    html = `<p style="text-align:center;color:var(--text-2);margin-top:32px;font-size:.95rem">Keine Termine an diesem Tag</p>`;
  }

  setHTML('day-list', html);
}

function openAddEventForCurrentDay() {
  openAddEvent('termin', fmt(state.currentDate));
}

// ════════════════════════════════════════════════════════════════
//  RENDER: EVENT CARD (for lists)
// ════════════════════════════════════════════════════════════════

function renderEventCard(ev, showDate = false) {
  const bg = getEventBg(ev);
  const members = (ev.memberIds || []).filter(id => id !== 'all');
  const memberChips = members.length > 0
    ? members.map(id => {
        const m = getMember(id);
        if (!m) return '';
        // Pt 19: photo avatar in chip
        return `<span class="member-chip" style="${m.photo?'background:transparent;':'background:'+m.color+';'}">${getMemberAvatar(m,'sm')}<span style="margin-left:3px">${m.name}</span></span>`;
      }).join('')
    : (ev.memberIds?.[0] === 'all'
      ? '<span class="member-chip" style="background:#4361ee">Alle</span>'
      : '');

  // Idee 1: privat — Ort und Notiz für andere ausblenden, Titel als „🔒 Privat"
  const hidden = isPrivateForOthers(ev);
  const locationDisp = displayLocation(ev);

  let meta = '';
  if (ev.endDate && ev.endDate !== ev.date) {
    meta += `${formatDisplayShort(ev.date)} – ${formatDisplayShort(ev.endDate)}`;
  } else if (showDate) {
    meta += formatDisplayShort(ev.date) + ' ';
  }
  if (ev.startTime) meta += ` ${ev.startTime}${ev.endTime ? ' – '+ev.endTime : ''}`;
  if (locationDisp) meta += (meta ? ' · ' : '') + `📍 ${locationDisp}`;
  if (ev.type === 'geburtstag') {
    const birthDateStr = ev._originalDate || ev.date;
    const displayYear  = ev._birthdayYear || new Date().getFullYear();
    const age = calcAge(birthDateStr, displayYear);
    if (age != null && age > 0) meta += ` · ${age} Jahre`;
  }
  // Pt 14: todo endDate
  if (ev.type === 'todo' && ev.endDate) {
    meta += (meta ? ' · ' : '') + `Bis: ${formatDisplayShort(ev.endDate)}`;
  }

  const icon = ev.type === 'geburtstag' ? '🎁 ' : '';
  // Eigener privater Termin: Schloss-Marker zusätzlich anzeigen
  const ownPrivIcon = (ev.privateMemberId && !hidden) ? '🔒 ' : '';
  const titleHtml = hidden ? '🔒 Privat' : (icon + ownPrivIcon + ev.title);

  return `<div class="event-card" onclick="App.openEventDetail('${ev.id}','${ev.date}')">
    <div class="event-card-bar" style="background:${bg}"></div>
    <div class="event-card-body">
      <div class="event-card-title">${titleHtml}</div>
      ${meta ? `<div class="event-card-meta">${meta.trim()}</div>` : ''}
      ${memberChips ? `<div class="event-card-members">${memberChips}</div>` : ''}
    </div>
  </div>`;
}

// ════════════════════════════════════════════════════════════════
//  RENDER: TODOS
// ════════════════════════════════════════════════════════════════

function renderTodos() {
  const filter = state.todoFilter;
  let todos = state.events.filter(e => e.type === 'todo');
  if (filter === 'offen')    todos = todos.filter(e => !e.completed);
  if (filter === 'erledigt') todos = todos.filter(e =>  e.completed);
  todos = todos.filter(matchesPersonFilter); // Pt 16

  todos.sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    const da = a.date || '9999';
    const db2 = b.date || '9999';
    return da.localeCompare(db2);
  });

  if (todos.length === 0) {
    setHTML('todo-list', `<p style="text-align:center;color:var(--text-2);margin-top:32px;font-size:.95rem">
      ${filter === 'offen' ? 'Keine offenen Todos 🎉' : 'Keine erledigten Todos'}
    </p>`);
    return;
  }

  setHTML('todo-list', todos.map(ev => renderTodoCard(ev)).join(''));
}

// Todo-Karte (mit Erledigt-Häkchen) — genutzt von renderTodos und renderDayView.
// showDate=false in der Tagesansicht, wo das Datum redundant ist.
function renderTodoCard(ev, showDate = true) {
  const members = (ev.memberIds || []).filter(id => id !== 'all');
  const memberChips = members.map(id => {
    const m = getMember(id);
    return m ? `<span class="member-chip" style="background:${m.color}">${getMemberAvatar(m,'sm')}<span style="margin-left:3px">${m.name}</span></span>` : '';
  }).join('');

  // Pt 14: show endDate in todo card
  let meta = '';
  if (showDate && ev.date) meta += formatDisplayShort(ev.date);
  if (ev.startTime) meta += (meta ? ' · ' : '') + ev.startTime + (ev.endTime ? '–' + ev.endTime : '');
  if (ev.endDate) meta += (meta ? ' · ' : '') + `Bis: ${formatDisplayShort(ev.endDate)}`;

  // Idee 1: Privat-Anzeige
  const hidden = isPrivateForOthers(ev);
  const ownPrivIcon = (ev.privateMemberId && !hidden) ? '🔒 ' : '';
  const titleHtml = hidden ? '🔒 Privat' : (ownPrivIcon + ev.title);

  return `<div class="event-card${ev.completed ? ' completed' : ''}">
    <div class="todo-check-wrap">
      <div class="todo-check${ev.completed ? ' done' : ''}" onclick="App.toggleTodo('${ev.id}',event)"></div>
    </div>
    <div class="event-card-body" onclick="App.openEventDetail('${ev.id}','${ev.date||today()}')">
      <div class="event-card-title">${titleHtml}</div>
      ${meta ? `<div class="event-card-meta">${meta}</div>` : ''}
      ${memberChips ? `<div class="event-card-members">${memberChips}</div>` : ''}
    </div>
  </div>`;
}

// ════════════════════════════════════════════════════════════════
//  RENDER: BIRTHDAYS
// ════════════════════════════════════════════════════════════════

function renderBirthdays() {
  const birthdays = state.events.filter(e => e.type === 'geburtstag');
  if (birthdays.length === 0) {
    setHTML('birthday-list', `<p style="text-align:center;color:var(--text-2);margin-top:32px;font-size:.95rem">Noch keine Geburtstage eingetragen</p>`);
    return;
  }

  const todayD = parseDate(today());
  const thisYear = todayD.getFullYear();

  // Pt 10: show ALL birthdays, sorted by next occurrence
  const sorted = birthdays.map(ev => {
    const base = parseDate(ev.date);
    let nextDate = new Date(thisYear, base.getMonth(), base.getDate());
    if (nextDate < todayD) nextDate = new Date(thisYear+1, base.getMonth(), base.getDate());
    const daysLeft = Math.round((nextDate - todayD) / 86400000);
    const age = calcAge(ev.date, nextDate.getFullYear());
    return { ...ev, nextDate: fmt(nextDate), daysLeft, age };
  }).sort((a,b) => a.daysLeft - b.daysLeft);

  setHTML('birthday-list', sorted.map(ev => {
    const members = (ev.memberIds || []).filter(id => id !== 'all');
    const firstMember = members.length > 0 ? getMember(members[0]) : null;

    // Pt 10.1: birthday color + 🎁 icon
    let avatarHtml;
    if (firstMember?.photo) {
      avatarHtml = `<div class="birthday-avatar" style="background:none;padding:0">${getMemberAvatar(firstMember,'lg')}</div>`;
    } else {
      const initial = ev.title ? ev.title[0].toUpperCase() : '?';
      avatarHtml = `<div class="birthday-avatar" style="background:${BIRTHDAY_COLOR}">${initial}</div>`;
    }

    const ageStr = ev.age ? ` · ${ev.age} Jahre` : '';
    const soonStr = ev.daysLeft <= 7
      ? `<span class="birthday-soon">${ev.daysLeft === 0 ? 'Heute! 🎉' : 'In '+ev.daysLeft+' Tagen'}</span>`
      : '';
    const daysBadge = ev.daysLeft === 0 ? '🎂' : ev.daysLeft+'d';

    return `<div class="birthday-card" onclick="App.openEventDetail('${ev.id}','${ev.date}')">
      ${avatarHtml}
      <div class="birthday-info">
        <div class="birthday-name">🎁 ${ev.title}${ageStr}</div>
        <div class="birthday-date">${formatBirthdayDate(ev.date)}</div>
        ${soonStr}
      </div>
      <div class="birthday-age" style="color:${BIRTHDAY_COLOR}">${daysBadge}</div>
    </div>`;
  }).join(''));
}

// ════════════════════════════════════════════════════════════════
//  RENDER: SETTINGS
// ════════════════════════════════════════════════════════════════

function renderSettings() {
  if (!state.family) return;

  // Pt 17: format code with hyphens
  const displayCode = formatCode(state.familyId);
  setHTML('family-code-display', displayCode);
  const pairingEl = document.getElementById('pairing-code-big');
  if (pairingEl) pairingEl.textContent = displayCode;

  setHTML('family-name-display', state.family.name || '');

  // Members — Pt 19: show photo
  const members = state.family.members || [];
  if (members.length === 0) {
    setHTML('members-list', '<p style="color:var(--text-2);font-size:.9rem">Noch keine Mitglieder</p>');
  } else {
    setHTML('members-list', members.map(m => `
      <div class="member-row">
        ${getMemberAvatar(m,'md')}
        <div class="member-name-text">${m.name}</div>
        <button class="member-edit-btn" onclick="App.openEditMember('${m.id}')">Bearbeiten</button>
      </div>
    `).join(''));
  }

  // Pt 7: Bundesland dropdown
  const blEl = document.getElementById('settings-bundesland');
  if (blEl) blEl.value = state.family.bundesland || '';

  // Pt 18: Night mode toggles
  renderNightModeSettings();
  // Pt 26: PIN settings
  renderPinSettings();
  // Phase 2: Geräte-Liste
  renderDevicesSettings();
  // Idee 2: Notifications-Status
  refreshPushStatus();
}

// ════════════════════════════════════════════════════════════════
//  Pt 7: SAVE BUNDESLAND
// ════════════════════════════════════════════════════════════════

async function saveBundesland() {
  const val = document.getElementById('settings-bundesland')?.value || '';
  try {
    await dbUpdateFamily({ bundesland: val });
    if (val) {
      const yr = new Date().getFullYear();
      fetchHolidays(yr);
      fetchHolidays(yr + 1);
    }
  } catch {}
}

// ════════════════════════════════════════════════════════════════
//  RENDER: ALL
// ════════════════════════════════════════════════════════════════

function renderCalendar() {
  if (state.currentTab !== 'kalender') return;
  renderHeaderTitle();
  if (state.currentView === 'monat') {
    renderMonthView();
    if (state.selectedDay) renderDayPanel(state.selectedDay); // Bug #3 fix
  } else if (state.currentView === 'woche') {
    renderWeekView();
  } else {
    renderDayView();
  }
}

function renderAll() {
  renderCalendar();
  renderTodos();
  renderBirthdays();
  renderSettings();
  renderPersonFilter(); // Pt 16
}

// ════════════════════════════════════════════════════════════════
//  Pt 11: SEARCH
// ════════════════════════════════════════════════════════════════

function toggleSearch() {
  state.searchActive = !state.searchActive;
  const bar = document.getElementById('search-bar');
  const inp = document.getElementById('search-input');
  if (!bar) return;
  if (state.searchActive) {
    bar.classList.remove('hidden');
    setTimeout(() => inp?.focus(), 100);
  } else {
    bar.classList.add('hidden');
    state.searchQuery = '';
    if (inp) inp.value = '';
    hideEl('search-results');
  }
}

function onSearchInput(val) {
  state.searchQuery = val;
  if (!val.trim()) {
    hideEl('search-results');
    return;
  }
  const q = val.toLowerCase();
  // Idee 1: Suche matcht nur eigene private Termine — fremde Klartexte werden ignoriert.
  const results = state.events.filter(e => {
    if (isPrivateForOthers(e)) return false;
    return (e.title || '').toLowerCase().includes(q) ||
           (e.description || '').toLowerCase().includes(q) ||
           (e.location || '').toLowerCase().includes(q);
  }).slice(0, 20);

  const el = document.getElementById('search-results');
  if (!el) return;
  if (results.length === 0) {
    el.innerHTML = '<p style="padding:16px;color:var(--text-2);font-size:.9rem;text-align:center">Keine Ergebnisse</p>';
  } else {
    el.innerHTML = results.map(ev => renderEventCard(ev, true)).join('');
  }
  el.classList.remove('hidden');
}

// ════════════════════════════════════════════════════════════════
//  BOTTOM SHEETS
// ════════════════════════════════════════════════════════════════

function openSheet(id) {
  showEl('overlay-backdrop');
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('hidden');
  requestAnimationFrame(() => el.classList.add('open'));
  document.body.style.overflow = 'hidden';
}

function closeSheet(id) {
  const el = document.getElementById(id);
  if (!el) return;
  // Phase 2: Kamera-Stream sicher stoppen, falls das Add-Device-Sheet schließt
  if (id === 'sheet-add-device' && typeof stopScanner === 'function') stopScanner();
  el.classList.remove('open');
  el.addEventListener('transitionend', () => el.classList.add('hidden'), { once: true });
  const anyOpen = document.querySelectorAll('.bottom-sheet.open').length > 0;
  if (!anyOpen) {
    hideEl('overlay-backdrop');
    document.body.style.overflow = '';
  }
}

function closeAllSheets() {
  if (typeof stopScanner === 'function') stopScanner();
  document.querySelectorAll('.bottom-sheet.open').forEach(el => {
    el.classList.remove('open');
    el.addEventListener('transitionend', () => el.classList.add('hidden'), { once: true });
  });
  hideEl('overlay-backdrop');
  document.body.style.overflow = '';
}

// ════════════════════════════════════════════════════════════════
//  MEMBER FORM — Pt 19: photo upload
// ════════════════════════════════════════════════════════════════

let selectedColor = MEMBER_COLORS[0];
let currentMemberPhoto = null; // null = unchanged, '' = removed, base64 = new photo

function openAddMember() {
  state.editingMemberId = null;
  currentMemberPhoto = null;
  document.getElementById('sheet-member-title').textContent = 'Mitglied hinzufügen';
  document.getElementById('member-name').value = '';
  selectedColor = MEMBER_COLORS[0];
  renderColorPicker();
  updateMemberPhotoPreview(null);
  document.getElementById('member-lastseen-group')?.classList.add('hidden');
  hideError('member-form-error');
  openSheet('sheet-member');
}

function openEditMember(id) {
  const m = getMember(id);
  if (!m) return;
  state.editingMemberId = id;
  currentMemberPhoto = m.photo || null;
  document.getElementById('sheet-member-title').textContent = 'Mitglied bearbeiten';
  document.getElementById('member-name').value = m.name;
  selectedColor = m.color;
  renderColorPicker();
  updateMemberPhotoPreview(m.photo || null);
  renderMemberLastSeen(id);
  hideError('member-form-error');
  openSheet('sheet-member');
}

function renderMemberLastSeen(memberId) {
  const group = document.getElementById('member-lastseen-group');
  const list  = document.getElementById('member-lastseen-list');
  if (!group || !list) return;
  group.classList.remove('hidden');

  const map      = state.family?.uidToMember || {};
  const lastSeen = state.family?.lastSeen    || {};
  const uids = Object.keys(map).filter(uid => map[uid] === memberId);

  if (uids.length === 0) {
    list.innerHTML = `<div style="color:var(--text-muted);font-size:.9rem">Kein Gerät verknüpft</div>`;
    return;
  }

  // Neueste zuerst (UIDs ohne lastSeen ans Ende)
  uids.sort((a, b) => {
    const ta = lastSeen[a]?.toMillis ? lastSeen[a].toMillis() : 0;
    const tb = lastSeen[b]?.toMillis ? lastSeen[b].toMillis() : 0;
    return tb - ta;
  });

  list.innerHTML = uids.map(uid => {
    const isMe   = (uid === state.uid);
    const when   = formatLastSeen(lastSeen[uid]);
    const meTag  = isMe ? ' · <span style="color:var(--accent)">Dieses Gerät</span>' : '';
    return `
      <div style="padding:8px 0;border-bottom:1px solid var(--border)">
        <div style="font-size:.95rem">${when}</div>
        <div style="font-size:.8rem;color:var(--text-muted);font-family:monospace">${uid.slice(0,8)}…${meTag}</div>
      </div>
    `;
  }).join('');
}

function renderColorPicker() {
  const html = MEMBER_COLORS.map(c =>
    `<div class="color-swatch${c === selectedColor ? ' selected' : ''}"
          style="background:${c}"
          onclick="App.selectColor('${c}')"></div>`
  ).join('');
  setHTML('member-color-picker', html);
}

function selectColor(color) {
  selectedColor = color;
  renderColorPicker();
}

function updateMemberPhotoPreview(src) {
  const wrap = document.getElementById('member-photo-preview-wrap');
  const img  = document.getElementById('member-photo-preview');
  if (!wrap || !img) return;
  if (src) {
    img.src = src;
    wrap.classList.remove('hidden');
  } else {
    img.src = '';
    wrap.classList.add('hidden');
  }
}

function handleMemberPhotoInput(evt) {
  const file = evt.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const imgEl = new Image();
    imgEl.onload = () => {
      const canvas = document.createElement('canvas');
      const MAX = 150;
      const size = Math.min(imgEl.width, imgEl.height);
      const sx = (imgEl.width - size) / 2;
      const sy = (imgEl.height - size) / 2;
      canvas.width = MAX; canvas.height = MAX;
      canvas.getContext('2d').drawImage(imgEl, sx, sy, size, size, 0, 0, MAX, MAX);
      currentMemberPhoto = canvas.toDataURL('image/jpeg', 0.7);
      updateMemberPhotoPreview(currentMemberPhoto);
    };
    imgEl.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function removeMemberPhoto() {
  currentMemberPhoto = '';
  updateMemberPhotoPreview(null);
  const inp = document.getElementById('member-photo-input');
  if (inp) inp.value = '';
}

async function saveMember() {
  const name = document.getElementById('member-name').value.trim();
  if (!name) { showError('member-form-error', 'Bitte Namen eingeben'); return; }

  const btn = document.getElementById('btn-save-member');
  if (btn) { btn.textContent = 'Speichert…'; btn.disabled = true; }

  try {
    const members = [...(state.family.members || [])];
    if (state.editingMemberId) {
      const idx = members.findIndex(m => m.id === state.editingMemberId);
      if (idx >= 0) {
        members[idx] = { ...members[idx], name, color: selectedColor };
        if (currentMemberPhoto !== null) {
          if (currentMemberPhoto === '') {
            delete members[idx].photo;
          } else if (currentMemberPhoto.startsWith('data:')) {
            members[idx].photo = currentMemberPhoto;
          }
        }
      }
    } else {
      const memberId = genId();
      const newMember = { id: memberId, name, color: selectedColor };
      if (currentMemberPhoto?.startsWith('data:')) {
        newMember.photo = currentMemberPhoto;
      }
      members.push(newMember);
    }
    await commitWrite(dbUpdateFamily({ members }));
    closeSheet('sheet-member');
  } catch (e) {
    showError('member-form-error', 'Fehler beim Speichern: ' + e.message);
  } finally {
    if (btn) { btn.textContent = 'Speichern'; btn.disabled = false; }
  }
}

// ════════════════════════════════════════════════════════════════
//  EVENT FORM
// ════════════════════════════════════════════════════════════════

let currentEventType = 'termin';

// Pt 8: prefillTime parameter added
function openAddEvent(type = 'termin', prefillDate = null, prefillTime = null) {
  state.editingEventId = null;
  currentEventType = type;

  // In der Tagesansicht ohne explizites Datum: ausgewählten Tag vorbelegen (nicht "heute").
  // Betrifft den oberen "+"-Button; Monats-/Wochenansicht bleiben auf today().
  if (!prefillDate && state.currentView === 'tag') prefillDate = fmt(state.currentDate);

  document.getElementById('sheet-event-title').textContent =
    type === 'todo' ? 'Todo hinzufügen' :
    type === 'geburtstag' ? 'Geburtstag hinzufügen' : 'Termin hinzufügen';

  document.getElementById('event-title').value = '';
  document.getElementById('event-date').value = prefillDate || today();
  const endDateEl = document.getElementById('event-end-date');
  if (endDateEl) endDateEl.value = ''; // Bug 23 fix: always reset
  document.getElementById('event-has-time').checked = false;
  document.getElementById('event-time').value = '';
  document.getElementById('event-end-time').value = '';
  document.getElementById('event-location').value = '';
  document.getElementById('event-recurring').value = 'none';
  document.getElementById('event-description').value = '';
  document.getElementById('event-birthday-person').value = '';
  // Idee 1: Privat-Checkbox zurücksetzen
  const privChk0 = document.getElementById('event-private');
  if (privChk0) privChk0.checked = false;
  document.getElementById('recurring-interval').value = '1';
  document.getElementById('recurring-end-type').value = 'never';
  // Pt 6: reset no-year checkbox
  const noYearChk = document.getElementById('event-no-year');
  if (noYearChk) noYearChk.checked = false;
  hideEl('time-inputs');
  hideEl('recurring-options');
  hideEl('recurring-end-date-wrap');
  hideEl('recurring-end-count-wrap');
  hideError('event-form-error');

  // Pt 8: prefill time if provided
  if (prefillTime) {
    document.getElementById('event-has-time').checked = true;
    showEl('time-inputs');
    document.getElementById('event-time').value = prefillTime;
  }

  document.querySelectorAll('.type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === type));
  applyEventTypeUI(type);
  renderMembersSelector([]);
  applyPrivateLock(false);
  renderReminders([]);

  if (prefillDate) {
    const d = parseDate(prefillDate);
    const dow = (d.getDay() + 6) % 7 + 1;
    document.querySelectorAll('.wday-btn').forEach(b => {
      const bDay = parseInt(b.dataset.day);
      b.classList.toggle('selected', bDay === (dow === 7 ? 0 : dow));
    });
  }

  openSheet('sheet-event');
}

function openEditEvent(eventId, dateStr) {
  const ev = state.events.find(e => e.id === eventId);
  if (!ev) return;
  state.editingEventId = eventId;
  currentEventType = ev.type;

  document.getElementById('sheet-event-title').textContent =
    ev.type === 'todo' ? 'Todo bearbeiten' :
    ev.type === 'geburtstag' ? 'Geburtstag bearbeiten' : 'Termin bearbeiten';

  document.getElementById('event-title').value = ev.title || '';
  document.getElementById('event-date').value = ev.date || today();

  // Bug 15/23 fix: always load endDate from the specific event being edited
  const endDateEl2 = document.getElementById('event-end-date');
  if (endDateEl2) endDateEl2.value = (ev.type !== 'geburtstag' ? ev.endDate || '' : '');

  document.getElementById('event-location').value = ev.location || '';
  document.getElementById('event-description').value = ev.description || '';
  document.getElementById('event-birthday-person').value = ev.birthdayPerson || '';
  // Idee 1: Privat-Checkbox setzen wenn der Termin als privat markiert ist
  const privChk = document.getElementById('event-private');
  if (privChk) privChk.checked = !!ev.privateMemberId;

  // Pt 6: no-year checkbox
  const noYearChk = document.getElementById('event-no-year');
  if (noYearChk) {
    const base = parseDate(ev.date);
    noYearChk.checked = base && base.getFullYear() <= 1900;
  }

  const hasTime = !!ev.startTime;
  document.getElementById('event-has-time').checked = hasTime;
  if (hasTime) {
    showEl('time-inputs');
    document.getElementById('event-time').value = ev.startTime || '';
    document.getElementById('event-end-time').value = ev.endTime || '';
  } else {
    hideEl('time-inputs');
  }

  const rec = ev.recurring;
  if (rec && rec.type !== 'none') {
    document.getElementById('event-recurring').value = rec.type;
    document.getElementById('recurring-interval').value = rec.interval || 1;
    showEl('recurring-options');
    updateRecurringUnitLabel(rec.type);
    if (rec.endDate) {
      document.getElementById('recurring-end-type').value = 'date';
      document.getElementById('recurring-end-date').value = rec.endDate;
      showEl('recurring-end-date-wrap');
    } else if (rec.count) {
      document.getElementById('recurring-end-type').value = 'count';
      document.getElementById('recurring-count').value = rec.count;
      showEl('recurring-end-count-wrap');
    } else {
      document.getElementById('recurring-end-type').value = 'never';
    }
    if (rec.type === 'weekly') {
      showEl('recurring-weekdays');
      const days = new Set(rec.daysOfWeek || []);
      document.querySelectorAll('.wday-btn').forEach(b => {
        b.classList.toggle('selected', days.has(parseInt(b.dataset.day)));
      });
    }
  } else {
    document.getElementById('event-recurring').value = 'none';
    hideEl('recurring-options');
  }

  document.querySelectorAll('.type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === ev.type));
  applyEventTypeUI(ev.type);
  renderMembersSelector(ev.memberIds || []);
  applyPrivateLock(!!ev.privateMemberId);
  renderReminders(ev.reminders || []);
  hideError('event-form-error');
  openSheet('sheet-event');
}

function applyEventTypeUI(type) {
  currentEventType = type;
  const isBirthday = type === 'geburtstag';
  const isTodo     = type === 'todo';

  hideEl('birthday-person-group');
  const titleInput = document.getElementById('event-title');
  if (titleInput) {
    titleInput.placeholder = isBirthday ? 'Name der Person' : (isTodo ? 'Aufgabe' : 'Titel');
  }
  document.getElementById('time-group').classList.toggle('hidden', isBirthday);
  document.getElementById('location-group').classList.toggle('hidden', isBirthday || isTodo);
  document.getElementById('recurring-group').classList.toggle('hidden', isBirthday);
  document.getElementById('event-type-group').classList.toggle('hidden', !!state.editingEventId);

  // Pt 10.2: hide endDate for birthdays; preserve value across type switches
  const edg = document.getElementById('end-date-group');
  if (edg) {
    const endInp = document.getElementById('event-end-date');
    const savedEnd = endInp ? endInp.value : '';
    edg.classList.toggle('hidden', isBirthday);
    if (endInp && savedEnd) endInp.value = savedEnd;
  }

  // Pt 6: show no-year checkbox only for birthdays
  const noYearGroup = document.getElementById('no-year-group');
  if (noYearGroup) noYearGroup.classList.toggle('hidden', !isBirthday);

  // Idee 1: Privat-Checkbox nur für Termine und Todos sichtbar — UND nur wenn
  // dieses Gerät einer Person zugeordnet ist (sonst gibt's keinen Owner zum Setzen).
  const privGroup = document.getElementById('event-private-group');
  if (privGroup) {
    const allowed = !isBirthday && !!getCurrentMemberId();
    privGroup.classList.toggle('hidden', !allowed);
    if (!allowed) {
      const privChk2 = document.getElementById('event-private');
      if (privChk2) privChk2.checked = false;
      applyPrivateLock(false);
    }
  }
}

function setEventType(type) {
  currentEventType = type;
  document.querySelectorAll('.type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === type));
  applyEventTypeUI(type);
}

function toggleTime() {
  const checked = document.getElementById('event-has-time').checked;
  document.getElementById('time-inputs').classList.toggle('hidden', !checked);
}

function toggleRecurringOptions() {
  const val = document.getElementById('event-recurring').value;
  document.getElementById('recurring-options').classList.toggle('hidden', val === 'none');
  if (val !== 'none') updateRecurringUnitLabel(val);
  document.getElementById('recurring-weekdays').classList.toggle('hidden', val !== 'weekly');
}

function updateRecurringUnitLabel(type) {
  const units = { daily:'Tage', weekly:'Wochen', monthly:'Monate', yearly:'Jahre' };
  const el = document.getElementById('recurring-unit-label');
  if (el) el.textContent = units[type] || '';
}

function toggleRecurringEnd() {
  const val = document.getElementById('recurring-end-type').value;
  document.getElementById('recurring-end-date-wrap').classList.toggle('hidden', val !== 'date');
  document.getElementById('recurring-end-count-wrap').classList.toggle('hidden', val !== 'count');
}

function renderMembersSelector(selectedIds) {
  const members = state.family?.members || [];
  const isAll = selectedIds.length === 0 || selectedIds[0] === 'all';
  let html = '';

  html += `<div class="member-select-row" onclick="App.toggleAllMembers()">
    <div class="member-select-check${isAll ? ' checked' : ''}" id="check-all"></div>
    <div class="member-select-dot" style="background:#4361ee">A</div>
    <div class="member-select-name">Alle</div>
  </div>`;

  for (const m of members) {
    const sel = !isAll && selectedIds.includes(m.id);
    html += `<div class="member-select-row" onclick="App.toggleMember('${m.id}')">
      <div class="member-select-check${sel ? ' checked' : ''}" id="check-${m.id}"></div>
      ${getMemberAvatar(m,'sm')}
      <div class="member-select-dot" style="background:${m.color}">${initials(m.name)}</div>
      <div class="member-select-name">${m.name}</div>
    </div>`;
  }
  setHTML('event-members-selector', html);
}

function getSelectedMemberIds() {
  const allCheck = document.getElementById('check-all');
  if (allCheck && allCheck.classList.contains('checked')) return ['all'];
  const members = state.family?.members || [];
  return members.filter(m => {
    const el = document.getElementById(`check-${m.id}`);
    return el && el.classList.contains('checked');
  }).map(m => m.id);
}

function toggleAllMembers() {
  const allCheck = document.getElementById('check-all');
  if (!allCheck) return;
  const wasAll = allCheck.classList.contains('checked');
  if (!wasAll) {
    allCheck.classList.add('checked');
    (state.family?.members || []).forEach(m => {
      const el = document.getElementById(`check-${m.id}`);
      if (el) el.classList.remove('checked');
    });
  }
}

function toggleMember(id) {
  const el = document.getElementById(`check-${id}`);
  if (!el) return;
  const allCheck = document.getElementById('check-all');
  if (allCheck) allCheck.classList.remove('checked');
  el.classList.toggle('checked');
  const anySelected = (state.family?.members || []).some(m => {
    const c = document.getElementById(`check-${m.id}`);
    return c && c.classList.contains('checked');
  });
  if (!anySelected && allCheck) allCheck.classList.add('checked');
}

// Bugfix: bei aktiver Privat-Checkbox wird die Personen-Auswahl auf den
// aktiven User gezwungen; alle anderen Reihen werden ausgegraut/blockiert.
// Beim Deaktivieren wird die Sperre wieder gelöst (Auswahl bleibt stehen).
function applyPrivateLock(locked) {
  const selector = document.getElementById('event-members-selector');
  if (!selector) return;
  const allRow = selector.querySelector('.member-select-row');
  const memberRows = selector.querySelectorAll('.member-select-row');

  if (locked) {
    const myId = getCurrentMemberId();
    if (!myId) return; // kein Owner zum Setzen → still no-op
    const allCheck = document.getElementById('check-all');
    if (allCheck) allCheck.classList.remove('checked');
    (state.family?.members || []).forEach(m => {
      const c = document.getElementById(`check-${m.id}`);
      if (c) c.classList.toggle('checked', m.id === myId);
    });
    memberRows.forEach(row => {
      const isMine = row.getAttribute('onclick') === `App.toggleMember('${myId}')`;
      row.classList.toggle('disabled', !isMine);
    });
  } else {
    memberRows.forEach(row => row.classList.remove('disabled'));
  }
}

function onPrivateToggle() {
  const chk = document.getElementById('event-private');
  applyPrivateLock(!!(chk && chk.checked));
}

async function saveEvent() {
  const title = document.getElementById('event-title').value.trim();
  if (!title) { showError('event-form-error', 'Bitte Titel eingeben'); return; }

  const dateVal = document.getElementById('event-date').value;
  if (!dateVal) { showError('event-form-error', 'Bitte Datum wählen'); return; }

  const hasTime  = document.getElementById('event-has-time').checked;
  const startTime= hasTime ? document.getElementById('event-time').value || null : null;
  const endTime  = hasTime ? document.getElementById('event-end-time').value || null : null;
  const location = document.getElementById('event-location').value.trim() || null;
  const desc     = document.getElementById('event-description').value.trim() || null;
  const memberIds= getSelectedMemberIds();

  const recType = (currentEventType !== 'geburtstag')
    ? document.getElementById('event-recurring').value : 'none';
  let recurring = null;
  if (recType !== 'none') {
    const interval = parseInt(document.getElementById('recurring-interval').value) || 1;
    const endType  = document.getElementById('recurring-end-type').value;
    recurring = { type: recType, interval };
    if (recType === 'weekly') {
      const days = [];
      document.querySelectorAll('.wday-btn.selected').forEach(b => days.push(parseInt(b.dataset.day)));
      if (days.length > 0) recurring.daysOfWeek = days;
    }
    if (endType === 'date') {
      const ed = document.getElementById('recurring-end-date').value;
      if (ed) recurring.endDate = ed;
    } else if (endType === 'count') {
      recurring.count = parseInt(document.getElementById('recurring-count').value) || 10;
    }
  }

  // Bug 23 fix: endDate default is empty → null
  const endDateVal = document.getElementById('event-end-date')?.value || null;

  let finalDate = dateVal;
  // Pt 6: no-year birthday handling
  if (currentEventType === 'geburtstag') {
    const noYear = document.getElementById('event-no-year')?.checked;
    if (noYear && dateVal) {
      finalDate = `1900-${dateVal.substring(5)}`;
    }
  }

  // Idee 1: privateMemberId setzen, wenn Privat-Checkbox aktiv ist und das Gerät
  // einer Person zugeordnet ist. Für Geburtstage bleibt privateMemberId immer null.
  let privateMemberId = null;
  const privChkSave = document.getElementById('event-private');
  if (currentEventType !== 'geburtstag' && privChkSave?.checked) {
    privateMemberId = getCurrentMemberId();
  }
  // Beim Edit: wenn ein bestehender privater Eintrag von jemand anders geöffnet wurde
  // (defensive — der Button wird unten ausgeblendet), den ursprünglichen Owner respektieren.
  if (state.editingEventId) {
    const existing = state.events.find(e => e.id === state.editingEventId);
    if (existing?.privateMemberId && existing.privateMemberId !== getCurrentMemberId()) {
      // Fremder privater Termin → wir hätten gar nicht hier sein dürfen.
      showError('event-form-error', 'Fremde private Termine können nicht geändert werden.');
      return;
    }
    // Wenn Checkbox aus, aber bestehend privat: User entfernt die Privat-Markierung — OK.
  }

  const data = {
    type: currentEventType,
    title,
    date: finalDate,
    endDate: (currentEventType !== 'geburtstag' && endDateVal && endDateVal > finalDate) ? endDateVal : null,
    startTime: startTime || null,
    endTime: endTime || null,
    location,
    description: desc,
    memberIds,
    recurring: recurring || { type: 'none' },
    completed: false,
    privateMemberId,
    reminders: collectRemindersFromForm(),
  };

  if (currentEventType === 'geburtstag') {
    data.recurring = { type: 'yearly', interval: 1 };
    data.endDate = null; // Pt 10.2
    data.privateMemberId = null;
  }

  if (state.editingEventId) data.id = state.editingEventId;

  const btn = document.getElementById('btn-save-event');
  if (btn) { btn.textContent = 'Speichert…'; btn.disabled = true; }
  try {
    if (state.editingEventId) {
      const existing = state.events.find(e => e.id === state.editingEventId);
      if (existing?.recurring?.type && existing.recurring.type !== 'none') {
        state.editingEventData = data;
        state.recurringAction = 'edit';
        document.getElementById('recurring-action-title').textContent = 'Serientermin bearbeiten';
        document.getElementById('recurring-action-question').textContent = 'Welche Termine sollen geändert werden?';
        closeSheet('sheet-event');
        openSheet('sheet-recurring-action');
        return;
      }
    }
    await commitWrite(dbSaveEvent(data));
    closeSheet('sheet-event');
  } catch (e) {
    showError('event-form-error', 'Fehler: ' + e.message);
  } finally {
    if (btn) { btn.textContent = 'Speichern'; btn.disabled = false; }
  }
}

// ════════════════════════════════════════════════════════════════
//  EVENT DETAIL — Pt 25.a+b: vollständige Detailansicht
// ════════════════════════════════════════════════════════════════

let detailEventId = null;
let detailEventDate = null;

function openEventDetail(id, dateStr) {
  const ev = state.events.find(e => e.id === id);
  if (!ev) return;

  detailEventId = id;
  detailEventDate = dateStr || ev.date;

  const typeLabels = { termin:'Termin', todo:'Todo', geburtstag:'Geburtstag' };
  document.getElementById('detail-sheet-title').textContent = typeLabels[ev.type] || 'Termin';

  const bg = getEventBg(ev);
  const icon = ev.type === 'geburtstag' ? '🎁 ' : '';
  // Idee 1: Edit/Delete-Buttons im Header ausblenden, wenn Termin fremd-privat ist
  const editable = canEditEvent(ev);
  const editBtn  = document.querySelector('#sheet-event-detail .hdr-actions');
  if (editBtn) editBtn.style.visibility = editable ? '' : 'hidden';

  const hidden = isPrivateForOthers(ev);
  const ownPrivIcon = (ev.privateMemberId && !hidden) ? '🔒 ' : '';
  const titleDisp = hidden ? '🔒 Privat' : `${icon}${ownPrivIcon}${ev.title}`;
  let html = `<div class="detail-color-bar" style="background:${bg}"></div>`;
  html += `<div class="detail-title">${titleDisp}</div>`;

  // Date row
  const dateRangeLabel = (ev.endDate && ev.endDate !== ev.date)
    ? `${formatDisplay(ev.date)} – ${formatDisplay(ev.endDate)}`
    : formatDisplay(detailEventDate);
  html += `<div class="detail-meta-row">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
    ${dateRangeLabel}
  </div>`;

  // Pt 25.a: birthday age + note
  if (ev.type === 'geburtstag') {
    const birthDateStr = ev._originalDate || ev.date;
    const thisYear = new Date().getFullYear();
    const age = calcAge(ev.date, thisYear);
    if (age != null && age > 0) {
      html += `<div class="detail-meta-row">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M6 20v-2a6 6 0 0 1 12 0v2"/></svg>
        Wird ${age} Jahre
      </div>`;
    }
    if (ev.description) {
      html += `<div class="detail-meta-row">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        ${ev.description}
      </div>`;
    }
  }

  // Time
  if (ev.startTime) {
    html += `<div class="detail-meta-row">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      ${ev.startTime}${ev.endTime ? ' – ' + ev.endTime : ''}
    </div>`;
  }

  // Pt 25.b: todo endDate
  if (ev.type === 'todo' && ev.endDate) {
    html += `<div class="detail-meta-row">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="14" x2="16" y2="14"/></svg>
      Fällig: ${formatDisplay(ev.endDate)}
    </div>`;
  }

  // Location (Idee 1: bei fremd-privat ausblenden)
  const locDisp = displayLocation(ev);
  if (locDisp) {
    html += `<div class="detail-meta-row">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
      ${locDisp}
    </div>`;
  }

  // Recurring
  if (ev.recurring && ev.recurring.type !== 'none') {
    html += `<div class="detail-meta-row">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-6.59"/></svg>
      ${formatRecurringLabel(ev.recurring)}
    </div>`;
  }

  // Members
  const members = (ev.memberIds || []);
  if (members.length > 0) {
    const chips = members[0] === 'all'
      ? '<span class="member-chip" style="background:#4361ee">Alle</span>'
      : members.map(mid => {
          const m = getMember(mid);
          return m ? `<span class="member-chip" style="background:${m.color}">${getMemberAvatar(m,'sm')}<span style="margin-left:4px">${m.name}</span></span>` : '';
        }).join('');
    html += `<div class="detail-members-section">
      <div class="detail-members-label">Personen</div>
      <div class="event-card-members">${chips}</div>
    </div>`;
  }

  // Pt 25.b: todo/termin description/note (Idee 1: bei fremd-privat ausblenden)
  const descDisp2 = displayDescription(ev);
  if (descDisp2 && ev.type !== 'geburtstag') {
    html += `<div style="margin-top:14px;padding:12px;background:var(--bg);border-radius:8px;font-size:.9rem;color:var(--text-2);white-space:pre-wrap">${descDisp2}</div>`;
  }

  // Todo status
  if (ev.type === 'todo') {
    html += `<div style="margin-top:14px">
      <button style="display:flex;align-items:center;gap:8px;color:${ev.completed?'var(--success)':'var(--text-2)'};font-size:.95rem;padding:10px;background:var(--bg);border-radius:8px;width:100%"
              onclick="App.toggleTodoFromDetail('${ev.id}')">
        <span>${ev.completed ? '✅ Erledigt' : '○ Als erledigt markieren'}</span>
      </button>
    </div>`;
  }

  html += '<div class="sheet-spacer"></div>';
  setHTML('event-detail-body', html);
  openSheet('sheet-event-detail');
}

function editCurrentEvent() {
  if (!detailEventId) return;
  const ev = state.events.find(e => e.id === detailEventId);
  // Idee 1: defensiver Edit-Schutz für fremde private Termine
  if (ev && !canEditEvent(ev)) {
    alert('Dieser Termin ist privat — nur der Ersteller kann ihn ändern.');
    return;
  }
  closeSheet('sheet-event-detail');
  setTimeout(() => openEditEvent(detailEventId, detailEventDate), 350);
}

function deleteCurrentEvent() {
  if (!detailEventId) return;
  const ev = state.events.find(e => e.id === detailEventId);
  if (!ev) return;
  // Idee 1: defensiver Delete-Schutz
  if (!canEditEvent(ev)) {
    alert('Dieser Termin ist privat — nur der Ersteller kann ihn löschen.');
    return;
  }

  if (ev.recurring && ev.recurring.type !== 'none') {
    // Idee 3: Wiederkehrende Todos haben keinen one/following/all-Scope —
    // Löschen beendet die Kette komplett. Termine zeigen weiterhin das Sheet.
    if (ev.type === 'todo') {
      if (confirm(`Wiederkehrendes Todo "${displayTitle(ev)}" komplett löschen?`)) {
        commitWrite(dbDeleteEvent(detailEventId)).then(() => closeSheet('sheet-event-detail'));
      }
      return;
    }
    state.editingEventData = { id: detailEventId, date: detailEventDate };
    state.recurringAction = 'delete';
    document.getElementById('recurring-action-title').textContent = 'Serientermin löschen';
    document.getElementById('recurring-action-question').textContent = 'Welche Termine sollen gelöscht werden?';
    closeSheet('sheet-event-detail');
    openSheet('sheet-recurring-action');
    return;
  }

  if (confirm(`"${displayTitle(ev)}" löschen?`)) {
    commitWrite(dbDeleteEvent(detailEventId)).then(() => closeSheet('sheet-event-detail'));
  }
}

async function applyRecurringAction(scope) {
  closeSheet('sheet-recurring-action');
  const action = state.recurringAction;
  const evId = state.editingEventData?.id || state.editingEventId;
  const ev = state.events.find(e => e.id === evId);
  if (!ev) return;

  if (action === 'delete') {
    const instanceDate = state.editingEventData?.date;
    if (scope === 'one') {
      await commitWrite(dbAddException(evId, instanceDate));
    } else if (scope === 'following') {
      const endDate = fmt(addDays(parseDate(instanceDate), -1));
      await commitWrite(db.collection('families').doc(state.familyId).collection('events').doc(evId)
        .update({ 'recurring.endDate': endDate }));
    } else {
      await commitWrite(dbDeleteEvent(evId));
    }
  } else if (action === 'edit') {
    const newData = state.editingEventData;
    if (scope === 'all') {
      await commitWrite(dbSaveEvent(newData));
    } else if (scope === 'one') {
      await commitWrite(dbAddException(evId, newData.date));
      const { id: _, ...rest } = newData;
      rest.recurring = { type: 'none' };
      await commitWrite(dbSaveEvent(rest));
    } else {
      const endDate = fmt(addDays(parseDate(newData.date), -1));
      await commitWrite(db.collection('families').doc(state.familyId).collection('events').doc(evId)
        .update({ 'recurring.endDate': endDate }));
      const { id: _, ...rest } = newData;
      await commitWrite(dbSaveEvent(rest));
    }
  }

  state.recurringAction = null;
  state.editingEventData = null;
}

// Idee 3: Recurring-Todo erledigen — Original wandert, erledigte Instanz als Standalone-Doc.
async function advanceRecurringTodo(ev) {
  const nextDate = nextRecurringDate(ev);

  if (!nextDate) {
    // Letzte Instanz der Kette — nur completed markieren, kein Doc-Splitting.
    return commitWrite(db.collection('families').doc(state.familyId).collection('events')
      .doc(ev.id).update({
        completed: true,
        completedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }));
  }

  // 1) Standalone-Erledigt-Doc anlegen (Kopie ohne Recurring-Bindung)
  const { id: _id, ...rest } = ev;
  const completedDoc = {
    ...rest,
    date: ev.date,
    recurring: { type: 'none' },
    completed: true,
    completedAt: firebase.firestore.FieldValue.serverTimestamp(),
  };
  // exceptions des Originals nicht mit kopieren — gehören zur Kette, nicht zur Einzelinstanz
  delete completedDoc.recurring.exceptions;

  // 2) Original-Doc auf die nächste Instanz weiterschieben
  const update = { date: nextDate };
  if (ev.endDate) {
    const oldStart = parseDate(ev.date);
    const oldEnd = parseDate(ev.endDate);
    const diffDays = Math.round((oldEnd - oldStart) / 86400000);
    update.endDate = fmt(addDays(parseDate(nextDate), diffDays));
  }
  if (ev.recurring && ev.recurring.count != null) {
    update['recurring.count'] = Math.max(0, ev.recurring.count - 1);
  }

  await commitWrite(dbSaveEvent(completedDoc));
  await commitWrite(db.collection('families').doc(state.familyId).collection('events')
    .doc(ev.id).update(update));
}

async function toggleTodo(id, e) {
  if (e) e.stopPropagation();
  const ev = state.events.find(e2 => e2.id === id);
  if (!ev) return;
  // Idee 1: fremd-private Todos darf niemand außer dem Ersteller togglen
  if (!canEditEvent(ev)) return;

  const isRecurringActive = ev.type === 'todo' && !ev.completed
    && ev.recurring && ev.recurring.type !== 'none';
  if (isRecurringActive) {
    return advanceRecurringTodo(ev);
  }

  const update = ev.completed
    ? { completed: false, completedAt: firebase.firestore.FieldValue.delete() }
    : { completed: true,  completedAt: firebase.firestore.FieldValue.serverTimestamp() };
  await commitWrite(db.collection('families').doc(state.familyId).collection('events')
    .doc(id).update(update));
}

async function toggleTodoFromDetail(id) {
  const ev = state.events.find(e => e.id === id);
  if (!ev) return;
  if (!canEditEvent(ev)) return;

  const isRecurringActive = ev.type === 'todo' && !ev.completed
    && ev.recurring && ev.recurring.type !== 'none';
  if (isRecurringActive) {
    await advanceRecurringTodo(ev);
    closeSheet('sheet-event-detail');
    return;
  }

  const update = ev.completed
    ? { completed: false, completedAt: firebase.firestore.FieldValue.delete() }
    : { completed: true,  completedAt: firebase.firestore.FieldValue.serverTimestamp() };
  await commitWrite(db.collection('families').doc(state.familyId).collection('events')
    .doc(id).update(update));
  closeSheet('sheet-event-detail');
}

// ════════════════════════════════════════════════════════════════
//  Pt 9: ICAL IMPORT
// ════════════════════════════════════════════════════════════════

function parseICS(text) {
  const events = [];
  const vevents = text.replace(/\r\n /g, '').replace(/\r\n\t/g, '').split('BEGIN:VEVENT').slice(1);

  for (const block of vevents) {
    const get = (key) => {
      const rx = new RegExp(`${key}[^:\n]*:([^\r\n]+)`);
      const m = block.match(rx);
      return m ? m[1].trim() : null;
    };

    const dtstartRaw = get('DTSTART');
    if (!dtstartRaw) continue;

    const dtParse = (raw) => {
      const clean = raw.replace(/[TZtz]/g, ' ').trim().replace(/\s+/, ' ');
      const d = clean.replace(/-/g, '');
      const date = `${d.substr(0,4)}-${d.substr(4,2)}-${d.substr(6,2)}`;
      const time = d.length > 8 ? `${d.substr(9,2)}:${d.substr(11,2)}` : null;
      return { date, time };
    };

    const start  = dtParse(dtstartRaw);
    const dtendRaw = get('DTEND');
    let endDate = null, endTime = null;
    if (dtendRaw) {
      const end = dtParse(dtendRaw);
      endTime = end.time;
      if (end.date !== start.date) {
        // All-day DTEND is exclusive (day after), subtract one
        if (!end.time) {
          const ed = addDays(parseDate(end.date), -1);
          endDate = fmt(ed);
          if (endDate === start.date) endDate = null;
        } else {
          endDate = end.date;
        }
      }
    }

    const rrule = get('RRULE');
    let recurring = { type: 'none' };
    if (rrule) {
      const freq     = (rrule.match(/FREQ=(\w+)/)?.[1] || '').toLowerCase();
      const interval = parseInt(rrule.match(/INTERVAL=(\d+)/)?.[1] || '1');
      const untilRaw = rrule.match(/UNTIL=(\d{8})/)?.[1];
      const countN   = parseInt(rrule.match(/COUNT=(\d+)/)?.[1] || '0');
      const freqMap  = { daily:'daily', weekly:'weekly', monthly:'monthly', yearly:'yearly' };
      if (freqMap[freq]) {
        recurring = { type: freqMap[freq], interval };
        if (untilRaw) recurring.endDate = `${untilRaw.substr(0,4)}-${untilRaw.substr(4,2)}-${untilRaw.substr(6,2)}`;
        if (countN)   recurring.count = countN;
      }
    }

    const clean = (s) => (s || '').replace(/\\n/g,' ').replace(/\\,/g,',').replace(/\\;/g,';').trim();

    events.push({
      type:       'termin',
      title:      clean(get('SUMMARY')) || 'Importierter Termin',
      date:       start.date,
      endDate:    endDate,
      startTime:  start.time,
      endTime:    endTime,
      location:   clean(get('LOCATION')) || null,
      description:clean(get('DESCRIPTION')) || null,
      memberIds:  ['all'],
      recurring,
      completed:  false,
    });
  }
  return events;
}

async function importICSFromInput(evt) {
  const file = evt.target.files?.[0];
  if (!file) return;
  const statusEl = document.getElementById('ical-import-status');
  if (statusEl) statusEl.classList.add('hidden');
  try {
    const text = await file.text();
    const events = parseICS(text);
    evt.target.value = '';
    if (events.length === 0) {
      if (statusEl) {
        statusEl.textContent = 'Keine Termine in der Datei gefunden';
        statusEl.classList.remove('hidden');
        setTimeout(() => statusEl.classList.add('hidden'), 4000);
      }
      return;
    }
    state.icalPending = events;
    openIcalImportSheet(events);
  } catch (e) {
    if (statusEl) {
      statusEl.textContent = 'Fehler beim Lesen der Datei';
      statusEl.classList.remove('hidden');
      setTimeout(() => statusEl.classList.add('hidden'), 4000);
    }
  }
}

function openIcalImportSheet(events) {
  const info = document.getElementById('ical-import-info');
  if (info) info.textContent = `${events.length} Termin${events.length === 1 ? '' : 'e'} gefunden. Wähle Personen für die Zuordnung — Standard: Alle.`;
  renderIcalMembersSelector(['all']);
  openSheet('sheet-ical-import');
}

function renderIcalMembersSelector(selectedIds) {
  const members = state.family?.members || [];
  const isAll = selectedIds.length === 0 || selectedIds[0] === 'all';
  let html = '';
  html += `<div class="member-select-row" onclick="App.toggleIcalAllMembers()">
    <div class="member-select-check${isAll ? ' checked' : ''}" id="ical-check-all"></div>
    <div class="member-select-dot" style="background:#4361ee">A</div>
    <div class="member-select-name">Alle</div>
  </div>`;
  for (const m of members) {
    const sel = !isAll && selectedIds.includes(m.id);
    html += `<div class="member-select-row" onclick="App.toggleIcalMember('${m.id}')">
      <div class="member-select-check${sel ? ' checked' : ''}" id="ical-check-${m.id}"></div>
      ${getMemberAvatar(m,'sm')}
      <div class="member-select-dot" style="background:${m.color}">${initials(m.name)}</div>
      <div class="member-select-name">${m.name}</div>
    </div>`;
  }
  setHTML('ical-members-selector', html);
}

function toggleIcalAllMembers() {
  const allCheck = document.getElementById('ical-check-all');
  if (!allCheck) return;
  const wasAll = allCheck.classList.contains('checked');
  if (!wasAll) {
    allCheck.classList.add('checked');
    (state.family?.members || []).forEach(m => {
      const el = document.getElementById(`ical-check-${m.id}`);
      if (el) el.classList.remove('checked');
    });
  }
}

function toggleIcalMember(id) {
  const el = document.getElementById(`ical-check-${id}`);
  if (!el) return;
  const allCheck = document.getElementById('ical-check-all');
  if (allCheck) allCheck.classList.remove('checked');
  el.classList.toggle('checked');
  const anySelected = (state.family?.members || []).some(m => {
    const c = document.getElementById(`ical-check-${m.id}`);
    return c && c.classList.contains('checked');
  });
  if (!anySelected && allCheck) allCheck.classList.add('checked');
}

function getIcalSelectedMemberIds() {
  const allCheck = document.getElementById('ical-check-all');
  if (allCheck && allCheck.classList.contains('checked')) return ['all'];
  const members = state.family?.members || [];
  const ids = members.filter(m => {
    const el = document.getElementById(`ical-check-${m.id}`);
    return el && el.classList.contains('checked');
  }).map(m => m.id);
  return ids.length > 0 ? ids : ['all'];
}

async function confirmIcalImport() {
  const events = state.icalPending || [];
  const statusEl = document.getElementById('ical-import-status');
  if (events.length === 0) { closeSheet('sheet-ical-import'); return; }
  const memberIds = getIcalSelectedMemberIds();
  closeSheet('sheet-ical-import');
  if (statusEl) {
    statusEl.textContent = 'Importiere...';
    statusEl.classList.remove('hidden');
  }
  let count = 0;
  for (const ev of events) {
    try { await dbSaveEvent({ ...ev, memberIds }); count++; } catch {}
  }
  state.icalPending = null;
  if (statusEl) {
    statusEl.textContent = `✓ ${count} Termin${count === 1 ? '' : 'e'} importiert`;
    setTimeout(() => statusEl.classList.add('hidden'), 4000);
  }
}

function cancelIcalImport() {
  state.icalPending = null;
  closeSheet('sheet-ical-import');
}

// ════════════════════════════════════════════════════════════════
//  NAVIGATION
// ════════════════════════════════════════════════════════════════

function setView(view) {
  state.currentView = view;
  document.querySelectorAll('.view-tab').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.getElementById('view-monat').classList.toggle('hidden', view !== 'monat');
  document.getElementById('view-woche').classList.toggle('hidden', view !== 'woche');
  document.getElementById('view-tag').classList.toggle('hidden', view !== 'tag');

  if (state.selectedDay && view !== 'monat') {
    hideEl('day-detail-panel');
    state.selectedDay = null;
  }
  renderCalendar();
}

function setTab(tab) {
  state.currentTab = tab;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('hidden'));
  showEl(`tab-${tab}`);

  const showViewTabs = tab === 'kalender';
  document.getElementById('view-tabs').classList.toggle('hidden', !showViewTabs);

  if (tab === 'kalender') renderCalendar();
  else if (tab === 'todos') renderTodos();
  else if (tab === 'geburtstage') renderBirthdays();
  else if (tab === 'einstellungen') renderSettings();
}

function navigatePrev() {
  const d = state.currentDate;
  if (state.currentView === 'monat') {
    state.currentDate = new Date(d.getFullYear(), d.getMonth()-1, 1);
  } else if (state.currentView === 'woche') {
    state.currentDate = addDays(d, -7);
  } else {
    state.currentDate = addDays(d, -1);
  }
  renderCalendar();
}

function navigateNext() {
  const d = state.currentDate;
  if (state.currentView === 'monat') {
    state.currentDate = new Date(d.getFullYear(), d.getMonth()+1, 1);
  } else if (state.currentView === 'woche') {
    state.currentDate = addDays(d, 7);
  } else {
    state.currentDate = addDays(d, 1);
  }
  renderCalendar();
}

function goToToday() {
  state.currentDate = new Date();
  renderCalendar();
}

function goToDay(dateStr) {
  state.currentDate = parseDate(dateStr);
  setView('tag');
}

function selectDay(dateStr) {
  if (state.selectedDay === dateStr) {
    hideEl('day-detail-panel');
    state.selectedDay = null;
    renderMonthView();
    return;
  }
  state.selectedDay = dateStr;
  renderMonthView();
  renderDayPanel(dateStr);
}

function closeDayPanel() {
  state.selectedDay = null;
  hideEl('day-detail-panel');
  renderMonthView();
}

function setTodoFilter(filter) {
  state.todoFilter = filter;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === filter));
  renderTodos();
}

// ════════════════════════════════════════════════════════════════
//  PAIRING
// ════════════════════════════════════════════════════════════════

function openPairing() {
  setHTML('pairing-code-big', formatCode(state.familyId) || '------');
  openSheet('sheet-pairing');
}

async function copyFamilyCode() {
  try {
    await navigator.clipboard.writeText(state.familyId);
    const btn = document.querySelector('#sheet-pairing .btn-secondary');
    if (btn) { btn.textContent = 'Kopiert! ✓'; setTimeout(() => btn.textContent = 'Code kopieren', 2000); }
  } catch {
    alert('Code: ' + formatCode(state.familyId));
  }
}

async function copyFamilyUrl() {
  const url = 'https://hermannmarco.github.io/Familienkalender/';
  const btn = document.querySelectorAll('#sheet-pairing .btn-secondary')[1];
  try {
    await navigator.clipboard.writeText(url);
    if (btn) { btn.textContent = 'Kopiert! ✓'; setTimeout(() => btn.textContent = 'URL kopieren', 2000); }
  } catch {
    alert('URL: ' + url);
  }
}

function confirmLeave() {
  if (confirm('Dieses Gerät vom Familienkalender trennen? Der Kalender wird nicht gelöscht.')) {
    if (state.unsubFamily) state.unsubFamily();
    if (state.unsubEvents) state.unsubEvents();
    localStorage.removeItem('familyId');
    location.reload();
  }
}

// ════════════════════════════════════════════════════════════════
//  PHASE 2: PAIRING (UID-basierter Zugriff via allowedUids)
// ════════════════════════════════════════════════════════════════

// Firebase-Auth-UIDs sind 28-stellige alphanumerische Strings.
function isValidUid(s) {
  return typeof s === 'string' && /^[A-Za-z0-9]{20,40}$/.test(s.trim());
}

let _pairingPollTimer = null;
let _pairingFamilyId  = null;

function showPairingPending(familyId) {
  _pairingFamilyId = familyId;
  // Listener stoppen, falls einer aus dem alten startApp-Pfad noch läuft.
  if (state.unsubFamily) { state.unsubFamily(); state.unsubFamily = null; }
  if (state.unsubEvents) { state.unsubEvents(); state.unsubEvents = null; }

  hideEl('screen-loading');
  hideEl('screen-setup');
  hideEl('screen-pin');
  hideEl('screen-app');
  showEl('screen-pairing-pending');

  const uidEl  = document.getElementById('pairing-pending-uid');
  const codeEl = document.getElementById('pairing-pending-code');
  if (uidEl)  uidEl.textContent  = state.uid || '(keine UID — Auth fehlgeschlagen)';
  if (codeEl) codeEl.textContent = formatCode(familyId) || '';

  renderPairingPendingQR();

  if (_pairingPollTimer) clearInterval(_pairingPollTimer);
  _pairingPollTimer = setInterval(() => pollPairingAccess(familyId), 3000);
}

async function pollPairingAccess(familyId) {
  if (!state.uid) return;
  try {
    const doc = await db.collection('families').doc(familyId).get();
    if (!doc.exists) return;
    const allowed = doc.data().allowedUids || [];
    if (allowed.includes(state.uid)) {
      clearInterval(_pairingPollTimer);
      _pairingPollTimer = null;
      hideEl('screen-pairing-pending');
      const familyData = doc.data();
      state.family = { id: familyId, ...familyData };
      localStorage.setItem('familyId', familyId);
      if (familyData.pinHash && isPinExpired()) {
        showPinPrompt('Bitte PIN eingeben', () => startApp(familyId));
      } else {
        startApp(familyId);
      }
    }
  } catch (e) {
    // permission-denied weiterhin → ignorieren, wir warten.
  }
}

async function copyOwnUid() {
  if (!state.uid) return;
  try {
    await navigator.clipboard.writeText(state.uid);
    const btn = document.getElementById('btn-copy-own-uid');
    if (btn) { btn.textContent = 'Kopiert ✓'; setTimeout(() => btn.textContent = 'UID kopieren', 2000); }
  } catch {
    alert('UID:\n' + state.uid);
  }
}

function leaveFromPairing() {
  if (confirm('Pairing abbrechen und zurück zur Familienauswahl?')) {
    if (_pairingPollTimer) { clearInterval(_pairingPollTimer); _pairingPollTimer = null; }
    localStorage.removeItem('familyId');
    location.reload();
  }
}

// QR-Lib lazy-load (~5 KB, gstatic-Cache → nach 1× online verfügbar)
let _qrLibPromise = null;
function loadQrLib() {
  if (_qrLibPromise) return _qrLibPromise;
  _qrLibPromise = new Promise((resolve, reject) => {
    if (typeof window.qrcode === 'function') return resolve(window.qrcode);
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js';
    s.onload = () => resolve(window.qrcode);
    s.onerror = () => reject(new Error('QR-Bibliothek konnte nicht geladen werden'));
    document.head.appendChild(s);
  });
  return _qrLibPromise;
}

async function renderPairingPendingQR() {
  const wrap = document.getElementById('pairing-pending-qr');
  if (!wrap || !state.uid) return;
  wrap.innerHTML = '<div style="color:var(--text-2);font-size:.85rem">QR wird geladen…</div>';
  try {
    const qrcode = await loadQrLib();
    const qr = qrcode(0, 'M');
    qr.addData(state.uid);
    qr.make();
    wrap.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2 });
    const svg = wrap.querySelector('svg');
    if (svg) {
      svg.style.width  = '180px';
      svg.style.height = '180px';
      svg.style.background = '#fff';
      svg.style.borderRadius = '8px';
      svg.style.padding = '6px';
    }
  } catch (e) {
    wrap.innerHTML = '<div style="color:var(--danger);font-size:.85rem">QR konnte nicht geladen werden (offline?)</div>';
  }
}

// Geräte-Verwaltung in Settings ────────────────────────────

function renderDevicesSettings() {
  const list = document.getElementById('devices-list');
  if (!list) return;
  const allowed = state.family?.allowedUids || [];
  const map     = state.family?.uidToMember || {};
  const members = state.family?.members || [];
  if (!allowed.length) {
    list.innerHTML = '<p style="color:var(--text-2);font-size:.9rem">Noch keine Geräte registriert.</p>';
    return;
  }
  list.innerHTML = allowed.map(u => {
    const isMe   = (u === state.uid);
    const short  = u.slice(0, 8) + '…' + u.slice(-4);
    const mappedId = map[u];
    const mappedMember = mappedId ? members.find(m => m.id === mappedId) : null;

    let personLine;
    if (mappedMember) {
      // Idee 1: Zuordnung ist immutable — als gesperrte Anzeige zeigen.
      personLine = `<div class="device-person-locked">→ ${mappedMember.name} <span class="device-locked-hint">(festgelegt)</span></div>`;
    } else if (members.length) {
      const opts = members.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
      personLine = `<select class="device-person-select"
                          onchange="App.assignDeviceToMember('${u}', this.value)">
        <option value="">– Person zuordnen –</option>
        ${opts}
      </select>`;
    } else {
      personLine = `<div class="device-person-locked" style="color:var(--text-2)">– keine Personen vorhanden –</div>`;
    }

    return `<div class="device-row">
      <div class="device-row-main">
        <div class="device-uid"><code>${short}</code>${isMe ? ' <span class="device-self">(dieses Gerät)</span>' : ''}</div>
        ${personLine}
      </div>
      ${isMe ? '' : `<button class="member-edit-btn" onclick="App.removeDevice('${u}')">Entfernen</button>`}
    </div>`;
  }).join('');
}

async function unlockDevice(uidToAdd, memberId = null) {
  const uid = (uidToAdd || '').trim();
  if (!isValidUid(uid)) {
    return { ok: false, msg: 'Ungültige UID (28 Zeichen, Buchstaben + Zahlen erwartet).' };
  }
  // Idee 1: Wenn beim Pairing direkt eine Person ausgewählt wurde, schreiben wir
  // allowedUids + uidToMember in einem Update, damit das neue Gerät sofort einsatzbereit ist.
  const update = {
    allowedUids: firebase.firestore.FieldValue.arrayUnion(uid),
  };
  if (memberId) {
    const member = (state.family?.members || []).find(m => m.id === memberId);
    if (!member) return { ok: false, msg: 'Person nicht gefunden.' };
    update[`uidToMember.${uid}`] = memberId;
  }
  try {
    await commitWrite(db.collection('families').doc(state.familyId).update(update));
    return { ok: true, msg: 'Gerät freigeschaltet.' };
  } catch (e) {
    return { ok: false, msg: 'Fehler: ' + (e.message || 'unbekannt') };
  }
}

async function removeDevice(uidToRemove) {
  if (uidToRemove === state.uid) {
    alert('Dieses Gerät kannst du nicht selbst entfernen — sonst sperrst du dich aus. Verwende stattdessen „Dieses Gerät trennen".');
    return;
  }
  if (!confirm(`Gerät ${uidToRemove.slice(0,8)}… wirklich entfernen? Es verliert ab sofort den Zugriff.`)) return;
  try {
    // Beim Entfernen auch das uidToMember-Mapping aufräumen, sonst bleiben tote Einträge stehen.
    const update = {
      allowedUids: firebase.firestore.FieldValue.arrayRemove(uidToRemove),
    };
    update[`uidToMember.${uidToRemove}`] = firebase.firestore.FieldValue.delete();
    update[`lastSeen.${uidToRemove}`] = firebase.firestore.FieldValue.delete();
    await commitWrite(db.collection('families').doc(state.familyId).update(update));
  } catch (e) {
    alert('Fehler beim Entfernen: ' + (e.message || 'unbekannt'));
  }
}

// Onboarding-Modal: zeigt sich automatisch wenn das aktuelle Gerät noch keiner Person zugeordnet ist.
let _whoamiShown = false;
function maybeShowWhoAmI() {
  if (_whoamiShown) return;
  if (!state.uid || !state.family) return;
  // App-Screen muss schon offen sein — sonst überlagert das Sheet einen Setup-Screen.
  if (document.getElementById('screen-app').classList.contains('hidden')) return;
  const map = state.family.uidToMember || {};
  if (map[state.uid]) return; // schon zugeordnet
  const members = state.family.members || [];
  if (!members.length) return; // keine Personen vorhanden → später nochmal probieren
  _whoamiShown = true;
  renderWhoAmI();
  openSheet('sheet-whoami');
}

function renderWhoAmI() {
  const members = state.family?.members || [];
  const list = document.getElementById('whoami-members');
  if (!list) return;
  list.innerHTML = members.map(m => `
    <div class="whoami-row" onclick="App.confirmWhoAmI('${m.id}')">
      ${getMemberAvatar(m,'md')}
      <div class="whoami-name">${m.name}</div>
    </div>
  `).join('');
  hideError('whoami-error');
}

async function confirmWhoAmI(memberId) {
  if (!confirm('Diese Zuordnung kann nicht mehr geändert werden. Fortfahren?')) return;
  try {
    const update = {};
    update[`uidToMember.${state.uid}`] = memberId;
    await commitWrite(db.collection('families').doc(state.familyId).update(update));
    closeSheet('sheet-whoami');
  } catch (e) {
    showError('whoami-error', 'Fehler: ' + (e.message || 'unbekannt'));
  }
}

// Erstmalige Zuordnung einer UID → Person. Immutable: wenn bereits gesetzt, abbrechen.
async function assignDeviceToMember(uid, memberId) {
  if (!uid || !memberId) return;
  const map = state.family?.uidToMember || {};
  if (map[uid]) {
    alert('Dieses Gerät ist bereits einer Person zugeordnet und kann nicht geändert werden.');
    return;
  }
  if (!isValidUid(uid)) { alert('Ungültige UID.'); return; }
  const member = (state.family?.members || []).find(m => m.id === memberId);
  if (!member) { alert('Person nicht gefunden.'); return; }
  try {
    const update = {};
    update[`uidToMember.${uid}`] = memberId;
    await commitWrite(db.collection('families').doc(state.familyId).update(update));
  } catch (e) {
    alert('Fehler beim Zuordnen: ' + (e.message || 'unbekannt'));
  }
}

// Sheet „Gerät freischalten" ───────────────────────────────

let _scannerStream = null;
let _scannerRaf    = null;

function openAddDevice() {
  document.getElementById('add-device-uid-input').value = '';
  hideError('add-device-error');
  // Idee 1: Member-Dropdown füllen (Person für das neue Gerät)
  const sel = document.getElementById('add-device-member');
  if (sel) {
    const members = state.family?.members || [];
    sel.innerHTML = '<option value="">– Person wählen –</option>' +
      members.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
    sel.value = '';
  }
  switchAddDeviceTab('paste');
  openSheet('sheet-add-device');
}

function _getAddDeviceMemberId() {
  const sel = document.getElementById('add-device-member');
  return sel ? sel.value : '';
}

function switchAddDeviceTab(which) {
  const isPaste = which === 'paste';
  document.getElementById('tab-add-device-paste').classList.toggle('active',  isPaste);
  document.getElementById('tab-add-device-scan').classList.toggle('active', !isPaste);
  document.getElementById('add-device-paste-pane').classList.toggle('hidden', !isPaste);
  document.getElementById('add-device-scan-pane').classList.toggle('hidden',   isPaste);
  if (!isPaste) startScanner();
  else stopScanner();
}

async function saveAddDevicePaste() {
  hideError('add-device-error');
  const val = document.getElementById('add-device-uid-input').value;
  const memberId = _getAddDeviceMemberId();
  if (!memberId) { showError('add-device-error', 'Bitte zuerst eine Person auswählen.'); return; }
  const res = await unlockDevice(val, memberId);
  if (!res.ok) { showError('add-device-error', res.msg); return; }
  closeSheet('sheet-add-device');
}

// Scanner-Lib lazy-load (~40 KB, einmalig).
let _jsqrPromise = null;
function loadJsQR() {
  if (_jsqrPromise) return _jsqrPromise;
  _jsqrPromise = new Promise((resolve, reject) => {
    if (typeof window.jsQR === 'function') return resolve(window.jsQR);
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js';
    s.onload = () => resolve(window.jsQR);
    s.onerror = () => reject(new Error('Scanner-Bibliothek konnte nicht geladen werden'));
    document.head.appendChild(s);
  });
  return _jsqrPromise;
}

async function startScanner() {
  const video = document.getElementById('add-device-video');
  const status = document.getElementById('add-device-scan-status');
  const errEl  = document.getElementById('add-device-error');
  if (errEl) errEl.classList.add('hidden');
  if (status) status.textContent = 'Kamera wird gestartet…';

  try {
    const jsQR = await loadJsQR();
    _scannerStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
    });
    video.srcObject = _scannerStream;
    video.setAttribute('playsinline', 'true');
    await video.play();
    if (status) status.textContent = 'Halte den QR-Code des neuen Geräts in die Kamera.';

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const tick = () => {
      if (!_scannerStream) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width  = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (code && code.data) {
          const candidate = code.data.trim();
          const memberId = _getAddDeviceMemberId();
          if (!memberId) {
            // Person muss vor dem Scan gewählt sein — sonst nicht freischalten
            stopScanner();
            showError('add-device-error', 'Bitte zuerst eine Person auswählen, dann erneut scannen.');
            return;
          }
          stopScanner();
          unlockDevice(candidate, memberId).then(res => {
            if (res.ok) closeSheet('sheet-add-device');
            else        showError('add-device-error', res.msg);
          });
          return;
        }
      }
      _scannerRaf = requestAnimationFrame(tick);
    };
    tick();
  } catch (e) {
    if (status) status.textContent = '';
    showError('add-device-error',
      'Kamera nicht verfügbar: ' + (e.message || 'Berechtigung verweigert'));
  }
}

function stopScanner() {
  if (_scannerRaf) { cancelAnimationFrame(_scannerRaf); _scannerRaf = null; }
  if (_scannerStream) {
    _scannerStream.getTracks().forEach(t => t.stop());
    _scannerStream = null;
  }
  const video = document.getElementById('add-device-video');
  if (video) video.srcObject = null;
}


// ════════════════════════════════════════════════════════════════
//  SETUP FLOW
// ════════════════════════════════════════════════════════════════

function showSetupChoice() {
  showEl('setup-choice');
  hideEl('setup-create-form');
  hideEl('setup-join-form');
  hideError('setup-error');
  hideError('join-error');
}

function showSetupCreate() {
  hideEl('setup-choice');
  showEl('setup-create-form');
  hideEl('setup-join-form');
  setTimeout(() => document.getElementById('input-family-name').focus(), 100);
}

function showSetupJoin() {
  hideEl('setup-choice');
  hideEl('setup-create-form');
  showEl('setup-join-form');
  setTimeout(() => document.getElementById('input-join-code').focus(), 100);
}

async function createFamily() {
  const name   = document.getElementById('input-family-name').value.trim();
  const member = document.getElementById('input-first-member-name').value.trim();
  const pinVal = document.getElementById('input-setup-pin')?.value.trim() || '';
  if (!name)   { showError('setup-error', 'Bitte Familienname eingeben'); return; }
  if (!member) { showError('setup-error', 'Bitte deinen Namen eingeben'); return; }
  if (pinVal && (pinVal.length < 4 || !/^\d+$/.test(pinVal))) {
    showError('setup-error', 'PIN: mind. 4 Ziffern (nur Zahlen)'); return;
  }
  try {
    const pinHash = (pinVal.length >= 4) ? await hashPin(pinVal) : null;
    const code = await dbCreateFamily(name, member, pinHash);
    localStorage.setItem('familyId', code);
    if (pinHash) localStorage.setItem('pin_verified_at', String(Date.now()));
    startApp(code);
  } catch (e) {
    showError('setup-error', 'Fehler: ' + e.message);
  }
}

async function joinFamily() {
  // Pt 17: accept 6 or 12 chars (strip hyphens)
  const code = document.getElementById('input-join-code').value.trim().toUpperCase().replace(/-/g, '');
  if (code.length !== 6 && code.length !== 12) {
    showError('join-error', 'Bitte gültigen Code eingeben (6 oder 12 Zeichen)');
    return;
  }
  try {
    const doc = await db.collection('families').doc(code).get();
    if (!doc.exists) throw new Error('Familie nicht gefunden');
    const familyData = doc.data();
    const doJoin = () => {
      localStorage.setItem('familyId', code);
      startApp(code);
    };
    if (familyData.pinHash) {
      state.family = { id: code, ...familyData };
      showPinPrompt('PIN für diesen Kalender eingeben', () => {
        localStorage.setItem('pin_verified_at', String(Date.now()));
        doJoin();
      });
    } else {
      doJoin();
    }
  } catch (e) {
    // Phase 2: Wenn das Family-Doc unter den neuen Rules nicht lesbar ist
    // (eigene UID nicht in allowedUids), zeigen wir den Pairing-Pending-Screen.
    if (e && e.code === 'permission-denied') {
      localStorage.setItem('familyId', code);
      showPairingPending(code);
      return;
    }
    showError('join-error', e.message || 'Fehler beim Beitreten');
  }
}

// ════════════════════════════════════════════════════════════════
//  APP START
// ════════════════════════════════════════════════════════════════

let _offlineBannerTimer = null;
function setupOfflineBanner() {
  const banner = document.getElementById('offline-banner');
  if (!banner) return;
  const hide = () => {
    banner.classList.add('hidden');
    if (_offlineBannerTimer) { clearTimeout(_offlineBannerTimer); _offlineBannerTimer = null; }
  };
  const show = () => {
    banner.classList.remove('hidden');
    if (_offlineBannerTimer) clearTimeout(_offlineBannerTimer);
    _offlineBannerTimer = setTimeout(hide, 5000);
  };
  window.addEventListener('online',  hide);
  window.addEventListener('offline', show);
  // iOS Safari verliert nach Rotation manchmal den Text durch stale env(safe-area-inset-top).
  // Falls Banner gerade sichtbar: kurzer Reflow erzwingen.
  const reflow = () => {
    if (banner.classList.contains('hidden')) return;
    banner.style.display = 'none';
    void banner.offsetHeight;
    banner.style.display = '';
  };
  window.addEventListener('orientationchange', reflow);
  window.addEventListener('resize', reflow);
  if (!navigator.onLine) show();
}

function startApp(familyId) {
  state.familyId = familyId;
  hideEl('screen-loading');
  hideEl('screen-setup');
  hideEl('screen-pin');
  showEl('screen-app');
  subscribeFamily(familyId);
  subscribeEvents(familyId);
  recordLastSeen();
  renderHeaderTitle();
  renderCalendar();
}

// ════════════════════════════════════════════════════════════════
//  IDEE 2: PUSH-ERINNERUNGEN
// ════════════════════════════════════════════════════════════════

function isPushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function refreshPushStatus() {
  if (!isPushSupported()) {
    state.notificationStatus = 'unsupported';
    state.hasPushSubscription = false;
  } else {
    state.notificationStatus = Notification.permission;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      state.hasPushSubscription = !!sub;
    } catch {
      state.hasPushSubscription = false;
    }
  }
  renderNotificationsSettings();
}

function renderNotificationsSettings() {
  const statusEl = document.getElementById('notifications-status');
  const btn = document.getElementById('notifications-toggle-btn');
  if (!statusEl || !btn) return;

  if (state.notificationStatus === 'unsupported') {
    statusEl.textContent = 'Dieses Gerät unterstützt keine Push-Benachrichtigungen.';
    btn.style.display = 'none';
    return;
  }
  btn.style.display = '';

  if (state.hasPushSubscription && state.notificationStatus === 'granted') {
    statusEl.textContent = '✅ Aktiv auf diesem Gerät';
    btn.textContent = 'Deaktivieren';
  } else if (state.notificationStatus === 'denied') {
    statusEl.textContent = '❌ Vom Browser blockiert. In den Browser-/iOS-Einstellungen Benachrichtigungen für diese App erlauben, dann erneut aktivieren.';
    btn.textContent = 'Aktivieren';
  } else {
    statusEl.textContent = 'Nicht aktiviert';
    btn.textContent = 'Aktivieren';
  }
}

async function toggleNotifications() {
  if (state.hasPushSubscription) {
    await disableNotifications();
  } else {
    await enableNotifications();
  }
}

async function enableNotifications() {
  if (!isPushSupported()) {
    alert('Dieses Gerät unterstützt keine Push-Benachrichtigungen.');
    return;
  }
  if (!state.familyId || !state.uid) {
    alert('Familie noch nicht geladen. Bitte kurz warten.');
    return;
  }
  try {
    const perm = await Notification.requestPermission();
    state.notificationStatus = perm;
    if (perm !== 'granted') {
      renderNotificationsSettings();
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }
    await dbSavePushSubscription(state.uid, sub.toJSON());
    state.hasPushSubscription = true;
    renderNotificationsSettings();
  } catch (err) {
    console.error('enableNotifications failed:', err);
    alert('Aktivieren fehlgeschlagen: ' + (err.message || err));
  }
}

async function disableNotifications() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
    if (state.uid && state.familyId) await dbRemovePushSubscription(state.uid);
    state.hasPushSubscription = false;
    renderNotificationsSettings();
  } catch (err) {
    console.error('disableNotifications failed:', err);
  }
}

// — Reminder-UI im Event-Form ─────────────────────────────────────

const REMINDER_PRESETS = [
  { value: 5,     label: '5 Minuten vorher' },
  { value: 15,    label: '15 Minuten vorher' },
  { value: 30,    label: '30 Minuten vorher' },
  { value: 60,    label: '1 Stunde vorher' },
  { value: 120,   label: '2 Stunden vorher' },
  { value: 1440,  label: '1 Tag vorher' },
  { value: 2880,  label: '2 Tage vorher' },
  { value: 10080, label: '1 Woche vorher' },
  { value: 20160, label: '2 Wochen vorher' },
];
const REMINDER_MAX = 3;

function decomposeOffset(min) {
  const w = Math.floor(min / 10080); min -= w * 10080;
  const d = Math.floor(min / 1440);  min -= d * 1440;
  const h = Math.floor(min / 60);    min -= h * 60;
  return { w, d, h, m: min };
}

function renderReminders(list) {
  const container = document.getElementById('reminders-list');
  if (!container) return;
  container.innerHTML = '';
  (list || []).forEach(r => addReminderRow(r.offsetMinutes));
  updateReminderAddBtn();
}

function updateReminderAddBtn() {
  const btn = document.getElementById('reminders-add-btn');
  const list = document.getElementById('reminders-list');
  if (!btn || !list) return;
  btn.disabled = list.children.length >= REMINDER_MAX;
}

function addReminderRow(offsetMinutes) {
  const list = document.getElementById('reminders-list');
  if (!list || list.children.length >= REMINDER_MAX) return;

  const row = document.createElement('div');
  row.className = 'reminder-row-wrap';

  const isPreset = offsetMinutes != null && REMINDER_PRESETS.some(p => p.value === offsetMinutes);
  const isCustom = offsetMinutes != null && !isPreset;
  const selectedVal = offsetMinutes == null ? 15 : (isCustom ? 'custom' : offsetMinutes);

  const presetOptions = REMINDER_PRESETS.map(p =>
    `<option value="${p.value}"${p.value === selectedVal ? ' selected' : ''}>${p.label}</option>`
  ).join('');

  row.innerHTML = `
    <div class="reminder-row">
      <select class="reminder-select" onchange="App.onReminderSelectChange(this)">
        ${presetOptions}
        <option value="custom"${isCustom ? ' selected' : ''}>Benutzerdefiniert…</option>
      </select>
      <button type="button" class="reminder-remove-btn" onclick="App.removeReminderRow(this)" aria-label="Entfernen">×</button>
    </div>
    <div class="reminder-custom" style="display:none">
      <div><input type="number" min="0" class="rc-w" placeholder="0"><div class="reminder-custom-label">Wochen</div></div>
      <div><input type="number" min="0" class="rc-d" placeholder="0"><div class="reminder-custom-label">Tage</div></div>
      <div><input type="number" min="0" class="rc-h" placeholder="0"><div class="reminder-custom-label">Stunden</div></div>
      <div><input type="number" min="0" class="rc-m" placeholder="0"><div class="reminder-custom-label">Minuten</div></div>
    </div>
  `;
  list.appendChild(row);

  if (isCustom) {
    const parts = decomposeOffset(offsetMinutes);
    row.querySelector('.rc-w').value = parts.w || '';
    row.querySelector('.rc-d').value = parts.d || '';
    row.querySelector('.rc-h').value = parts.h || '';
    row.querySelector('.rc-m').value = parts.m || '';
    row.querySelector('.reminder-custom').style.display = '';
  }
  updateReminderAddBtn();
}

function onReminderSelectChange(selectEl) {
  const wrap = selectEl.closest('.reminder-row-wrap');
  const customBox = wrap.querySelector('.reminder-custom');
  customBox.style.display = (selectEl.value === 'custom') ? '' : 'none';
}

function removeReminderRow(btnEl) {
  const wrap = btnEl.closest('.reminder-row-wrap');
  if (wrap) wrap.remove();
  updateReminderAddBtn();
}

function openEventFromUrl(eventId, dateStr) {
  if (!eventId) return;
  const ev = state.events.find(e => e.id === eventId);
  if (!ev) {
    state.pendingOpenEvent = { eventId, date: dateStr };
    return;
  }
  const target = dateStr || ev.date;
  const d = parseDate(target);
  if (d) {
    state.currentDate = d;
    state.currentView = 'tag';
    state.currentTab = 'kalender';
    renderCalendar();
    setTab('kalender');
  }
  setTimeout(() => openEventDetail(eventId, target), 100);
}

function collectRemindersFromForm() {
  const list = document.getElementById('reminders-list');
  if (!list) return [];
  const out = [];
  for (const wrap of list.children) {
    const sel = wrap.querySelector('.reminder-select');
    if (!sel) continue;
    let off;
    if (sel.value === 'custom') {
      const w = parseInt(wrap.querySelector('.rc-w').value) || 0;
      const d = parseInt(wrap.querySelector('.rc-d').value) || 0;
      const h = parseInt(wrap.querySelector('.rc-h').value) || 0;
      const m = parseInt(wrap.querySelector('.rc-m').value) || 0;
      off = w * 10080 + d * 1440 + h * 60 + m;
      if (off <= 0) continue;
    } else {
      off = parseInt(sel.value);
      if (!off || off <= 0) continue;
    }
    out.push({ offsetMinutes: off });
  }
  return out;
}

// ════════════════════════════════════════════════════════════════
//  PUBLIC API
// ════════════════════════════════════════════════════════════════

const App = {
  showSetupChoice, showSetupCreate, showSetupJoin,
  createFamily, joinFamily,
  setView, setTab,
  navigatePrev, navigateNext, goToToday, goToDay,
  selectDay, closeDayPanel,
  openAddEvent, openAddEventForCurrentDay, openEditEvent, saveEvent,
  openEventDetail, editCurrentEvent, deleteCurrentEvent,
  applyRecurringAction,
  toggleTodo, toggleTodoFromDetail,
  setTodoFilter,
  openAddMember, openEditMember, saveMember,
  selectColor,
  toggleAllMembers, toggleMember,
  onPrivateToggle,
  toggleTime, toggleRecurringOptions, toggleRecurringEnd,
  setEventType,
  openPairing, copyFamilyCode, copyFamilyUrl, confirmLeave,
  closeSheet, closeAllSheets,
  // Pt 11: search
  toggleSearch, onSearchInput,
  // Pt 16: person filter
  setPersonFilter,
  // Pt 18: night mode
  toggleNightMode, toggleAutoNightMode, saveNightModeSchedule,
  // Pt 7: bundesland
  saveBundesland,
  // Pt 9: iCal
  importICSFromInput,
  toggleIcalMember, toggleIcalAllMembers, confirmIcalImport, cancelIcalImport,
  // Pt 19: member photo
  handleMemberPhotoInput, removeMemberPhoto,
  // Pt 26: PIN
  confirmPin,
  openSetPIN, openChangePIN, openRemovePIN, savePinManage,
  // Phase 2: Pairing / Geräte
  copyOwnUid, leaveFromPairing,
  openAddDevice, switchAddDeviceTab, saveAddDevicePaste,
  unlockDevice, removeDevice,
  // Idee 1: Privat-Termine
  assignDeviceToMember, confirmWhoAmI,
  // Idee 2: Push-Erinnerungen
  toggleNotifications,
  addReminderRow, removeReminderRow, onReminderSelectChange,
};

// ════════════════════════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════════════════════════

(async function init() {
  const ok = await initFirebase();
  if (!ok) {
    const offline = !navigator.onLine || typeof firebase === 'undefined';
    const msg = offline
      ? 'App ist offline und konnte nicht starten.<br>Bitte mit dem Internet verbinden und Seite neu laden.'
      : 'Anmeldung fehlgeschlagen.<br>Bitte Seite neu laden.';
    document.getElementById('screen-loading').innerHTML =
      `<p style="color:white;padding:24px;text-align:center">${msg}</p>`;
    return;
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
    // Idee 2: Notification-Click vom SW empfangen
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'open-event') {
        openEventFromUrl(event.data.eventId, event.data.date);
      }
    });
  }

  // Idee 2: ?openEvent=&date= aus URL übernehmen (öffnet Termin-Detail nach Events-Load)
  try {
    const params = new URLSearchParams(location.search);
    const evId = params.get('openEvent');
    const evDate = params.get('date');
    if (evId) {
      state.pendingOpenEvent = { eventId: evId, date: evDate };
      history.replaceState(null, '', location.pathname);
    }
  } catch {}

  setupOfflineBanner();

  // Pt 18: apply saved theme immediately
  applyTheme();
  setInterval(() => {
    if (localStorage.getItem('theme_mode') === 'auto') checkAutoTheme();
  }, 60000);

  // Pt 21: portrait/landscape zoom reset
  window.addEventListener('orientationchange', () => {
    const mv = document.querySelector('meta[name=viewport]');
    if (mv) {
      mv.content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0';
      setTimeout(() => { mv.content = 'width=device-width, initial-scale=1.0, viewport-fit=cover'; }, 400);
    }
  });

  const savedId = localStorage.getItem('familyId');
  if (savedId) {
    db.collection('families').doc(savedId).get().then(doc => {
      if (doc.exists) {
        const familyData = doc.data();
        state.family = { id: savedId, ...familyData };
        if (familyData.pinHash && isPinExpired()) {
          showPinPrompt('Bitte PIN eingeben', () => startApp(savedId));
        } else {
          startApp(savedId);
        }
      } else {
        localStorage.removeItem('familyId');
        showSetup();
      }
    }).catch(err => {
      // Phase 2: permission-denied → Pairing-Pending. Bei anderen Fehlern (z.B. offline)
      // optimistisch starten und auf den Listener vertrauen — wie vorher.
      if (err && err.code === 'permission-denied') {
        showPairingPending(savedId);
      } else {
        startApp(savedId);
      }
    });
  } else {
    showSetup();
  }

  function showSetup() {
    hideEl('screen-loading');
    showEl('screen-setup');
    showSetupChoice();
  }

  // Weekday buttons toggle
  document.querySelectorAll('.wday-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      this.classList.toggle('selected');
    });
  });
})();
