// Node test harness for the weight-tracker data + math modules.
// Run from the project root:  node tests/run-tests.mjs
// (No dependencies. storage.js runs against the localStorage shim below, so
// these tests are the safety net when its internals are swapped for a cloud
// backend later — the contract they pin down must keep passing.)
import assert from 'node:assert/strict';

// ---- localStorage shim (storage.js is the only module that needs it) ----
const backing = new Map();
globalThis.localStorage = {
  getItem: (k) => (backing.has(k) ? backing.get(k) : null),
  setItem: (k, v) => backing.set(k, String(v)),
  removeItem: (k) => backing.delete(k),
  clear: () => backing.clear(),
};

import * as units from '../js/units.js';
import * as store from '../js/storage.js';
import * as stats from '../js/stats.js';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

// ---------------- units ----------------
await test('convert lbs->kg exact factor', () => {
  assert.equal(units.convert(100, 'lbs', 'kg'), 45.359237);
});
await test('convert round-trips', () => {
  const w = 182.4;
  assert.ok(Math.abs(units.convert(units.convert(w, 'lbs', 'kg'), 'kg', 'lbs') - w) < 1e-9);
});
await test('convert same unit is identity', () => {
  assert.equal(units.convert(70.55, 'kg', 'kg'), 70.55);
});
await test('formatNumber drops trailing .0', () => {
  assert.equal(units.formatNumber(182.0), '182');
  assert.equal(units.formatNumber(182.44), '182.4');
  assert.equal(units.formatNumber(182.46), '182.5');
});
await test('formatSigned', () => {
  assert.equal(units.formatSigned(-0.44), '-0.4');
  assert.equal(units.formatSigned(1.26), '+1.3');
  assert.equal(units.formatSigned(0.01), '0');
});

// ---------------- storage ----------------
await test('saveEntry/getEntry round trip + trims note', async () => {
  const saved = await store.saveEntry({ date: '2026-07-01', weight: 182.4, unit: 'lbs', note: '  traveled  ' });
  assert.deepEqual(saved, { date: '2026-07-01', weight: 182.4, unit: 'lbs', note: 'traveled', calories: null });
  assert.deepEqual(await store.getEntry('2026-07-01'), saved);
});
await test('getEntry missing -> null', async () => {
  assert.equal(await store.getEntry('1999-01-01'), null);
});
await test('saveEntry upserts by date (one per day)', async () => {
  await store.saveEntry({ date: '2026-07-01', weight: 181.0, unit: 'lbs' });
  const all = await store.getAllEntries();
  assert.equal(all.filter((e) => e.date === '2026-07-01').length, 1);
  assert.equal((await store.getEntry('2026-07-01')).weight, 181.0);
});
await test('getAllEntries sorted ascending', async () => {
  await store.saveEntry({ date: '2026-06-15', weight: 184, unit: 'lbs' });
  await store.saveEntry({ date: '2026-07-10', weight: 180, unit: 'lbs' });
  const all = await store.getAllEntries();
  const dates = all.map((e) => e.date);
  assert.deepEqual(dates, [...dates].sort());
});
await test('deleteEntry true then false', async () => {
  await store.saveEntry({ date: '2026-05-05', weight: 190, unit: 'lbs' });
  assert.equal(await store.deleteEntry('2026-05-05'), true);
  assert.equal(await store.deleteEntry('2026-05-05'), false);
});
await test('saveEntry validation throws', async () => {
  await assert.rejects(store.saveEntry({ date: 'bogus', weight: 180, unit: 'lbs' }), TypeError);
  await assert.rejects(store.saveEntry({ date: '2026-07-01', weight: -5, unit: 'lbs' }), TypeError);
  await assert.rejects(store.saveEntry({ date: '2026-07-01', weight: NaN, unit: 'lbs' }), TypeError);
  await assert.rejects(store.saveEntry({ date: '2026-07-01', weight: 180, unit: 'stone' }), TypeError);
});
await test('goal save/get/clear', async () => {
  await store.saveGoal({ targetWeight: 175, unit: 'lbs', targetDate: '2026-10-01' });
  assert.deepEqual(await store.getGoal(), { targetWeight: 175, unit: 'lbs', targetDate: '2026-10-01' });
  await store.saveGoal({ targetWeight: 175, unit: 'lbs' });
  assert.equal((await store.getGoal()).targetDate, null);
  assert.equal(await store.saveGoal(null), null);
  assert.equal(await store.getGoal(), null);
});
await test('settings default lbs, then persist', async () => {
  assert.deepEqual(await store.getSettings(), { unit: 'lbs' });
  await store.saveSettings({ unit: 'kg' });
  assert.deepEqual(await store.getSettings(), { unit: 'kg' });
  await store.saveSettings({ unit: 'lbs' });
});
await test('corrupt storage degrades to fallback', async () => {
  backing.set('weight-tracker:goal', '{not json');
  assert.equal(await store.getGoal(), null);
});
await test('exportCSV escapes commas and quotes', async () => {
  backing.clear();
  await store.saveEntry({ date: '2026-07-01', weight: 182.4, unit: 'lbs', note: 'salty, "big" dinner' });
  await store.saveEntry({ date: '2026-07-02', weight: 182.0, unit: 'kg', note: '' });
  const csv = await store.exportCSV();
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines[0], 'date,weight,unit,note,calories');
  assert.equal(lines[1], '2026-07-01,182.4,lbs,"salty, ""big"" dinner",');
  assert.equal(lines[2], '2026-07-02,182,kg,,');
});

