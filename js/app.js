'use strict';

// ════════════════════════════════════════════════════════════════
//  CONSTANTS
// ════════════════════════════════════════════════════════════════

const MEMBER_COLORS = [
  '#e63946','#f4a261','#e9c46a','#a8dadc',
  '#4361ee','#7b2d8b','#2ec4b6','#ff6b6b',
  '#1dd1a1','#ffd166','#6a4c93','#f77f00',
];

const DE_MONTHS = ['Januar','Februar','März','April','Mai','Juni',
                   'Juli','August','September','Oktober','November','Dezember'];
const DE_MONTHS_SHORT = ['Jan','Feb','Mär','Apr','Mai','Jun',
                          'Jul','Aug','Sep','Okt','Nov','Dez'];
const DE_WEEKDAYS_SHORT = ['So','Mo','Di','Mi','Do','Fr','Sa'];
const DE_WEEKDAYS = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];

// ════════════════════════════════════════════════════════════════
//  STATE
// ════════════════════════════════════════════════════════════════

const state = {
  familyId: null,
  family: null,          // { id, name, members:[] }
  events: [],            // raw Firestore docs
  currentView: 'monat',
  currentDate: new Date(),
  currentTab: 'kalender',
  todoFilter: 'offen',
  selectedDay: null,     // date string YYYY-MM-DD
  editingEventId: null,  // id of event being edited
  editingEventData: null,// cached event for recurring action
  editingMemberId: null,
  recurringAction: null, // pending action: 'edit'|'delete'
  unsubFamily: null,
  unsubEvents: null,
};

// ════════════════════════════════════════════════════════════════
//  FIREBASE INIT
// ════════════════════════════════════════════════════════════════

let db;

