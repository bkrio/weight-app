// storage.js — the ONLY module allowed to touch persistence (localStorage today).
//
// Contract — every function is async and returns a Promise, so a network-backed
// implementation (Supabase, etc.) can replace the internals of THIS FILE with
// zero changes to any caller:
//
//   entry shape: { date:'YYYY-MM-DD', weight:number>0|null, unit:'lbs'|'kg',
//                  note?:string, calories:int>=0|null }
//                An entry must have a weight, calories, or both (a day can be a
//                weigh-in, a calorie log, or both).
//
//   saveEntry(entry)    upserts by date — one entry per day.
//   getEntry(date)      -> entry | null
//   getAllEntries()     -> entry[] sorted by date ascending
//   deleteEntry(date)   -> true if an entry existed and was removed
//   saveGoal(goal)      goal: { targetWeight:number>0, unit:'lbs'|'kg', targetDate?:'YYYY-MM-DD'|null } | null
//                       saveGoal(null) clears the goal.
//   getGoal()           -> goal | null
//   saveSettings(s)     s: partial { unit?:'lbs'|'kg', chartRange?:string } — merged
//                       into the stored settings (unspecified fields are kept)
//   getSettings()       -> { unit:'lbs'|'kg', chartRange:string } with defaults
//   getPeriods()        -> period[] sorted by startDate ascending
//                          period: { id:string, name:string, startDate:'YYYY-MM-DD' }
//   savePeriod(period)  upserts by id (generates an id when absent) -> period
//   deletePeriod(id)    -> true if a period existed and was removed
//   exportCSV()         -> CSV string: date,weight,unit,note,calories (RFC 4180 quoting)
//   importCSV(text,opts)-> upsert entries from a CSV string (the export format).
//                          opts: { overwrite=true, dryRun=false }. Returns
//                          { imported, skipped, invalid, total }. dryRun validates
//                          without writing (for a preview/confirm).
//   markBackedUp(iso)   record that a backup happened on `iso`
//   getLastBackup()     -> 'YYYY-MM-DD' | null
//
// No other file may read or write localStorage/IndexedDB.

const NS = 'weight-tracker';
const KEYS = {
  entries: `${NS}:entries`,
  goal: `${NS}:goal`,
  settings: `${NS}:settings`,
  periods: `${NS}:periods`,
  meta: `${NS}:meta`,
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_UNITS = ['lbs', 'kg'];
const CHART_RANGE_RE = /^(1w|1m|3m|1y|all|phase:.+)$/; // duration preset or a phase id
const DEFAULT_SETTINGS = { unit: 'lbs', chartRange: '1w' };
const MAX_CALORIES = 100000; // sanity ceiling; anything at/above is a typo

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback; // corrupt/unavailable storage degrades to the fallback
  }
}

function writeJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function genId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID.
  return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// ---------- validators ----------

function validWeight(w) {
  return typeof w === 'number' && Number.isFinite(w) && w > 0;
}

function validCalories(c) {
  return typeof c === 'number' && Number.isFinite(c) && Number.isInteger(c) && c >= 0 && c < MAX_CALORIES;
}

function isValidEntry(e) {
  if (e === null || typeof e !== 'object') return false;
  if (typeof e.date !== 'string' || !DATE_RE.test(e.date)) return false;
  if (!VALID_UNITS.includes(e.unit)) return false;
  const hasW = e.weight != null;
  const hasC = e.calories != null;
  if (!hasW && !hasC) return false;             // a day must carry something
  if (hasW && !validWeight(e.weight)) return false;
  if (hasC && !validCalories(e.calories)) return false;
  return true;
}

function normalizeStoredEntry(e) {
  return {
    date: e.date,
    weight: e.weight != null ? e.weight : null,
    unit: e.unit,
    note: typeof e.note === 'string' ? e.note : '',
    calories: e.calories != null ? e.calories : null,
  };
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
      clean[date] = normalizeStoredEntry(entry);
    }
  }
  return clean;
}