// ---------------- stats ----------------
const day0 = '2026-06-01';
function seq(startDate, weights, unit = 'lbs') {
  // consecutive daily entries starting at startDate; null = skipped day (gap)
  const startDay = stats.epochDay(startDate);
  const out = [];
  weights.forEach((w, i) => {
    if (w != null) out.push({ date: stats.dayToISO(startDay + i), weight: w, unit, note: '' });
  });
  return out;
}

await test('epochDay/dayToISO round trip', () => {
  assert.equal(stats.dayToISO(stats.epochDay('2026-07-21')), '2026-07-21');
  assert.equal(stats.epochDay('2026-07-21') - stats.epochDay('2026-07-20'), 1);
});
await test('trend on perfectly linear data', () => {
  const entries = seq(day0, Array.from({ length: 14 }, (_, i) => 200 - 0.1 * i));
  const t = stats.computeTrend(entries, 'lbs');
  assert.ok(Math.abs(t.slopePerWeek - -0.7) < 1e-9, `slopePerWeek=${t.slopePerWeek}`);
  assert.equal(t.points, 14);
});
await test('trend ignores entries older than the window', () => {
  const old = seq('2026-01-01', [250, 249, 248]); // steep ancient history
  const recent = seq('2026-07-01', Array.from({ length: 10 }, (_, i) => 200 - 0.1 * i));
  const t = stats.computeTrend([...old, ...recent], 'lbs');
  assert.equal(t.points, 10);
  assert.ok(Math.abs(t.slopePerWeek - -0.7) < 1e-9);
});
await test('trend needs 3+ points in window', () => {
  assert.equal(stats.computeTrend(seq(day0, [200, 199]), 'lbs'), null);
  assert.equal(stats.computeTrend([], 'lbs'), null);
});
await test('trend handles mixed units', () => {
  // same true weights, half entered in kg
  const entries = seq(day0, Array.from({ length: 14 }, (_, i) => 200 - 0.1 * i));
  const mixed = entries.map((e, i) =>
    i % 2 ? { ...e, weight: units.convert(e.weight, 'lbs', 'kg'), unit: 'kg' } : e
  );
  const t = stats.computeTrend(mixed, 'lbs');
  assert.ok(Math.abs(t.slopePerWeek - -0.7) < 1e-6, `slopePerWeek=${t.slopePerWeek}`);
});
await test('projection: ok, with honest date math', () => {
  // 14 days ending 2026-06-14, losing 0.5/day from 206.5 -> 200.0; target 190
  const entries = seq(day0, Array.from({ length: 14 }, (_, i) => 206.5 - 0.5 * i));
  const goal = { targetWeight: 190, unit: 'lbs', targetDate: null };
  const p = stats.projectGoal(entries, goal, 'lbs');
  assert.equal(p.status, 'ok');
  // valueAtAnchor = 200.0 at 2026-06-14; 10 lbs to go at 0.5/day = 20 days -> 2026-07-04
  assert.equal(p.projectedDate, '2026-07-04');
});
await test('projection: lateByDays vs target date', () => {
  const entries = seq(day0, Array.from({ length: 14 }, (_, i) => 206.5 - 0.5 * i));
  const late = stats.projectGoal(entries, { targetWeight: 190, unit: 'lbs', targetDate: '2026-06-30' }, 'lbs');
  assert.equal(late.lateByDays, 4); // projected Jul 4 vs target Jun 30
  const early = stats.projectGoal(entries, { targetWeight: 190, unit: 'lbs', targetDate: '2026-07-10' }, 'lbs');
  assert.equal(early.lateByDays, -6);
});
await test('projection: away when trending opposite', () => {
  const entries = seq(day0, Array.from({ length: 14 }, (_, i) => 200 + 0.3 * i));
  const p = stats.projectGoal(entries, { targetWeight: 190, unit: 'lbs', targetDate: null }, 'lbs');
  assert.equal(p.status, 'away');
});
await test('projection: flat trend', () => {
  const entries = seq(day0, Array.from({ length: 14 }, () => 200).map((w, i) => w + (i % 2 ? 0.001 : -0.001)));
  const p = stats.projectGoal(entries, { targetWeight: 190, unit: 'lbs', targetDate: null }, 'lbs');
  assert.equal(p.status, 'flat');
});
await test('projection: insufficient data', () => {
  const p = stats.projectGoal(seq(day0, [200, 199]), { targetWeight: 190, unit: 'lbs', targetDate: null }, 'lbs');
  assert.equal(p.status, 'insufficient');
});
await test('projection: at goal', () => {
  const entries = seq(day0, Array.from({ length: 5 }, () => 190.02));
  const p = stats.projectGoal(entries, { targetWeight: 190, unit: 'lbs', targetDate: null }, 'lbs');
  assert.equal(p.status, 'at-goal');
});
await test('projection: goal unit differs from display unit', () => {
  const entries = seq(day0, Array.from({ length: 14 }, (_, i) => 206.5 - 0.5 * i)); // lbs
  const goalKg = { targetWeight: units.convert(190, 'lbs', 'kg'), unit: 'kg', targetDate: null };
  const p = stats.projectGoal(entries, goalKg, 'lbs');
  assert.equal(p.status, 'ok');
  assert.equal(p.projectedDate, '2026-07-04');
});
await test('changeOverDays uses nearest at-or-before, never interpolates', () => {
  // entries at day 0, 3, 10 (gaps!) — 7-day lookback from day 10 must pick day 3
  const entries = [
    { date: '2026-06-01', weight: 200, unit: 'lbs', note: '' },
    { date: '2026-06-04', weight: 199, unit: 'lbs', note: '' },
    { date: '2026-06-11', weight: 197, unit: 'lbs', note: '' },
  ];
  const c = stats.changeOverDays(entries, 'lbs', 7);
  assert.equal(c.fromDate, '2026-06-04');
  assert.ok(Math.abs(c.delta - -2) < 1e-9);
  assert.equal(c.spanDays, 7);
});
await test('changeOverDays 1-day = yesterday vs today, null when yesterday missing', () => {
  const consec = seq(day0, [200, 199.2]); // day0 and day0+1
  const c1 = stats.changeOverDays(consec, 'lbs', 1);
  assert.ok(c1 && Math.abs(c1.delta - -0.8) < 1e-9 && c1.spanDays === 1);
  // skipped yesterday (2-day gap) -> no 1-day change (baseline too old for the label)
  const gap = [
    { date: '2026-06-01', weight: 200, unit: 'lbs', note: '' },
    { date: '2026-06-03', weight: 199, unit: 'lbs', note: '' },
  ];
  assert.equal(stats.changeOverDays(gap, 'lbs', 1), null);
});
await test('changeOverDays null when history too short', () => {
  const entries = seq('2026-07-18', [200, 199.5, 199]);
  assert.equal(stats.changeOverDays(entries, 'lbs', 30), null);
  assert.equal(stats.changeOverDays(seq(day0, [200]), 'lbs', 7), null);
});
await test('sinceStart and distanceToGoal', () => {
  const entries = seq(day0, [200, null, 198, 196]);
  const s = stats.sinceStart(entries, 'lbs');
  assert.ok(Math.abs(s.delta - -4) < 1e-9);
  assert.equal(s.fromDate, '2026-06-01');
  const d = stats.distanceToGoal(entries, { targetWeight: 190, unit: 'lbs', targetDate: null }, 'lbs');
  assert.ok(Math.abs(d.diff - 6) < 1e-9);
  assert.equal(stats.distanceToGoal(entries, null, 'lbs'), null);
});