function initFirebase() {
  try {
    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
    db.enablePersistence({ synchronizeTabs: true }).catch(() => {});
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
  const d = new Date();
  return fmt(d);
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

function startOfWeek(d) {
  // Monday-based
  const day = d.getDay();
  const diff = (day + 6) % 7;
  return addDays(d, -diff);
}

function formatDisplay(dateStr) {
  const d = parseDate(dateStr);
  const day = d.getDate();
  const month = DE_MONTHS[d.getMonth()];
  const year = d.getFullYear();
  const todayStr = today();
  if (dateStr === todayStr) return 'Heute';
  if (dateStr === fmt(addDays(parseDate(todayStr), 1))) return 'Morgen';
  if (dateStr === fmt(addDays(parseDate(todayStr), -1))) return 'Gestern';
  return `${DE_WEEKDAYS[d.getDay()]}, ${day}. ${month} ${year}`;
}

function formatDisplayShort(dateStr) {
  const d = parseDate(dateStr);
  return `${d.getDate()}. ${DE_MONTHS_SHORT[d.getMonth()]}`;
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
    const d = parseDate(event.date);
    if (d >= rangeStart && d <= rangeEnd) return [{ ...event }];
    return [];
  }
  const { type, interval = 1, endDate, count } = event.recurring;
  const exceptions = new Set(event.recurring.exceptions || []);
  const instances = [];
  let cur = new Date(parseDate(event.date));
  let n = 0;

  while (true) {
    if (endDate && cur > parseDate(endDate)) break;
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

function getEventsForRange(startDate, endDate) {
  const result = [];
  for (const ev of state.events) {
    if (ev.type === 'birthday') {
      // Expand birthday for current year and adjacent years
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
  const timeA = a.startTime || '00:00';
  const timeB = b.startTime || '00:00';
  if (!a.startTime && !b.startTime) return 0;
  if (!a.startTime) return 1;
  if (!b.startTime) return -1;
  return timeA.localeCompare(timeB);
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
        renderAll();
      } else {
        // Family deleted
        localStorage.removeItem('familyId');
        location.reload();
      }
    }, err => console.error('Family listen error', err));
}

function subscribeEvents(familyId) {
  if (state.unsubEvents) state.unsubEvents();
  state.unsubEvents = db.collection('families').doc(familyId)
    .collection('events').onSnapshot(snap => {
      state.events = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderCalendar();
      renderTodos();
      renderBirthdays();
    }, err => console.error('Events listen error', err));
}

async function dbCreateFamily(name, firstMemberName) {
  const code = genCode();
  const member = { id: genId(), name: firstMemberName, color: MEMBER_COLORS[0] };
  await db.collection('families').doc(code).set({
    name,
    members: [member],
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
  return code;
}

async function dbJoinFamily(code) {
  const doc = await db.collection('families').doc(code.toUpperCase()).get();
  if (!doc.exists) throw new Error('Familie nicht gefunden');
  return code.toUpperCase();
}

async function dbSaveEvent(data) {
  const col = db.collection('families').doc(state.familyId).collection('events');
  if (data.id) {
    const { id, ...rest } = data;
    await col.doc(id).set({ ...rest, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
  } else {
    await col.add({ ...data, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
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

// ════════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════════

function genId() {
  return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function getMember(id) {
  if (!state.family) return null;
  return state.family.members.find(m => m.id === id) || null;
}

function getEventColor(event) {
  if (event.type === 'birthday') return '#f59e0b';
  if (event.memberIds && event.memberIds.length > 0 && event.memberIds[0] !== 'all') {
    const m = getMember(event.memberIds[0]);
    if (m) return m.color;
  }
  return '#4361ee';
}

function initials(name) {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().substr(0,2);
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
  const labels = { daily: ['täglich','alle'], weekly: ['wöchentlich','alle'], monthly: ['monatlich','alle'], yearly: ['jährlich','alle'] };
  const units = { daily: ['Tag','Tage'], weekly: ['Woche','Wochen'], monthly: ['Monat','Monate'], yearly: ['Jahr','Jahre'] };
  if (intv === 1) return `Wiederholt sich ${labels[recurring.type]?.[0] || recurring.type}`;
  const u = units[recurring.type] || ['',''];
  return `Alle ${intv} ${intv === 1 ? u[0] : u[1]}`;
}

function calcAge(birthdayDateStr, displayYear) {
  const base = parseDate(birthdayDateStr);
  if (base.getFullYear() === 1900) return null; // no year stored
  return displayYear - base.getFullYear();
}

function daysUntil(dateStr) {
  const todayD = parseDate(today());
  const d = parseDate(dateStr);
  const diff = Math.round((d - todayD) / 86400000);
  return diff;
}

// ════════════════════════════════════════════════════════════════
//  RENDER: CALENDAR HEADER TITLE
// ════════════════════════════════════════════════════════════════

function renderHeaderTitle() {
  const d = state.currentDate;
  let title = '';
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
  }
  const el = document.getElementById('header-title');
  if (el) el.textContent = title;
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
  const startDow = (firstDay.getDay() + 6) % 7; // Mon=0

  // Extend range slightly for event query
  const rangeStart = addDays(firstDay, -startDow);
  const rangeEnd   = addDays(lastDay, 42 - lastDay.getDate() - startDow);

  const eventsInRange = getEventsForRange(rangeStart, rangeEnd);

  // Group by date
  const byDate = {};
  for (const ev of eventsInRange) {
    if (!byDate[ev.date]) byDate[ev.date] = [];
    byDate[ev.date].push(ev);
  }

  let html = '';
  // Prev month padding
  for (let i = 0; i < startDow; i++) {
    const pd = addDays(firstDay, -(startDow - i));
    const ds = fmt(pd);
    html += renderMonthCell(ds, pd.getDate(), true, byDate[ds] || [], todayStr);
  }
  // Current month
  for (let day = 1; day <= lastDay.getDate(); day++) {
    const pd = new Date(year, month, day);
    const ds = fmt(pd);
    html += renderMonthCell(ds, day, false, byDate[ds] || [], todayStr);
  }
  // Next month padding
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

  let cls = 'month-cell';
  if (otherMonth) cls += ' other-month';
  if (isToday) cls += ' today';
  if (isSelected) cls += ' selected';
  if (isWeekend && !otherMonth) cls += ' weekend';

  const sorted = events.sort((a,b) => {
    if (a.type === 'birthday' && b.type !== 'birthday') return 1;
    if (b.type === 'birthday' && a.type !== 'birthday') return -1;
    return (a.startTime||'').localeCompare(b.startTime||'');
  });

  let chipsHtml = '';
  const MAX = 3;
  for (let i = 0; i < Math.min(sorted.length, MAX); i++) {
    const ev = sorted[i];
    const col = getEventColor(ev);
    const label = ev.type === 'birthday' ? `🎂 ${ev.title}` : ev.title;
    const typeCls = ev.type === 'birthday' ? ' birthday' : '';
    chipsHtml += `<div class="cell-event-chip${typeCls}" style="background:${col}" title="${ev.title}">${label}</div>`;
  }
  if (sorted.length > MAX) {
    chipsHtml += `<div class="cell-more">+${sorted.length - MAX} weitere</div>`;
  }

  return `<div class="${cls}" onclick="App.selectDay('${ds}')">
    <div class="cell-day">${dayNum}</div>
    <div class="cell-events">${chipsHtml}</div>
  </div>`;
}

function renderDayPanel(dateStr) {
  const d = parseDate(dateStr);
  const label = `${DE_WEEKDAYS[d.getDay()]}, ${d.getDate()}. ${DE_MONTHS[d.getMonth()]}`;
  setHTML('day-detail-label', label);

  const events = getEventsForDay(dateStr);
  if (events.length === 0) {
    setHTML('day-detail-events', '<p style="color:var(--text-2);font-size:.9rem;padding:8px 4px">Keine Termine</p>');
  } else {
    setHTML('day-detail-events', events.map(ev => renderEventCard(ev)).join(''));
  }
  showEl('day-detail-panel');
}

// ════════════════════════════════════════════════════════════════
//  RENDER: WEEK VIEW
// ════════════════════════════════════════════════════════════════

function renderWeekView() {
  const mon = startOfWeek(state.currentDate);
  const todayStr = today();

  // Header
  let headerHtml = '<div></div>';
  for (let i = 0; i < 7; i++) {
    const d = addDays(mon, i);
    const ds = fmt(d);
    const isToday = ds === todayStr;
    const dow = DE_WEEKDAYS_SHORT[(d.getDay())];
    headerHtml += `<div class="week-header-cell${isToday ? ' today' : ''}">
      <div class="wh-weekday">${dow}</div>
      <div class="wh-day" onclick="App.goToDay('${ds}')">${d.getDate()}</div>
    </div>`;
  }
  setHTML('week-header', headerHtml);

  // Range
  const rangeStart = mon;
  const rangeEnd = addDays(mon, 6);
  const allEvents = getEventsForRange(rangeStart, rangeEnd);

  // All-day events
  const allDay = allEvents.filter(e => !e.startTime && e.type !== 'birthday');
  const timed  = allEvents.filter(e => e.startTime);
  const bdays  = allEvents.filter(e => e.type === 'birthday');

  let alldayHtml = '<div></div>';
  const alldayByDay = {};
  for (const ev of [...allDay, ...bdays]) {
    if (!alldayByDay[ev.date]) alldayByDay[ev.date] = [];
    alldayByDay[ev.date].push(ev);
  }
  for (let i = 0; i < 7; i++) {
    const ds = fmt(addDays(mon, i));
    const evs = alldayByDay[ds] || [];
    alldayHtml += `<div class="week-allday-cell">${evs.map(ev => {
      const col = getEventColor(ev);
      return `<div class="cell-event-chip" style="background:${col};margin:1px" onclick="App.openEventDetail('${ev.id}','${ev.date}')">${ev.title}</div>`;
    }).join('')}</div>`;
  }

  const alldayEl = document.getElementById('week-allday');
  if (allDay.length > 0 || bdays.length > 0) {
    alldayEl.innerHTML = alldayHtml;
    alldayEl.classList.remove('hidden');
  } else {
    alldayEl.classList.add('hidden');
  }

  // Time grid
  let gridHtml = '';
  for (let hour = 0; hour < 24; hour++) {
    gridHtml += `<div class="time-label">${hour > 0 ? hour + ':00' : ''}</div>`;
    for (let col = 0; col < 7; col++) {
      gridHtml += `<div class="week-col" data-day="${col}" data-hour="${hour}">
        <div class="hour-line"></div><div class="half-line"></div>
      </div>`;
    }
  }
  setHTML('week-grid', gridHtml);

  // Place timed events as absolutely positioned blocks
  const gridEl = document.getElementById('week-grid');
  for (const ev of timed) {
    const d = parseDate(ev.date);
    const colIdx = (d.getDay() + 6) % 7;
    if (colIdx < 0 || colIdx > 6) continue;

    const [sh, sm] = (ev.startTime || '00:00').split(':').map(Number);
    const [eh, em] = (ev.endTime   || String(sh+1).padStart(2,'0')+':00').split(':').map(Number);
    const topPx    = (sh * 48) + (sm / 60 * 48);
    const height   = Math.max(24, ((eh - sh) * 48) + ((em - sm) / 60 * 48));

    const col = getEventColor(ev);
    const block = document.createElement('div');
    block.className = 'event-block';
    block.style.cssText = `background:${col};top:${topPx}px;height:${height}px;`;
    block.innerHTML = `<span>${ev.title}</span><span class="eb-time">${ev.startTime}${ev.endTime ? '–'+ev.endTime:''}</span>`;
    block.onclick = () => App.openEventDetail(ev.id, ev.date);

    // Find the column element
    const cols = gridEl.querySelectorAll(`.week-col[data-day="${colIdx}"]`);
    const hourEl = cols[sh];
    if (hourEl) {
      hourEl.style.position = 'relative';
      const wrapper = document.createElement('div');
      wrapper.style.cssText = `position:absolute;left:2px;right:2px;top:${sm/60*48}px;height:${height}px;z-index:1`;
      wrapper.innerHTML = block.outerHTML;
      wrapper.querySelector('.event-block').onclick = () => App.openEventDetail(ev.id, ev.date);
      hourEl.appendChild(wrapper);
    }
  }

  // Now-line
  const nowD = new Date();
  if (nowD >= rangeStart && nowD <= rangeEnd) {
    const colIdx = (nowD.getDay() + 6) % 7;
    const topPx = nowD.getHours()*48 + nowD.getMinutes()/60*48;
    const cols = gridEl.querySelectorAll(`.week-col[data-day="${colIdx}"]`);
    const hourEl = cols[nowD.getHours()];
    if (hourEl) {
      const nl = document.createElement('div');
      nl.className = 'now-line';
      nl.style.top = `${nowD.getMinutes()/60*48}px`;
      nl.innerHTML = '<div class="now-dot"></div>';
      hourEl.appendChild(nl);
    }
  }

  // Scroll to ~8am
  setTimeout(() => {
    const wrap = document.querySelector('#view-woche .time-scroll-wrap');
    if (wrap) wrap.scrollTop = 8 * 48;
  }, 50);
}

// ════════════════════════════════════════════════════════════════
//  RENDER: DAY VIEW
// ════════════════════════════════════════════════════════════════

function renderDayView() {
  const ds = fmt(state.currentDate);
  const events = getEventsForDay(ds);
  const timed  = events.filter(e => e.startTime);
  const allDay = events.filter(e => !e.startTime);

  // All-day
  const alldayEl = document.getElementById('day-allday');
  if (allDay.length > 0) {
    alldayEl.innerHTML = allDay.map(ev => {
      const col = getEventColor(ev);
      return `<div class="cell-event-chip" style="background:${col};margin:2px;font-size:.8rem" onclick="App.openEventDetail('${ev.id}','${ev.date}')">${ev.type==='birthday'?'🎂 ':''} ${ev.title}</div>`;
    }).join('');
  } else {
    alldayEl.innerHTML = '';
  }

  // Time grid
  let gridHtml = '';
  for (let h = 0; h < 24; h++) {
    gridHtml += `<div class="time-label">${h > 0 ? h+':00' : ''}</div>
    <div class="day-col" data-hour="${h}">
      <div class="hour-line"></div><div class="half-line"></div>
    </div>`;
  }
  setHTML('day-grid', gridHtml);

  const gridEl = document.getElementById('day-grid');

  for (const ev of timed) {
    const [sh, sm] = (ev.startTime || '00:00').split(':').map(Number);
    const [eh, em] = (ev.endTime || String(sh+1).padStart(2,'0')+':00').split(':').map(Number);
    const topPx    = sm / 60 * 48;
    const height   = Math.max(24, (eh-sh)*48 + (em-sm)/60*48);

    const col = getEventColor(ev);
    const hourEl = gridEl.querySelector(`.day-col[data-hour="${sh}"]`);
    if (hourEl) {
      const block = document.createElement('div');
      block.className = 'event-block';
      block.style.cssText = `background:${col};top:${topPx}px;height:${height}px;position:absolute;left:4px;right:4px;z-index:1`;
      block.innerHTML = `<span>${ev.title}</span><span class="eb-time">${ev.startTime}${ev.endTime?'–'+ev.endTime:''}</span>`;
      block.onclick = () => App.openEventDetail(ev.id, ev.date);
      hourEl.style.position = 'relative';
      hourEl.appendChild(block);
    }
  }

  // Now-line
  const nowD = new Date();
  if (fmt(nowD) === ds) {
    const hourEl = gridEl.querySelector(`.day-col[data-hour="${nowD.getHours()}"]`);
    if (hourEl) {
      const nl = document.createElement('div');
      nl.className = 'now-line';
      nl.style.cssText = `top:${nowD.getMinutes()/60*48}px;position:absolute;left:0;right:0`;
      nl.innerHTML = '<div class="now-dot"></div>';
      hourEl.style.position = 'relative';
      hourEl.appendChild(nl);
    }
  }

  setTimeout(() => {
    const wrap = document.querySelector('#view-tag .time-scroll-wrap');
    if (wrap) wrap.scrollTop = 8 * 48;
  }, 50);
}

// ════════════════════════════════════════════════════════════════
//  RENDER: EVENT CARD (for lists)
// ════════════════════════════════════════════════════════════════

function renderEventCard(ev, showDate = false) {
  const col = getEventColor(ev);
  const members = (ev.memberIds || []).filter(id => id !== 'all');
  const memberChips = members.length > 0
    ? members.map(id => {
        const m = getMember(id);
        if (!m) return '';
        return `<span class="member-chip" style="background:${m.color}">${m.name}</span>`;
      }).join('')
    : (ev.memberIds && ev.memberIds[0] === 'all'
      ? '<span class="member-chip" style="background:#4361ee">Alle</span>'
      : '');

  let meta = '';
  if (showDate) meta += formatDisplayShort(ev.date) + ' ';
  if (ev.startTime) meta += `${ev.startTime}${ev.endTime ? ' – '+ev.endTime : ''}`;
  if (ev.location) meta += (meta ? ' · ' : '') + `📍 ${ev.location}`;
  if (ev.type === 'birthday') {
    const birthDateStr = ev._originalDate || ev.date;
    const displayYear  = ev._birthdayYear || new Date().getFullYear();
    const age = calcAge(birthDateStr, displayYear);
    if (age != null && age > 0) meta += ` · ${age} Jahre`;
  }

  return `<div class="event-card" onclick="App.openEventDetail('${ev.id}','${ev.date}')">
    <div class="event-card-bar" style="background:${col}"></div>
    <div class="event-card-body">
      <div class="event-card-title">${ev.type==='birthday'?'🎂 ':''}${ev.title}</div>
      ${meta ? `<div class="event-card-meta">${meta}</div>` : ''}
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
  if (filter === 'offen') todos = todos.filter(e => !e.completed);
  if (filter === 'erledigt') todos = todos.filter(e => e.completed);

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

  setHTML('todo-list', todos.map(ev => {
    const col = getEventColor(ev);
    const members = (ev.memberIds || []).filter(id => id !== 'all');
    const memberChips = members.map(id => {
      const m = getMember(id);
      return m ? `<span class="member-chip" style="background:${m.color}">${m.name}</span>` : '';
    }).join('');

    let meta = '';
    if (ev.date) meta += formatDisplayShort(ev.date);

    return `<div class="event-card${ev.completed ? ' completed' : ''}">
      <div class="todo-check-wrap">
        <div class="todo-check${ev.completed ? ' done' : ''}" onclick="App.toggleTodo('${ev.id}',event)"></div>
      </div>
      <div class="event-card-body" onclick="App.openEventDetail('${ev.id}','${ev.date||today()}')">
        <div class="event-card-title">${ev.title}</div>
        ${meta ? `<div class="event-card-meta">${meta}</div>` : ''}
        ${memberChips ? `<div class="event-card-members">${memberChips}</div>` : ''}
      </div>
    </div>`;
  }).join(''));
}

// ════════════════════════════════════════════════════════════════
//  RENDER: BIRTHDAYS
// ════════════════════════════════════════════════════════════════

function renderBirthdays() {
  const birthdays = state.events.filter(e => e.type === 'birthday');
  if (birthdays.length === 0) {
    setHTML('birthday-list', `<p style="text-align:center;color:var(--text-2);margin-top:32px;font-size:.95rem">Noch keine Geburtstage eingetragen</p>`);
    return;
  }

  const todayD = parseDate(today());
  const thisYear = todayD.getFullYear();

  const sorted = birthdays.map(ev => {
    const base = parseDate(ev.date);
    let thisYearDate = new Date(thisYear, base.getMonth(), base.getDate());
    if (thisYearDate < todayD) thisYearDate = new Date(thisYear+1, base.getMonth(), base.getDate());
    const daysLeft = Math.round((thisYearDate - todayD) / 86400000);
    const age = (base.getFullYear() && base.getFullYear() > 1900)
      ? thisYearDate.getFullYear() - base.getFullYear()
      : null;
    return { ...ev, nextDate: fmt(thisYearDate), daysLeft, age };
  }).sort((a,b) => a.daysLeft - b.daysLeft);

  setHTML('birthday-list', sorted.map(ev => {
    const init = ev.title ? ev.title[0].toUpperCase() : '?';
    const ageStr = ev.age ? ` · ${ev.age} Jahre` : '';
    const soonStr = ev.daysLeft <= 7
      ? `<span class="birthday-soon">${ev.daysLeft === 0 ? 'Heute! 🎉' : 'In '+ev.daysLeft+' Tagen'}</span>`
      : '';
    return `<div class="birthday-card" onclick="App.openEventDetail('${ev.id}','${ev.date}')">
      <div class="birthday-avatar">${init}</div>
      <div class="birthday-info">
        <div class="birthday-name">${ev.title}${ageStr}</div>
        <div class="birthday-date">${formatBirthdayDate(ev.date)}</div>
        ${soonStr}
      </div>
      <div class="birthday-age">${ev.daysLeft === 0 ? '🎂' : ev.daysLeft+'d'}</div>
    </div>`;
  }).join(''));
}

// ════════════════════════════════════════════════════════════════
//  RENDER: SETTINGS
// ════════════════════════════════════════════════════════════════

function renderSettings() {
  if (!state.family) return;

  // Family code
  setHTML('family-code-display', state.familyId);
  const pairingEl = document.getElementById('pairing-code-big');
  if (pairingEl) pairingEl.textContent = state.familyId;

  // Family name
  setHTML('family-name-display', state.family.name || '');

  // Members
  const members = state.family.members || [];
  if (members.length === 0) {
    setHTML('members-list', '<p style="color:var(--text-2);font-size:.9rem">Noch keine Mitglieder</p>');
  } else {
    setHTML('members-list', members.map(m => `
      <div class="member-row">
        <div class="member-dot" style="background:${m.color}">${initials(m.name)}</div>
        <div class="member-name-text">${m.name}</div>
        <button class="member-edit-btn" onclick="App.openEditMember('${m.id}')">Bearbeiten</button>
      </div>
    `).join(''));
  }
}

// ════════════════════════════════════════════════════════════════
//  RENDER: ALL
// ════════════════════════════════════════════════════════════════

function renderCalendar() {
  if (state.currentTab !== 'kalender') return;
  renderHeaderTitle();
  if (state.currentView === 'monat') renderMonthView();
  else if (state.currentView === 'woche') renderWeekView();
  else renderDayView();
}

function renderAll() {
  renderCalendar();
  renderTodos();
  renderBirthdays();
  renderSettings();
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
  el.classList.remove('open');
  el.addEventListener('transitionend', () => el.classList.add('hidden'), { once: true });
  // Check if other sheets still open
  const anyOpen = document.querySelectorAll('.bottom-sheet.open').length > 0;
  if (!anyOpen) {
    hideEl('overlay-backdrop');
    document.body.style.overflow = '';
  }
}

function closeAllSheets() {
  document.querySelectorAll('.bottom-sheet.open').forEach(el => {
    el.classList.remove('open');
    el.addEventListener('transitionend', () => el.classList.add('hidden'), { once: true });
  });
  hideEl('overlay-backdrop');
  document.body.style.overflow = '';
}

// ════════════════════════════════════════════════════════════════
//  MEMBER FORM
// ════════════════════════════════════════════════════════════════

let selectedColor = MEMBER_COLORS[0];

function openAddMember() {
  state.editingMemberId = null;
  document.getElementById('sheet-member-title').textContent = 'Mitglied hinzufügen';
  document.getElementById('member-name').value = '';
  selectedColor = MEMBER_COLORS[0];
  renderColorPicker();
  hideError('member-form-error');
  openSheet('sheet-member');
}

function openEditMember(id) {
  const m = getMember(id);
  if (!m) return;
  state.editingMemberId = id;
  document.getElementById('sheet-member-title').textContent = 'Mitglied bearbeiten';
  document.getElementById('member-name').value = m.name;
  selectedColor = m.color;
  renderColorPicker();
  hideError('member-form-error');
  openSheet('sheet-member');
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

async function saveMember() {
  const name = document.getElementById('member-name').value.trim();
  if (!name) { showError('member-form-error', 'Bitte Namen eingeben'); return; }

  const members = [...(state.family.members || [])];
  if (state.editingMemberId) {
    const idx = members.findIndex(m => m.id === state.editingMemberId);
    if (idx >= 0) members[idx] = { ...members[idx], name, color: selectedColor };
  } else {
    members.push({ id: genId(), name, color: selectedColor });
  }

  try {
    await dbUpdateFamily({ members });
    closeSheet('sheet-member');
  } catch (e) {
    showError('member-form-error', 'Fehler beim Speichern: ' + e.message);
  }
}

// ════════════════════════════════════════════════════════════════
//  EVENT FORM
// ════════════════════════════════════════════════════════════════

let currentEventType = 'termin';

function openAddEvent(type = 'termin', prefillDate = null) {
  state.editingEventId = null;
  currentEventType = type;

  document.getElementById('sheet-event-title').textContent =
    type === 'todo' ? 'Todo hinzufügen' :
    type === 'geburtstag' ? 'Geburtstag hinzufügen' : 'Termin hinzufügen';

  document.getElementById('event-title').value = '';
  document.getElementById('event-date').value = prefillDate || today();
  document.getElementById('event-has-time').checked = false;
  document.getElementById('event-time').value = '';
  document.getElementById('event-end-time').value = '';
  document.getElementById('event-location').value = '';
  document.getElementById('event-recurring').value = 'none';
  document.getElementById('event-description').value = '';
  document.getElementById('event-birthday-person').value = '';
  document.getElementById('recurring-interval').value = '1';
  document.getElementById('recurring-end-type').value = 'never';
  hideEl('time-inputs');
  hideEl('recurring-options');
  hideEl('recurring-end-date-wrap');
  hideEl('recurring-end-count-wrap');
  hideError('event-form-error');

  // Set type buttons
  document.querySelectorAll('.type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === type));

  // Show/hide fields based on type
  applyEventTypeUI(type);

  // Members selector
  renderMembersSelector([]);

  // Prefill day for weekday picker
  if (prefillDate) {
    const d = parseDate(prefillDate);
    const dow = (d.getDay() + 6) % 7 + 1; // Mon=1..Sun=0
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
  document.getElementById('event-date').value = dateStr || ev.date || today();
  document.getElementById('event-location').value = ev.location || '';
  document.getElementById('event-description').value = ev.description || '';
  document.getElementById('event-birthday-person').value = ev.birthdayPerson || '';

  const hasTime = !!ev.startTime;
  document.getElementById('event-has-time').checked = hasTime;
  if (hasTime) {
    showEl('time-inputs');
    document.getElementById('event-time').value = ev.startTime || '';
    document.getElementById('event-end-time').value = ev.endTime || '';
  } else {
    hideEl('time-inputs');
  }

  // Recurring
  const rec = ev.recurring;
  if (rec && rec.type !== 'none') {
    document.getElementById('event-recurring').value = rec.type;
    document.getElementById('recurring-interval').value = rec.interval || 1;
    showEl('recurring-options');
    updateRecurringUnitLabel(rec.type);
    // End type
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
    // Weekdays
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

  // Type buttons
  document.querySelectorAll('.type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === ev.type));
  applyEventTypeUI(ev.type);

  // Members
  renderMembersSelector(ev.memberIds || []);
  hideError('event-form-error');
  openSheet('sheet-event');
}

function applyEventTypeUI(type) {
  currentEventType = type;
  const isBirthday = type === 'geburtstag';
  const isTodo     = type === 'todo';

  // Birthday-person-group is removed from flow; title serves as person name
  hideEl('birthday-person-group');
  const titleInput = document.getElementById('event-title');
  if (titleInput) {
    titleInput.placeholder = isBirthday ? 'Name der Person' : (isTodo ? 'Aufgabe' : 'Titel');
  }
  document.getElementById('time-group').classList.toggle('hidden', isBirthday);
  document.getElementById('location-group').classList.toggle('hidden', isBirthday || isTodo);
  document.getElementById('recurring-group').classList.toggle('hidden', isBirthday || isTodo);
  document.getElementById('event-type-group').classList.toggle('hidden', !!state.editingEventId);
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

  // "Alle" option
  html += `<div class="member-select-row" onclick="App.toggleAllMembers()">
    <div class="member-select-check${isAll ? ' checked' : ''}" id="check-all"></div>
    <div class="member-select-dot" style="background:#4361ee">A</div>
    <div class="member-select-name">Alle</div>
  </div>`;

  for (const m of members) {
    const sel = !isAll && selectedIds.includes(m.id);
    html += `<div class="member-select-row" onclick="App.toggleMember('${m.id}')">
      <div class="member-select-check${sel ? ' checked' : ''}" id="check-${m.id}"></div>
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
    const members = state.family?.members || [];
    members.forEach(m => {
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
  // If nothing selected, revert to all
  const members = state.family?.members || [];
  const anySelected = members.some(m => {
    const c = document.getElementById(`check-${m.id}`);
    return c && c.classList.contains('checked');
  });
  if (!anySelected && allCheck) allCheck.classList.add('checked');
}

async function saveEvent() {
  const title = document.getElementById('event-title').value.trim();
  if (!title) { showError('event-form-error', 'Bitte Titel eingeben'); return; }

  const dateVal = document.getElementById('event-date').value;
  if (!dateVal) { showError('event-form-error', 'Bitte Datum wählen'); return; }

  const hasTime = document.getElementById('event-has-time').checked;
  const startTime = hasTime ? document.getElementById('event-time').value : null;
  const endTime   = hasTime ? document.getElementById('event-end-time').value : null;
  const location  = document.getElementById('event-location').value.trim() || null;
  const desc      = document.getElementById('event-description').value.trim() || null;
  const memberIds = getSelectedMemberIds();

  // Recurring
  const recType = currentEventType === 'termin' ? document.getElementById('event-recurring').value : 'none';
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

  const data = {
    type: currentEventType,
    title,
    date: dateVal,
    startTime: startTime || null,
    endTime: endTime || null,
    location,
    description: desc,
    memberIds,
    recurring: recurring || { type: 'none' },
    completed: false,
  };

  if (currentEventType === 'geburtstag') {
    data.birthdayPerson = document.getElementById('event-birthday-person').value.trim() || null;
    data.recurring = { type: 'yearly', interval: 1 };
  }

  if (state.editingEventId) data.id = state.editingEventId;

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
    await dbSaveEvent(data);
    closeSheet('sheet-event');
  } catch (e) {
    showError('event-form-error', 'Fehler: ' + e.message);
  }
}

// ════════════════════════════════════════════════════════════════
//  EVENT DETAIL
// ════════════════════════════════════════════════════════════════

let detailEventId = null;
let detailEventDate = null;

function openEventDetail(id, dateStr) {
  let ev = state.events.find(e => e.id === id);
  if (!ev) {
    // might be a recurring instance — find base
    ev = state.events.find(e => e.id === id);
  }
  if (!ev) return;

  detailEventId = id;
  detailEventDate = dateStr || ev.date;

  const typeLabels = { termin: 'Termin', todo: 'Todo', geburtstag: 'Geburtstag' };
  const typeColors = { termin: '#4361ee', todo: '#22c55e', geburtstag: '#f59e0b' };
  const col = getEventColor(ev);

  document.getElementById('detail-sheet-title').textContent = typeLabels[ev.type] || 'Termin';

  let html = `<div class="detail-title">${ev.type==='birthday'?'🎂 ':''}${ev.title}</div>`;

  // Date
  html += `<div class="detail-meta-row">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
    ${formatDisplay(detailEventDate)}
  </div>`;

  // Time
  if (ev.startTime) {
    html += `<div class="detail-meta-row">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      ${ev.startTime}${ev.endTime ? ' – ' + ev.endTime : ''}
    </div>`;
  }

  // Location
  if (ev.location) {
    html += `<div class="detail-meta-row">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
      ${ev.location}
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
      : members.map(id => {
          const m = getMember(id);
          return m ? `<span class="member-chip" style="background:${m.color}">${m.name}</span>` : '';
        }).join('');
    html += `<div class="detail-members-section">
      <div class="detail-members-label">Personen</div>
      <div class="event-card-members">${chips}</div>
    </div>`;
  }

  // Description
  if (ev.description) {
    html += `<div style="margin-top:14px;padding:12px;background:var(--bg);border-radius:8px;font-size:.9rem;color:var(--text-2)">${ev.description}</div>`;
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
  closeSheet('sheet-event-detail');
  setTimeout(() => openEditEvent(detailEventId, detailEventDate), 350);
}

function deleteCurrentEvent() {
  if (!detailEventId) return;
  const ev = state.events.find(e => e.id === detailEventId);
  if (!ev) return;

  if (ev.recurring && ev.recurring.type !== 'none') {
    state.editingEventData = { id: detailEventId, date: detailEventDate };
    state.recurringAction = 'delete';
    document.getElementById('recurring-action-title').textContent = 'Serientermin löschen';
    document.getElementById('recurring-action-question').textContent = 'Welche Termine sollen gelöscht werden?';
    closeSheet('sheet-event-detail');
    openSheet('sheet-recurring-action');
    return;
  }

  if (confirm(`"${ev.title}" löschen?`)) {
    dbDeleteEvent(detailEventId).then(() => closeSheet('sheet-event-detail'));
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
      await dbAddException(evId, instanceDate);
    } else if (scope === 'following') {
      // Set end date to day before
      const endDate = fmt(addDays(parseDate(instanceDate), -1));
      await db.collection('families').doc(state.familyId).collection('events').doc(evId)
        .update({ 'recurring.endDate': endDate });
    } else {
      await dbDeleteEvent(evId);
    }
  } else if (action === 'edit') {
    const newData = state.editingEventData;
    if (scope === 'all') {
      await dbSaveEvent(newData);
    } else if (scope === 'one') {
      // Create exception on original + new non-recurring event for this date
      await dbAddException(evId, newData.date);
      const { id: _, ...rest } = newData;
      rest.recurring = { type: 'none' };
      await dbSaveEvent(rest);
    } else {
      // following: shorten original series, create new series from this date
      const endDate = fmt(addDays(parseDate(newData.date), -1));
      await db.collection('families').doc(state.familyId).collection('events').doc(evId)
        .update({ 'recurring.endDate': endDate });
      const { id: _, ...rest } = newData;
      await dbSaveEvent(rest);
    }
  }

  state.recurringAction = null;
  state.editingEventData = null;
}

async function toggleTodo(id, e) {
  if (e) e.stopPropagation();
  const ev = state.events.find(e2 => e2.id === id);
  if (!ev) return;
  await db.collection('families').doc(state.familyId).collection('events')
    .doc(id).update({ completed: !ev.completed });
}

async function toggleTodoFromDetail(id) {
  const ev = state.events.find(e => e.id === id);
  if (!ev) return;
  await db.collection('families').doc(state.familyId).collection('events')
    .doc(id).update({ completed: !ev.completed });
  closeSheet('sheet-event-detail');
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
  setHTML('pairing-code-big', state.familyId || '------');
  openSheet('sheet-pairing');
}

async function copyFamilyCode() {
  try {
    await navigator.clipboard.writeText(state.familyId);
    const btn = document.querySelector('#sheet-pairing .btn-secondary');
    if (btn) { btn.textContent = 'Kopiert! ✓'; setTimeout(() => btn.textContent = 'Code kopieren', 2000); }
  } catch {
    alert('Code: ' + state.familyId);
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
  const name = document.getElementById('input-family-name').value.trim();
  const member = document.getElementById('input-first-member-name').value.trim();
  if (!name) { showError('setup-error', 'Bitte Familienname eingeben'); return; }
  if (!member) { showError('setup-error', 'Bitte deinen Namen eingeben'); return; }

  try {
    const code = await dbCreateFamily(name, member);
    localStorage.setItem('familyId', code);
    startApp(code);
  } catch (e) {
    showError('setup-error', 'Fehler: ' + e.message);
  }
}

async function joinFamily() {
  const code = document.getElementById('input-join-code').value.trim().toUpperCase();
  if (code.length !== 6) { showError('join-error', 'Code muss 6 Zeichen haben'); return; }

  try {
    const familyId = await dbJoinFamily(code);
    localStorage.setItem('familyId', familyId);
    startApp(familyId);
  } catch (e) {
    showError('join-error', e.message || 'Fehler beim Beitreten');
  }
}

// ════════════════════════════════════════════════════════════════
//  APP START
// ════════════════════════════════════════════════════════════════

function startApp(familyId) {
  state.familyId = familyId;
  hideEl('screen-loading');
  hideEl('screen-setup');
  showEl('screen-app');
  subscribeFamily(familyId);
  subscribeEvents(familyId);
  renderHeaderTitle();
  renderCalendar();
}

// ════════════════════════════════════════════════════════════════
//  PUBLIC API (called from HTML onclick)
// ════════════════════════════════════════════════════════════════

const App = {
  showSetupChoice, showSetupCreate, showSetupJoin,
  createFamily, joinFamily,
  setView, setTab,
  navigatePrev, navigateNext, goToToday, goToDay,
  selectDay, closeDayPanel,
  openAddEvent, openEditEvent, saveEvent,
  openEventDetail, editCurrentEvent, deleteCurrentEvent,
  applyRecurringAction,
  toggleTodo, toggleTodoFromDetail,
  setTodoFilter,
  openAddMember, openEditMember, saveMember,
  selectColor,
  toggleAllMembers, toggleMember,
  toggleTime, toggleRecurringOptions, toggleRecurringEnd,
  setEventType,
  openPairing, copyFamilyCode, confirmLeave,
  closeSheet, closeAllSheets,
};

// ════════════════════════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════════════════════════

(function init() {
  if (!initFirebase()) {
    document.getElementById('screen-loading').innerHTML =
      '<p style="color:white;padding:24px;text-align:center">Firebase-Konfiguration fehlt.<br>Bitte js/firebase-config.js ausfüllen.</p>';
    return;
  }

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  const savedId = localStorage.getItem('familyId');
  if (savedId) {
    // Verify family still exists
    db.collection('families').doc(savedId).get().then(doc => {
      if (doc.exists) {
        startApp(savedId);
      } else {
        localStorage.removeItem('familyId');
        showSetup();
      }
    }).catch(() => {
      // Offline: trust the saved ID and try anyway
      startApp(savedId);
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