function assertDate(date, what = 'date') {
  if (typeof date !== 'string' || !DATE_RE.test(date)) {
    throw new TypeError(`${what} must be a 'YYYY-MM-DD' string, got: ${JSON.stringify(date)}`);
  }
}

function assertUnit(unit) {
  if (!VALID_UNITS.includes(unit)) {
    throw new TypeError(`unit must be 'lbs' or 'kg', got: ${JSON.stringify(unit)}`);
  }
}

// ---------- entries ----------

export async function saveEntry(entry) {
  assertDate(entry?.date);
  assertUnit(entry?.unit);
  const hasW = entry?.weight != null;
  const hasC = entry?.calories != null;
  if (!hasW && !hasC) {
    throw new TypeError('entry must include a weight, calories, or both');
  }
  if (hasW && !validWeight(entry.weight)) {
    throw new TypeError(`weight must be a finite number > 0, got: ${JSON.stringify(entry.weight)}`);
  }
  if (hasC && !validCalories(entry.calories)) {
    throw new TypeError(`calories must be a whole number in [0, ${MAX_CALORIES}), got: ${JSON.stringify(entry.calories)}`);
  }
  const clean = {
    date: entry.date,
    weight: hasW ? entry.weight : null,
    unit: entry.unit,
    note: typeof entry.note === 'string' ? entry.note.trim() : '',
    calories: hasC ? entry.calories : null,
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

// ---------- goal ----------

export async function saveGoal(goal) {
  if (goal === null) {
    localStorage.removeItem(KEYS.goal);
    return null;
  }
  if (!validWeight(goal?.targetWeight)) {
    throw new TypeError(`targetWeight must be a finite number > 0, got: ${JSON.stringify(goal?.targetWeight)}`);
  }
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
  if (goal === null || typeof goal !== 'object' || !validWeight(goal.targetWeight) || !VALID_UNITS.includes(goal.unit)) {
    return null; // wrong-shape goal degrades to "no goal", same as corrupt JSON
  }
  const targetDate =
    typeof goal.targetDate === 'string' && DATE_RE.test(goal.targetDate) ? goal.targetDate : null;
  return { targetWeight: goal.targetWeight, unit: goal.unit, targetDate };
}

// ---------- settings ----------

function readSettings() {
  const s = readJSON(KEYS.settings, null);
  const unit = s && VALID_UNITS.includes(s.unit) ? s.unit : DEFAULT_SETTINGS.unit;
  const chartRange =
    s && typeof s.chartRange === 'string' && CHART_RANGE_RE.test(s.chartRange)
      ? s.chartRange
      : DEFAULT_SETTINGS.chartRange;
  return { unit, chartRange };
}

// Merges a partial into the stored settings so saving one field never clobbers
// the others (e.g. changing units keeps the chart range and vice-versa).
export async function saveSettings(partial) {
  const next = readSettings();
  if (partial && partial.unit !== undefined) {
    assertUnit(partial.unit);
    next.unit = partial.unit;
  }
  if (partial && partial.chartRange !== undefined) {
    if (typeof partial.chartRange !== 'string' || !CHART_RANGE_RE.test(partial.chartRange)) {
      throw new TypeError(`chartRange must match ${CHART_RANGE_RE}, got: ${JSON.stringify(partial.chartRange)}`);
    }
    next.chartRange = partial.chartRange;
  }
  writeJSON(KEYS.settings, next);
  return { ...next };
}

export async function getSettings() {
  return readSettings();
}

// ---------- phases / periods ----------

function isValidPeriod(p) {
  return (
    p !== null &&
    typeof p === 'object' &&
    typeof p.id === 'string' &&
    p.id.length > 0 &&
    typeof p.name === 'string' &&
    p.name.trim().length > 0 &&
    typeof p.startDate === 'string' &&
    DATE_RE.test(p.startDate)
  );
}

function readPeriods() {
  const raw = readJSON(KEYS.periods, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isValidPeriod)
    .map((p) => ({ id: p.id, name: p.name.trim(), startDate: p.startDate }));
}

export async function getPeriods() {
  return readPeriods().sort((a, b) =>
    a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0
  );
}

export async function savePeriod(period) {
  assertDate(period?.startDate, 'startDate');
  if (typeof period?.name !== 'string' || period.name.trim() === '') {
    throw new TypeError('period name is required');
  }
  const id = typeof period.id === 'string' && period.id ? period.id : genId();
  const clean = { id, name: period.name.trim(), startDate: period.startDate };
  const periods = readPeriods().filter((p) => p.id !== id);
  periods.push(clean);
  writeJSON(KEYS.periods, periods);
  return { ...clean };
}

export async function deletePeriod(id) {
  const periods = readPeriods();
  const next = periods.filter((p) => p.id !== id);
  if (next.length === periods.length) return false;
  writeJSON(KEYS.periods, next);
  return true;
}

// ---------- export ----------

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
  const rows = entries.map((e) =>
    [e.date, e.weight ?? '', e.unit, e.note, e.calories ?? ''].map(escape).join(',')
  );
  return ['date,weight,unit,note,calories', ...rows].join('\r\n') + '\r\n';
}

// RFC 4180-ish parser: handles quoted fields, "" escapes, commas/newlines
// inside quotes, and LF or CRLF line endings. Returns an array of string arrays.
function parseCSV(text) {
  const s = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export async function importCSV(text, { overwrite = true, dryRun = false } = {}) {
  const rows = parseCSV(text);
  const summary = { imported: 0, skipped: 0, invalid: 0, total: 0 };
  if (rows.length < 2) return summary; // header only / empty

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = {
    date: header.indexOf('date'),
    weight: header.indexOf('weight'),
    unit: header.indexOf('unit'),
    note: header.indexOf('note'),
    calories: header.indexOf('calories'),
  };
  if (col.date === -1) throw new Error("That CSV has no 'date' column — is it a weight-tracker export?");

  const entries = readEntriesMap();
  const cell = (row, i) => (i !== -1 && i < row.length ? row[i] : '');

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length === 1 && row[0].trim() === '') continue; // blank line
    summary.total++;

    const date = cell(row, col.date).trim();
    if (!DATE_RE.test(date)) { summary.invalid++; continue; }

    const rawW = cell(row, col.weight).trim();
    const rawC = cell(row, col.calories).replace(/[,\s]/g, '');
    const unitRaw = cell(row, col.unit).trim().toLowerCase();
    const note = cell(row, col.note).trim();

    let weight = null;
    if (rawW !== '') {
      const w = Number.parseFloat(rawW);
      if (Number.isFinite(w) && w > 0) weight = w;
    }
    let calories = null;
    if (rawC !== '') {
      const c = Number.parseInt(rawC, 10);
      if (Number.isFinite(c) && Number.isInteger(c) && c >= 0 && c < MAX_CALORIES) calories = c;
    }
    if (weight == null && calories == null) { summary.invalid++; continue; }

    if (!overwrite && date in entries) { summary.skipped++; continue; }

    entries[date] = {
      date,
      weight,
      unit: VALID_UNITS.includes(unitRaw) ? unitRaw : 'lbs',
      note,
      calories,
    };
    summary.imported++;
  }

  if (!dryRun && summary.imported > 0) writeJSON(KEYS.entries, entries);
  return summary;
}

// ---------- backup timestamp ----------

export async function markBackedUp(iso) {
  const meta = readJSON(KEYS.meta, {});
  const clean = meta && typeof meta === 'object' && !Array.isArray(meta) ? { ...meta } : {};
  clean.lastBackup = typeof iso === 'string' && DATE_RE.test(iso) ? iso : null;
  writeJSON(KEYS.meta, clean);
  return clean.lastBackup;
}

export async function getLastBackup() {
  const meta = readJSON(KEYS.meta, null);
  return meta && typeof meta === 'object' && typeof meta.lastBackup === 'string' && DATE_RE.test(meta.lastBackup)
    ? meta.lastBackup
    : null;
}