// ---------------- post-review fixes ----------------
await test('CSV neutralizes formula-leading notes with a space', async () => {
  backing.clear();
  await store.saveEntry({ date: '2026-07-03', weight: 181, unit: 'lbs', note: '+2 after holiday dinner' });
  await store.saveEntry({ date: '2026-07-04', weight: 181, unit: 'lbs', note: '=SUM(A1)' });
  const lines = (await store.exportCSV()).trimEnd().split('\r\n');
  assert.equal(lines[1], '2026-07-03,181,lbs, +2 after holiday dinner,');
  assert.equal(lines[2], '2026-07-04,181,lbs, =SUM(A1),');
});
await test('getGoal rejects wrong-shape goal objects', async () => {
  backing.set('weight-tracker:goal', '{}');
  assert.equal(await store.getGoal(), null);
  backing.set('weight-tracker:goal', JSON.stringify({ targetWeight: 'x', unit: 'lbs' }));
  assert.equal(await store.getGoal(), null);
  backing.set('weight-tracker:goal', JSON.stringify({ targetWeight: 175, unit: 'lbs', targetDate: 'bogus' }));
  assert.deepEqual(await store.getGoal(), { targetWeight: 175, unit: 'lbs', targetDate: null });
});
await test('entries key holding null/array/garbage degrades to empty, and saving recovers', async () => {
  backing.set('weight-tracker:entries', 'null');
  assert.deepEqual(await store.getAllEntries(), []);
  backing.set('weight-tracker:entries', '[1,2]');
  assert.deepEqual(await store.getAllEntries(), []);
  backing.set('weight-tracker:entries', JSON.stringify({ '2026-07-01': { date: '2026-07-01', weight: 'NaNish', unit: 'lbs' }, '2026-07-02': { date: '2026-07-02', weight: 180, unit: 'lbs', note: 'ok' } }));
  const all = await store.getAllEntries();
  assert.equal(all.length, 1);
  assert.equal(all[0].date, '2026-07-02');
  await store.saveEntry({ date: '2026-07-05', weight: 179, unit: 'lbs' });
  assert.equal((await store.getAllEntries()).length, 2);
});
await test('flat verdict is unit-invariant (slope -0.08 lbs/week trends in BOTH units)', () => {
  const entries = seq(day0, Array.from({ length: 14 }, (_, i) => 200 - (0.08 / 7) * i));
  const goal = { targetWeight: 190, unit: 'lbs', targetDate: null };
  const pLbs = stats.projectGoal(entries, goal, 'lbs');
  const pKg = stats.projectGoal(entries, goal, 'kg');
  assert.notEqual(pLbs.status, 'flat');
  assert.notEqual(pKg.status, 'flat');
  assert.equal(pLbs.status, pKg.status);
});
await test('trend crossing target while raw point lags -> trend-at-goal with diff', () => {
  // steep fall then a rebound: regression value at anchor sits below target
  const entries = seq(day0, [160, 159, 158, 157, 158]);
  const p = stats.projectGoal(entries, { targetWeight: 157.5, unit: 'lbs', targetDate: null }, 'lbs');
  assert.equal(p.status, 'trend-at-goal');
  assert.ok(Math.abs(p.diff - 0.5) < 1e-9, `diff=${p.diff}`);
});
await test('projectGoal ok result carries anchorDate', () => {
  const entries = seq(day0, Array.from({ length: 14 }, (_, i) => 206.5 - 0.5 * i));
  const p = stats.projectGoal(entries, { targetWeight: 190, unit: 'lbs', targetDate: null }, 'lbs');
  assert.equal(p.status, 'ok');
  assert.equal(p.anchorDate, '2026-06-14');
});
await test('changeOverDays refuses a baseline far older than the label (7-day over 20-day gap)', () => {
  const entries = [
    { date: '2026-06-01', weight: 200, unit: 'lbs', note: '' },
    { date: '2026-06-21', weight: 195, unit: 'lbs', note: '' },
  ];
  assert.equal(stats.changeOverDays(entries, 'lbs', 7), null);
  // but a 10-day-old baseline still qualifies for the 7-day change (<= 1.5x)
  const ok = stats.changeOverDays(
    [
      { date: '2026-06-11', weight: 200, unit: 'lbs', note: '' },
      { date: '2026-06-21', weight: 195, unit: 'lbs', note: '' },
    ],
    'lbs',
    7
  );
  assert.ok(ok && ok.spanDays === 10);
});

