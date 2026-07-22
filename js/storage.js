// storage.js — the ONLY module allowed to touch persistence (localStorage today).
//
// Contract — every function is async and returns a Promise, so a network-backed
// implementation (Supabase, etc.) can replace the internals of THIS FILE with
// zero changes to any caller:
//
//   saveEntry(entry)    entry:    { date:'YYYY-MM-DD', weight:number>0, unit:'lbs'|'kg', note?:string }
//                       upserts by date — one entry per day.
//   getEntry(date)      -> entry | null
//   getAllEntries()     -> entry[] sorted by date ascending
//   deleteEntry(date)   -> true if an entry existed and was removed
//   saveGoal(goal)      goal: { targetWeight:number>0, unit:'lbs'|'kg', targetDate?:'YYYY-MM-DD'|null } | null
//                       saveGoal(null) clears the goal.
//   getGoal()           -> goal | null
//   saveSettings(s)     s: { unit:'lbs'|'kg' }
//   getSettings()       -> settings (defaults to { unit:'lbs' } if never set)
//   exportCSV()         -> CSV string: date,weight,unit,note (RFC 4180 quoting)
//
// No other file may read or write localStorage/IndexedDB.

const NS = 'weight-tracker';
const KEYS = {
  entries: `${NS}:entries`,
  goal: `${NS}:goal`,
  settings: `${NS}:settings`,
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_UNITS = ['lbs', 'kg'];
const DEFAULT_SETTINGS = { unit: 'lbs' };

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback; // corrupt/unavailable storage degrades to the fallback
  }
}

function isValidEntry(e) {
  return (
    e !== null &&
    typeof e === 'object' &&
    typeof e.date === 'string' &&
    DATE_RE.test(e.date) &&
    typeof e.weight === 'number' &&
    Number.isFinite(e.weight) &&
    e.weight > 0 &&
    VALID_UNITS.includes(e.unit)
  );
}

// Entries map, shape-validated: parseable-but-wrong-shape data (schema drift,
// hand edits, another same-origin page writing our key) degrades to sane data
// instead of throwing deep inside a render.
function readEntriesMap() {
  const raw = readJSON(KEYS.entries, {});
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const clean = {};
  for (const [date, entry] of Object.entries(raw)) {
    if (isValidEntry(entry) && entry.date === date) {
      clean[date] = { ...entry, note: typeof entry.note === 'string' ? entry.note : '' };
    }
  }
  return clean;
}

function writeJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function assertDate(date, what = 'date') {
  if (typeof date !== 'string' || !DATE_RE.test(date)) {
    throw new TypeError(`${what} must be a 'YYYY-MM-DD' string, got: ${JSON.stringify(date)}`);
  }
}

function assertWeight(weight, what = 'weight') {
  if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
    throw new TypeError(`${what} must be a finite number > 0, got: ${JSON.stringify(weight)}`);
  }
}

function assertUnit(unit) {
  if (!VALID_UNITS.includes(unit)) {
    throw new TypeError(`unit must be 'lbs' or 'kg', got: ${JSON.stringify(unit)}`);
  }
}

export async function saveEntry(entry) {
  assertDate(entry?.date);
  assertWeight(entry?.weight);
  assertUnit(entry?.unit);
  const clean = {
    date: entry.date,
    weight: entry.weight,
    unit: entry.unit,
    note: typeof entry.note === 'string' ? entry.note.trim() : '',
  };
  const entries = readEntriesMap();
  entries[clean.date] = clean;
  writeJSON(KEYS.entries, entries);
  return { ...clean };
}

export async function getEntry(date) {
  assertDate(date);
  const entry = readEntriesMap()[date];
  return entry ? { ...entry } : null;
}

export async function getAllEntries() {
  return Object.values(readEntriesMap())
    .map((e) => ({ ...e }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export async function deleteEntry(date) {
  assertDate(date);
  const entries = readEntriesMap();
  if (!(date in entries)) return false;
  delete entries[date];
  writeJSON(KEYS.entries, entries);
  return true;
}

export async function saveGoal(goal) {
  if (goal === null) {
    localStorage.removeItem(KEYS.goal);
    return null;
  }
  assertWeight(goal?.targetWeight, 'targetWeight');
  assertUnit(goal?.unit);
  if (goal.targetDate != null) assertDate(goal.targetDate, 'targetDate');
  const clean = {
    targetWeight: goal.targetWeight,
    unit: goal.unit,
    targetDate: goal.targetDate ?? null,
  };
  writeJSON(KEYS.goal, clean);
  return { ...clean };
}

export async function getGoal() {
  const goal = readJSON(KEYS.goal, null);
  if (
    goal === null ||
    typeof goal !== 'object' ||
    typeof goal.targetWeight !== 'number' ||
    !Number.isFinite(goal.targetWeight) ||
    goal.targetWeight <= 0 ||
    !VALID_UNITS.includes(goal.unit)
  ) {
    return null; // wrong-shape goal degrades to "no goal", same as corrupt JSON
  }
  const targetDate =
    typeof goal.targetDate === 'string' && DATE_RE.test(goal.targetDate) ? goal.targetDate : null;
  return { targetWeight: goal.targetWeight, unit: goal.unit, targetDate };
}

export async function saveSettings(settings) {
  assertUnit(settings?.unit);
  const clean = { unit: settings.unit };
  writeJSON(KEYS.settings, clean);
  return { ...clean };
}

export async function getSettings() {
  const s = readJSON(KEYS.settings, null);
  return s && VALID_UNITS.includes(s.unit) ? { unit: s.unit } : { ...DEFAULT_SETTINGS };
}

export async function exportCSV() {
  const entries = await getAllEntries();
  const escape = (value) => {
    let s = String(value ?? '');
    // A leading = + - or @ would be read as a formula by spreadsheet apps
    // (a note like "+2 after dinner" would render as #NAME? in Excel);
    // a leading space neutralizes it without visibly changing the text.
    if (/^[=+\-@]/.test(s)) s = ' ' + s;
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const rows = entries.map((e) => [e.date, e.weight, e.unit, e.note].map(escape).join(','));
  return ['date,weight,unit,note', ...rows].join('\r\n') + '\r\n';
}
