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
  searchActive: false,
  searchQuery: '',
  holidays: {},
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

function startOfWeek(d) {
  const day = d.getDay();
  const diff = (day + 6) % 7;
  return addDays(d, -diff);
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
        renderAll();
        const land = state.family.bundesland;
        if (land) {
          const yr = new Date().getFullYear();
          fetchHolidays(yr);
          fetchHolidays(yr + 1);
        }
      } else {
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
    const label = `${icon}${ev.title}`;

    // Pt 12: multi-day spanning indicator
    let spanCls = '';
    if (ev._multiDay) {
      if (ev._multiDayStart === ds) spanCls = ' span-start';
      else if (ev._multiDayEnd === ds) spanCls = ' span-end';
      else spanCls = ' span-mid';
    }

    chipsHtml += `<div class="cell-event-chip${spanCls}" style="background:${bg}" title="${ev.title}" onclick="event.stopPropagation();App.openEventDetail('${ev.id}','${ev.date}')">${label}</div>`;
  }
  if (sorted.length > MAX) {
    chipsHtml += `<div class="cell-more">+${sorted.length - MAX}</div>`;
  }

  // Pt 7: Feiertag badge
  const holidayHtml = holiday ? `<div class="cell-holiday" title="${holiday}">${holiday}</div>` : '';

  return `<div class="${cls}" onclick="App.selectDay('${ds}')">
    <div class="cell-day">${dayNum}</div>
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
      return `<div class="cell-event-chip${ev._multiDay?' multi-day-chip':''}" style="background:${bg};margin:1px;cursor:pointer;${spanStyle}" onclick="App.openEventDetail('${ev.id}','${ev.date}')">${icon}${ev.title}</div>`;
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
      // Pt 5: show description snippet
      const noteHtml = ev.description ? `<span class="eb-note">${ev.description}</span>` : '';
      colHtml += `<div class="event-block" style="background:${bg};top:${top}px;height:${height}px" onclick="event.stopPropagation();App.openEventDetail('${ev.id}','${ev.date}')">
        <span>${ev.type==='geburtstag'?'🎁 ':''}${ev.title}</span>
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
  // Pt 13: exclude todos
  const events = getEventsForDay(ds).filter(e => e.type !== 'todo').filter(matchesPersonFilter);
  // Pt 2.2 / 1 Bug fix: only valid HH:MM startTime
  const timed  = events.filter(e => e.startTime && e.startTime.length === 5);
  const allDay = events.filter(e => !e.startTime);
  const H = 48;

  const alldayEl = document.getElementById('day-allday');
  // Pt 7: add holidays to all-day area
  const holName = getHolidayName(ds);
  const holChip = holName ? `<div class="cell-event-chip holiday-chip">${holName}</div>` : '';
  alldayEl.innerHTML = holChip + (allDay.length > 0
    ? allDay.map(ev => {
        const bg = getEventBg(ev);
        return `<div class="cell-event-chip" style="background:${bg};margin:2px;font-size:.8rem;cursor:pointer" onclick="App.openEventDetail('${ev.id}','${ev.date}')">${ev.type==='geburtstag'?'🎁 ':''}${ev.title}</div>`;
      }).join('')
    : '');

  let timesHtml = '';
  let colHtml   = '';
  for (let h = 0; h < 24; h++) {
    timesHtml += `<div class="wg-time-label">${h > 0 ? h+':00' : ''}</div>`;
    // Pt 8: click slot to create event
    colHtml += `<div class="wg-hour" onclick="App.openAddEvent('termin','${ds}','${String(h).padStart(2,'0')}:00')"></div>`;
  }

  for (const ev of timed) {
    const [sh, sm] = ev.startTime.split(':').map(Number);
    const [eh, em] = (ev.endTime || `${String(sh+1).padStart(2,'0')}:00`).split(':').map(Number);
    const top    = sh * H + sm / 60 * H;
    const height = Math.max(22, (eh-sh)*H + (em-sm)/60*H);
    const bg     = getEventBg(ev);
    // Pt 5: description snippet
    const noteHtml = ev.description ? `<span class="eb-note">${ev.description}</span>` : '';
    colHtml += `<div class="event-block" style="background:${bg};top:${top}px;height:${height}px" onclick="event.stopPropagation();App.openEventDetail('${ev.id}','${ev.date}')">
      <span>${ev.type==='geburtstag'?'🎁 ':''}${ev.title}</span>
      <span class="eb-time">${ev.startTime}${ev.endTime?'–'+ev.endTime:''}</span>
      ${noteHtml}
    </div>`;
  }

  // Pt 2.1/2.2 Bug fix: now-line outside column
  let nowLineHtml = '';
  const nowD = new Date();
  if (fmt(nowD) === ds) {
    const nowTop = nowD.getHours() * H + nowD.getMinutes() / 60 * H;
    nowLineHtml = `<div class="week-now-line" style="top:${nowTop}px"><div class="now-dot"></div></div>`;
  }

  setHTML('day-grid',
    `<div class="wg-wrap"><div class="wg-times">${timesHtml}</div><div class="wg-days" style="position:relative"><div class="wg-day">${colHtml}</div>${nowLineHtml}</div></div>`);

  setTimeout(() => {
    const wrap = document.querySelector('#view-tag .time-scroll-wrap');
    if (wrap) wrap.scrollTop = 8 * H;
  }, 150);
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

  let meta = '';
  if (ev.endDate && ev.endDate !== ev.date) {
    meta += `${formatDisplayShort(ev.date)} – ${formatDisplayShort(ev.endDate)}`;
  } else if (showDate) {
    meta += formatDisplayShort(ev.date) + ' ';
  }
  if (ev.startTime) meta += ` ${ev.startTime}${ev.endTime ? ' – '+ev.endTime : ''}`;
  if (ev.location) meta += (meta ? ' · ' : '') + `📍 ${ev.location}`;
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

  return `<div class="event-card" onclick="App.openEventDetail('${ev.id}','${ev.date}')">
    <div class="event-card-bar" style="background:${bg}"></div>
    <div class="event-card-body">
      <div class="event-card-title">${icon}${ev.title}</div>
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

  setHTML('todo-list', todos.map(ev => {
    const bg = getEventBg(ev);
    const members = (ev.memberIds || []).filter(id => id !== 'all');
    const memberChips = members.map(id => {
      const m = getMember(id);
      return m ? `<span class="member-chip" style="background:${m.color}">${getMemberAvatar(m,'sm')}<span style="margin-left:3px">${m.name}</span></span>` : '';
    }).join('');

    // Pt 14: show endDate in todo card
    let meta = '';
    if (ev.date) meta += formatDisplayShort(ev.date);
    if (ev.endDate) meta += (meta ? ' · ' : '') + `Bis: ${formatDisplayShort(ev.endDate)}`;

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
  const results = state.events.filter(e =>
    (e.title || '').toLowerCase().includes(q) ||
    (e.description || '').toLowerCase().includes(q) ||
    (e.location || '').toLowerCase().includes(q)
  ).slice(0, 20);

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
  el.classList.remove('open');
  el.addEventListener('transitionend', () => el.classList.add('hidden'), { once: true });
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

  const members = [...(state.family.members || [])];
  if (state.editingMemberId) {
    const idx = members.findIndex(m => m.id === state.editingMemberId);
    if (idx >= 0) {
      members[idx] = { ...members[idx], name, color: selectedColor };
      if (currentMemberPhoto !== null) {
        if (currentMemberPhoto === '') {
          delete members[idx].photo;
        } else {
          members[idx].photo = currentMemberPhoto;
        }
      }
    }
  } else {
    const newMember = { id: genId(), name, color: selectedColor };
    if (currentMemberPhoto) newMember.photo = currentMemberPhoto;
    members.push(newMember);
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

// Pt 8: prefillTime parameter added
function openAddEvent(type = 'termin', prefillDate = null, prefillTime = null) {
  state.editingEventId = null;
  currentEventType = type;

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
  document.getElementById('event-date').value = dateStr || ev.date || today();

  // Bug 15/23 fix: always load endDate from the specific event being edited
  const endDateEl2 = document.getElementById('event-end-date');
  if (endDateEl2) endDateEl2.value = (ev.type !== 'geburtstag' ? ev.endDate || '' : '');

  document.getElementById('event-location').value = ev.location || '';
  document.getElementById('event-description').value = ev.description || '';
  document.getElementById('event-birthday-person').value = ev.birthdayPerson || '';

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
  document.getElementById('time-group').classList.toggle('hidden', isBirthday || isTodo);
  document.getElementById('location-group').classList.toggle('hidden', isBirthday || isTodo);
  document.getElementById('recurring-group').classList.toggle('hidden', isTodo);
  document.getElementById('event-type-group').classList.toggle('hidden', !!state.editingEventId);

  // Pt 10.2: hide endDate for birthdays
  const edg = document.getElementById('end-date-group');
  if (edg) edg.classList.toggle('hidden', isBirthday);

  // Pt 6: show no-year checkbox only for birthdays
  const noYearGroup = document.getElementById('no-year-group');
  if (noYearGroup) noYearGroup.classList.toggle('hidden', !isBirthday);
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

  const recType = (currentEventType === 'termin' || currentEventType === 'geburtstag')
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
  };

  if (currentEventType === 'geburtstag') {
    data.recurring = { type: 'yearly', interval: 1 };
    data.endDate = null; // Pt 10.2
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
  let html = `<div class="detail-color-bar" style="background:${bg}"></div>`;
  html += `<div class="detail-title">${icon}${ev.title}</div>`;

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
      : members.map(mid => {
          const m = getMember(mid);
          return m ? `<span class="member-chip" style="background:${m.color}">${getMemberAvatar(m,'sm')}<span style="margin-left:4px">${m.name}</span></span>` : '';
        }).join('');
    html += `<div class="detail-members-section">
      <div class="detail-members-label">Personen</div>
      <div class="event-card-members">${chips}</div>
    </div>`;
  }

  // Pt 25.b: todo/termin description/note
  if (ev.description && ev.type !== 'geburtstag') {
    html += `<div style="margin-top:14px;padding:12px;background:var(--bg);border-radius:8px;font-size:.9rem;color:var(--text-2);white-space:pre-wrap">${ev.description}</div>`;
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
      await dbAddException(evId, newData.date);
      const { id: _, ...rest } = newData;
      rest.recurring = { type: 'none' };
      await dbSaveEvent(rest);
    } else {
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
  if (statusEl) { statusEl.textContent = 'Importiere...'; statusEl.classList.remove('hidden'); }
  try {
    const text = await file.text();
    const events = parseICS(text);
    let count = 0;
    for (const ev of events) {
      try { await dbSaveEvent(ev); count++; } catch {}
    }
    if (statusEl) statusEl.textContent = `✓ ${count} Termine importiert`;
    evt.target.value = '';
    setTimeout(() => statusEl?.classList.add('hidden'), 4000);
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Fehler beim Import';
  }
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
  const name   = document.getElementById('input-family-name').value.trim();
  const member = document.getElementById('input-first-member-name').value.trim();
  if (!name)   { showError('setup-error', 'Bitte Familienname eingeben'); return; }
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
  // Pt 17: accept 6 or 12 chars (strip hyphens)
  const code = document.getElementById('input-join-code').value.trim().toUpperCase().replace(/-/g, '');
  if (code.length !== 6 && code.length !== 12) {
    showError('join-error', 'Bitte gültigen Code eingeben (6 oder 12 Zeichen)');
    return;
  }

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
//  PUBLIC API
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
  // Pt 19: member photo
  handleMemberPhotoInput, removeMemberPhoto,
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

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

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
        startApp(savedId);
      } else {
        localStorage.removeItem('familyId');
        showSetup();
      }
    }).catch(() => {
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