// ---------------- calories ----------------
await test('saveEntry round-trips calories', async () => {
  backing.clear();
  const saved = await store.saveEntry({ date: '2026-07-01', weight: 180, unit: 'lbs', calories: 1850, note: 'x' });
  assert.equal(saved.calories, 1850);
  assert.equal((await store.getEntry('2026-07-01')).calories, 1850);
});
await test('calorie-only entry (no weight) is allowed and stores weight:null', async () => {
  backing.clear();
  const saved = await store.saveEntry({ date: '2026-07-02', unit: 'lbs', calories: 2000 });
  assert.equal(saved.weight, null);
  assert.equal(saved.calories, 2000);
  const all = await store.getAllEntries();
  assert.equal(all.length, 1);
  assert.equal(all[0].weight, null);
});
await test('adding calories to a day preserves its weight (full-day replace)', async () => {
  backing.clear();
  await store.saveEntry({ date: '2026-07-03', weight: 178.4, unit: 'lbs' });
  // re-save the same day carrying the existing weight forward, plus calories
  await store.saveEntry({ date: '2026-07-03', weight: 178.4, unit: 'lbs', calories: 1700 });
  const e = await store.getEntry('2026-07-03');
  assert.equal(e.weight, 178.4);
  assert.equal(e.calories, 1700);
});
await test('saveEntry rejects an entry with neither weight nor calories', async () => {
  await assert.rejects(store.saveEntry({ date: '2026-07-01', unit: 'lbs' }), TypeError);
  await assert.rejects(store.saveEntry({ date: '2026-07-01', unit: 'lbs', weight: null, calories: null }), TypeError);
});
await test('saveEntry rejects bad calories', async () => {
  await assert.rejects(store.saveEntry({ date: '2026-07-01', unit: 'lbs', calories: -5 }), TypeError);
  await assert.rejects(store.saveEntry({ date: '2026-07-01', unit: 'lbs', calories: 1850.5 }), TypeError);
  await assert.rejects(store.saveEntry({ date: '2026-07-01', unit: 'lbs', calories: 100000 }), TypeError);
});
await test('exportCSV includes calories column with blanks', async () => {
  backing.clear();
  await store.saveEntry({ date: '2026-07-01', weight: 180, unit: 'lbs', calories: 1850 });
  await store.saveEntry({ date: '2026-07-02', unit: 'lbs', calories: 2000 }); // weight-less
  await store.saveEntry({ date: '2026-07-03', weight: 179, unit: 'lbs' });    // calorie-less
  const lines = (await store.exportCSV()).trimEnd().split('\r\n');
  assert.equal(lines[0], 'date,weight,unit,note,calories');
  assert.equal(lines[1], '2026-07-01,180,lbs,,1850');
  assert.equal(lines[2], '2026-07-02,,lbs,,2000');
  assert.equal(lines[3], '2026-07-03,179,lbs,,');
});
await test('calorie-only days do not affect weight math (trend/sinceStart)', () => {
  const weightDays = seq(day0, Array.from({ length: 14 }, (_, i) => 200 - 0.1 * i));
  // A calorie-only day BEFORE the first weigh-in must not become the "start".
  const calOnly = { date: '2026-05-20', weight: null, unit: 'lbs', calories: 2200 };
  const mixed = [calOnly, ...weightDays];
  const tPlain = stats.computeTrend(weightDays, 'lbs');
  const tMixed = stats.computeTrend(mixed, 'lbs');
  assert.ok(Math.abs(tPlain.slopePerWeek - tMixed.slopePerWeek) < 1e-9);
  const sPlain = stats.sinceStart(weightDays, 'lbs');
  const sMixed = stats.sinceStart(mixed, 'lbs');
  assert.equal(sPlain.fromDate, sMixed.fromDate); // calorie-only 2026-05-20 is NOT the start
});

// ---------------- readEntriesMap resilience with new shape ----------------
await test('wrong-shape entries are dropped; calorie-only kept', async () => {
  backing.set('weight-tracker:entries', JSON.stringify({
    '2026-07-01': { date: '2026-07-01', weight: 180, unit: 'lbs' },            // ok
    '2026-07-02': { date: '2026-07-02', unit: 'lbs', calories: 2000 },         // ok (cal-only)
    '2026-07-03': { date: '2026-07-03', unit: 'lbs' },                         // neither -> drop
    '2026-07-04': { date: '2026-07-04', weight: 0, unit: 'lbs' },              // bad weight -> drop
    '2026-07-05': { date: '2026-07-05', unit: 'lbs', calories: -1 },           // bad calories -> drop
  }));
  const all = await store.getAllEntries();
  assert.deepEqual(all.map((e) => e.date), ['2026-07-01', '2026-07-02']);
});

// ---------------- phases / periods ----------------
await test('periods: empty -> [], save/get sorted, delete', async () => {
  backing.clear();
  assert.deepEqual(await store.getPeriods(), []);
  const cut = await store.savePeriod({ name: 'Summer cut', startDate: '2026-06-01' });
  assert.ok(cut.id);
  await store.savePeriod({ name: 'Maintain', startDate: '2026-07-15' });
  const periods = await store.getPeriods();
  assert.deepEqual(periods.map((p) => p.name), ['Summer cut', 'Maintain']); // sorted by startDate
  // upsert by id
  await store.savePeriod({ id: cut.id, name: 'Spring cut', startDate: '2026-06-01' });
  const after = await store.getPeriods();
  assert.equal(after.length, 2);
  assert.equal(after[0].name, 'Spring cut');
  assert.equal(await store.deletePeriod(cut.id), true);
  assert.equal(await store.deletePeriod(cut.id), false);
  assert.equal((await store.getPeriods()).length, 1);
});
await test('savePeriod requires a name and a valid date', async () => {
  await assert.rejects(store.savePeriod({ name: '  ', startDate: '2026-06-01' }), TypeError);
  await assert.rejects(store.savePeriod({ name: 'X', startDate: 'nope' }), TypeError);
});
await test('getPeriods drops wrong-shape rows', async () => {
  backing.set('weight-tracker:periods', JSON.stringify([
    { id: 'a', name: 'Good', startDate: '2026-06-01' },
    { id: 'b', name: '', startDate: '2026-06-02' },      // empty name -> drop
    { name: 'No id', startDate: '2026-06-03' },          // no id -> drop
    'garbage',
  ]));
  const periods = await store.getPeriods();
  assert.deepEqual(periods.map((p) => p.id), ['a']);
});

// ---------------- sincePhaseStart ----------------
await test('sincePhaseStart baselines on the first weigh-in at/after the phase start', () => {
  const entries = [
    { date: '2026-06-01', weight: 200, unit: 'lbs' },
    { date: '2026-06-10', weight: 198, unit: 'lbs' }, // phase starts here
    { date: '2026-06-20', weight: 194, unit: 'lbs' },
  ];
  const sp = stats.sincePhaseStart(entries, '2026-06-10', 'lbs');
  assert.equal(sp.fromDate, '2026-06-10');
  assert.ok(Math.abs(sp.delta - -4) < 1e-9); // 194 - 198
});
await test('sincePhaseStart ignores calorie-only days and needs 2 weigh-ins', () => {
  const entries = [
    { date: '2026-06-10', weight: 198, unit: 'lbs' },
    { date: '2026-06-12', weight: null, unit: 'lbs', calories: 2000 }, // ignored
    { date: '2026-06-20', weight: 194, unit: 'lbs' },
  ];
  const sp = stats.sincePhaseStart(entries, '2026-06-10', 'lbs');
  assert.ok(Math.abs(sp.delta - -4) < 1e-9);
  // only one weigh-in since the phase start -> null
  assert.equal(stats.sincePhaseStart(entries, '2026-06-15', 'lbs'), null);
});

// ---------------- CSV import / restore ----------------
await test('exportCSV -> importCSV round-trips entries', async () => {
  backing.clear();
  await store.saveEntry({ date: '2026-07-01', weight: 182.4, unit: 'lbs', note: 'salty, "big" dinner', calories: 2400 });
  await store.saveEntry({ date: '2026-07-02', unit: 'kg', calories: 2000 });       // weight-less
  await store.saveEntry({ date: '2026-07-03', weight: 179, unit: 'lbs', note: '=danger' }); // formula-guard note
  const csv = await store.exportCSV();
  const before = await store.getAllEntries();
  backing.clear();
  const summary = await store.importCSV(csv);
  assert.equal(summary.imported, 3);
  const after = await store.getAllEntries();
  assert.equal(after.length, 3);
  // dates + weights + calories + unit survive; note trims the export's formula-guard space
  assert.deepEqual(after.map((e) => e.date), before.map((e) => e.date));
  assert.equal(after.find((e) => e.date === '2026-07-01').calories, 2400);
  assert.equal(after.find((e) => e.date === '2026-07-02').weight, null);
  assert.equal(after.find((e) => e.date === '2026-07-02').unit, 'kg');
  assert.equal(after.find((e) => e.date === '2026-07-03').note, '=danger');
  assert.equal(after.find((e) => e.date === '2026-07-01').note, 'salty, "big" dinner');
});
await test('importCSV dryRun validates without writing', async () => {
  backing.clear();
  const csv = 'date,weight,unit,note,calories\r\n2026-07-01,180,lbs,,1850\r\n';
  const preview = await store.importCSV(csv, { dryRun: true });
  assert.equal(preview.imported, 1);
  assert.equal((await store.getAllEntries()).length, 0); // nothing written
});
await test('importCSV counts invalid rows and needs a date column', async () => {
  backing.clear();
  const csv = [
    'date,weight,unit,note,calories',
    '2026-07-01,180,lbs,,1850',   // ok
    'not-a-date,170,lbs,,',       // bad date -> invalid
    '2026-07-02,,lbs,,',          // no weight & no calories -> invalid
    '2026-07-03,,lbs,,2000',      // calorie-only -> ok
  ].join('\n');
  const s = await store.importCSV(csv);
  assert.equal(s.imported, 2);
  assert.equal(s.invalid, 2);
  await assert.rejects(store.importCSV('name,value\r\nx,1\r\n'), /date/);
});
await test('importCSV overwrite vs skip on existing dates', async () => {
  backing.clear();
  await store.saveEntry({ date: '2026-07-01', weight: 180, unit: 'lbs' });
  const csv = 'date,weight,unit,note,calories\r\n2026-07-01,175,lbs,,\r\n';
  const skip = await store.importCSV(csv, { overwrite: false });
  assert.equal(skip.skipped, 1);
  assert.equal((await store.getEntry('2026-07-01')).weight, 180); // unchanged
  await store.importCSV(csv, { overwrite: true });
  assert.equal((await store.getEntry('2026-07-01')).weight, 175); // replaced
});
await test('importCSV tolerates column reorder and extra columns', async () => {
  backing.clear();
  const csv = 'calories,note,date,weight,unit,extra\r\n1850,hi,2026-07-01,180,lbs,ignored\r\n';
  const s = await store.importCSV(csv);
  assert.equal(s.imported, 1);
  const e = await store.getEntry('2026-07-01');
  assert.equal(e.weight, 180);
  assert.equal(e.calories, 1850);
  assert.equal(e.note, 'hi');
});
await test('markBackedUp / getLastBackup', async () => {
  backing.clear();
  assert.equal(await store.getLastBackup(), null);
  await store.markBackedUp('2026-07-21');
  assert.equal(await store.getLastBackup(), '2026-07-21');
  // meta survives other writes
  await store.saveSettings({ unit: 'kg' });
  assert.equal(await store.getLastBackup(), '2026-07-21');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
