// app.js — UI wiring. All persistence goes through storage.js; all math through
// stats.js/units.js; all chart drawing through chart.js.

import * as store from './storage.js';
import * as stats from './stats.js';
import { convert, formatNumber, formatSigned, round1 } from './units.js';
import { renderChart } from './chart.js';

const $ = (id) => document.getElementById(id);
const els = {
  entryTitle: $('entry-title'),
  entryForm: $('entry-form'),
  weightInput: $('weight-input'),
  weightUnitSuffix: $('weight-unit-suffix'),
  noteInput: $('note-input'),
  caloriesInput: $('calories-input'),
  entryHint: $('entry-hint'),
  logBtn: $('log-btn'),
  dayPrev: $('day-prev'),
  dayNext: $('day-next'),
  dayToday: $('day-today'),
  dayPick: $('day-pick'),
  entryDateInput: $('entry-date-input'),
  trendLine: $('trend-line'),
  projectionLine: $('projection-line'),
  maintenancePhases: $('maintenance-phases'),
  tiles: {
    d1: $('tile-1d'),
    d7: $('tile-7d'),
    d30: $('tile-30d'),
    start: $('tile-start'),
    goal: $('tile-goal'),
    maint: $('tile-maint'),
  },
  chartTitle: $('chart-title'),
  chartCanvas: $('chart-canvas'),
  chartWrap: $('chart-wrap'),
  chartEmpty: $('chart-empty'),
  chartRange: $('chart-range'),
  chartPhase: $('chart-phase'),
  goalSummary: $('goal-summary'),
  goalEdit: $('goal-edit'),
  goalClear: $('goal-clear'),
  goalForm: $('goal-form'),
  goalWeightInput: $('goal-weight-input'),
  goalUnitSuffix: $('goal-unit-suffix'),
  goalDateInput: $('goal-date-input'),
  goalCancel: $('goal-cancel'),
  phaseSummary: $('phase-summary'),
  phaseNew: $('phase-new'),
  phaseEdit: $('phase-edit'),
  phaseClear: $('phase-clear'),
  phaseForm: $('phase-form'),
  phaseNameInput: $('phase-name-input'),
  phaseDateInput: $('phase-date-input'),
  phaseCancel: $('phase-cancel'),
  historyTitle: $('history-title'),
  historyTabs: $('history-tabs'),
  historyList: $('history-list'),
  historyEmpty: $('history-empty'),
  unitRadios: () => document.querySelectorAll('input[name="unit"]'),
  exportBtn: $('export-btn'),
  importBtn: $('import-btn'),
  importFile: $('import-file'),
  backupStatus: $('backup-status'),
  toast: $('toast'),
};

const state = {
  formDate: null,         // ISO date the entry form targets (null = not yet initialised)
  loadedDate: null,       // which date's values are in the fields (null = reload needed)
  original: null,         // existing stored entry for loadedDate (or null)
  prefillWeightStr: '',   // weight string put in the field at prefill (detects "unchanged")
  goalFormOpen: false,    // single source of truth for the goal card's form/buttons
  phaseFormOpen: false,   // same for the phase card
  phaseEditId: null,      // id of the phase being edited (null = starting a new one)
  historyFilter: 'all',   // 'all' or a phase id — filters the History list
  chartRange: null,       // '1w'|'1m'|'3m'|'1y'|'all'|'phase:<id>' (null until loaded from settings)
  renderedToday: null,    // catches the date rolling over while the app stays open
};

// ---------- date helpers (local calendar, never UTC) ----------

const pad2 = (n) => String(n).padStart(2, '0');

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function addDaysISO(iso, delta) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + delta);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

function parseISO(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d);
}

const fmtShort = (date) =>
  parseISO(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const fmtMedium = (date) =>
  parseISO(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const fmtWeekday = (date) =>
  parseISO(date).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

// ---------- small UI helpers ----------

let toastTimer;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2400);
}

// Mutating storage can fail (quota full today; network errors after a cloud
// swap) — surface it instead of dying silently mid-handler.
async function withStore(action, failMessage) {
  try {
    return { ok: true, value: await action() };
  } catch (err) {
    console.error(err);
    toast(failMessage);
    return { ok: false, value: null };
  }
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const formatCalories = (c) => c.toLocaleString();

// Delta direction color: green when moving toward the goal, red when away,
// neutral when there is no goal. The arrow glyph + wording carry the meaning
// too — color is never the only channel.
function deltaSpan(delta, goalDir) {
  // Judge direction from the ROUNDED value so the arrow/color never contradict
  // a displayed "0" (a -0.03 delta must not show a green ▼ next to "0").
  const rounded = round1(delta);
  const span = document.createElement('span');
  const arrow = document.createElement('span');
  arrow.className = 'delta-arrow';
  arrow.textContent = rounded > 0 ? '▲' : rounded < 0 ? '▼' : '';
  if (goalDir !== 0 && rounded !== 0) {
    arrow.classList.add(Math.sign(rounded) === goalDir ? 'delta-good' : 'delta-bad');
  }
  span.append(arrow, document.createTextNode(formatSigned(delta)));
  return span;
}

// -1 -> losing is progress, +1 -> gaining is progress, 0 -> no goal
function goalDirection(entries, goal, unit) {
  const dist = stats.distanceToGoal(entries, goal, unit);
  if (!dist || dist.diff === 0) return 0;
  return dist.diff > 0 ? -1 : 1;
}

function currentPhase(periods) {
  return periods.length ? periods[periods.length - 1] : null; // periods sorted ascending
}

// ---------- render ----------

let refreshGen = 0;

async function refresh() {
  const gen = ++refreshGen;
  const [entries, goal, settings, periods, lastBackup] = await Promise.all([
    store.getAllEntries(),
    store.getGoal(),
    store.getSettings(),
    store.getPeriods(),
    store.getLastBackup(),
  ]);
  if (gen !== refreshGen) return; // a newer refresh superseded this one — let it paint
  const unit = settings.unit;
  if (state.chartRange === null) state.chartRange = settings.chartRange; // load persisted range once
  state.renderedToday = todayISO();

  renderEntryCard(entries, unit);
  renderStats(entries, goal, unit, periods);
  renderChartCard(entries, goal, unit, periods);
  renderChartRange(periods);
  renderGoalCard(goal, unit);
  renderPhaseCard(periods);
  renderHistory(entries, unit, periods);
  renderSettings(settings);
  renderBackupStatus(entries, lastBackup);
}

function renderBackupStatus(entries, lastBackup) {
  const el = els.backupStatus;
  el.classList.remove('backup-due');
  if (entries.length === 0) {
    el.textContent = 'All data stays on this device. Once you have entries, export a CSV backup — Restore reloads one.';
    return;
  }
  if (!lastBackup) {
    el.textContent = 'All data stays on this device — no backup saved yet. Export a CSV; Restore reloads one if it’s ever lost.';
    el.classList.add('backup-due');
    return;
  }
  const days = stats.epochDay(todayISO()) - stats.epochDay(lastBackup);
  const ago = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  el.textContent = `Last backup: ${ago}. Export a CSV now and then; Restore reloads one.`;
  if (days >= 14) el.classList.add('backup-due');
}

function safeRefresh() {
  return refresh().catch((err) => {
    console.error(err);
    toast('Could not load data.');
  });
}

// Load a day's existing values into the fields. Called only when the target day
// changes (never on an incidental refresh) so it can't clobber what's typed.
function loadDay(date, entries, unit) {
  const existing = entries.find((e) => e.date === date) || null;
  state.original = existing;
  state.loadedDate = date;
  if (existing && existing.weight != null) {
    state.prefillWeightStr = formatNumber(convert(existing.weight, existing.unit, unit));
    els.weightInput.value = state.prefillWeightStr;
  } else {
    state.prefillWeightStr = '';
    els.weightInput.value = '';
  }
  els.caloriesInput.value = existing && existing.calories != null ? String(existing.calories) : '';
  els.noteInput.value = existing && existing.note ? existing.note : '';
}

// True when the fields exactly match the stored entry for the shown day — i.e.
// there is nothing to log.
function formMatchesSaved() {
  const o = state.original;
  if (!o) return false;
  const weightMatches = els.weightInput.value.trim() === state.prefillWeightStr;
  const calMatches = els.caloriesInput.value.trim() === (o.calories != null ? String(o.calories) : '');
  const noteMatches = els.noteInput.value.trim() === (o.note || '');
  return weightMatches && calMatches && noteMatches;
}

// The Log button doubles as the "have I logged this day?" cue: grey "✓ Logged"
// when the fields match what's stored, blue "Log" the moment anything changes.
function updateLogButton() {
  const logged = formMatchesSaved();
  els.logBtn.textContent = logged ? '✓ Logged' : 'Log';
  els.logBtn.classList.toggle('is-logged', logged);
}

function entryHintText(target, unit) {
  const o = state.original;
  const bits = [];
  if (o && o.weight != null) bits.push(`${formatNumber(convert(o.weight, o.unit, unit))} ${unit}`);
  if (o && o.calories != null) bits.push(`${formatCalories(o.calories)} cal`);
  if (target === todayISO()) {
    return o ? `Logged today: ${bits.join(', ')}` : 'Nothing logged today yet.';
  }
  return o ? `Logged: ${bits.join(', ')}` : 'Nothing logged this day.';
}

function renderEntryCard(entries, unit) {
  const today = todayISO();
  if (!state.formDate) state.formDate = today;
  const target = state.formDate;
  els.weightUnitSuffix.textContent = unit;

  if (target !== state.loadedDate) loadDay(target, entries, unit);

  const isToday = target === today;
  els.entryTitle.textContent = isToday ? fmtWeekday(today) : fmtMedium(target);
  els.dayNext.disabled = target >= today; // never navigate into the future
  els.dayToday.hidden = isToday;

  els.entryHint.textContent = entryHintText(target, unit);
  updateLogButton();
}

function renderStats(entries, goal, unit, periods) {
  const dir = goalDirection(entries, goal, unit);
  const trend = stats.computeTrend(entries, unit);
  const todayDay = stats.epochDay(todayISO());
  // A trend anchored to an old last entry is history, not the present —
  // say so instead of presenting month-old data in the present tense.
  const trendStale = trend && todayDay - trend.anchorDay > stats.TREND_WINDOW_DAYS;
  const anchorText = trend ? fmtMedium(stats.dayToISO(trend.anchorDay)) : '';

  // Trend sentence
  if (!trend) {
    els.trendLine.textContent = `Need a few more entries for a trend (${stats.TREND_MIN_POINTS}+ within ${stats.TREND_WINDOW_DAYS} days).`;
    els.trendLine.className = 'stat-sentence muted';
  } else if (Math.abs(trend.slopePerWeek) < stats.flatSlopeThreshold(unit)) {
    els.trendLine.textContent = trendStale
      ? `Weight was holding steady as of ${anchorText} — log a new weight to refresh.`
      : 'Weight is holding steady.';
    els.trendLine.className = trendStale ? 'stat-sentence muted' : 'stat-sentence';
  } else {
    const downish = trend.slopePerWeek < 0;
    els.trendLine.textContent = '';
    els.trendLine.className = trendStale ? 'stat-sentence muted' : 'stat-sentence';
    const arrow = document.createElement('span');
    arrow.className = 'delta-arrow';
    arrow.textContent = downish ? '▼' : '▲';
    if (dir !== 0 && !trendStale) {
      arrow.classList.add(Math.sign(trend.slopePerWeek) === dir ? 'delta-good' : 'delta-bad');
    }
    const wording = trendStale
      ? ` Was trending ${downish ? 'down' : 'up'} ~${formatNumber(Math.abs(trend.slopePerWeek))} ${unit}/week as of ${anchorText} — log a new weight to refresh.`
      : ` Trending ${downish ? 'down' : 'up'} ~${formatNumber(Math.abs(trend.slopePerWeek))} ${unit}/week`;
    els.trendLine.append(arrow, document.createTextNode(wording));
  }

  // Projection sentence — honest in every state
  const proj = stats.projectGoal(entries, goal, unit);
  els.projectionLine.className = 'stat-sentence muted';
  switch (proj.status) {
    case 'no-goal':
      els.projectionLine.textContent = 'Set a goal to see a projected date.';
      break;
    case 'no-data':
      els.projectionLine.textContent = 'Log a weight to get started.';
      break;
    case 'insufficient':
      els.projectionLine.textContent = `Need more entries to project (${proj.minPoints}+ within ${proj.windowDays} days).`;
      break;
    case 'at-goal':
      els.projectionLine.textContent = 'You are at your goal weight.';
      els.projectionLine.className = 'stat-sentence';
      break;
    case 'trend-at-goal': {
      const side = proj.diff > 0 ? 'above' : 'below';
      els.projectionLine.textContent = `Your trend line has reached the goal — latest weigh-in is ${formatNumber(Math.abs(proj.diff))} ${unit} ${side} target.`;
      els.projectionLine.className = 'stat-sentence';
      break;
    }
    case 'flat':
      els.projectionLine.textContent = 'Trend is flat — no projected goal date at the current rate.';
      break;
    case 'away':
      els.projectionLine.textContent = `Current trend is moving away from your goal (${formatSigned(proj.slopePerWeek)} ${unit}/week).`;
      break;
    case 'too-far':
      els.projectionLine.textContent = 'At the current rate the goal is more than 5 years out.';
      break;
    case 'ok': {
      // Never present a stale projection as current — a projected date in the
      // past, or a trend anchored to an old last entry, is not "on track".
      const projStale =
        proj.projectedDate < todayISO() ||
        todayDay - stats.epochDay(proj.anchorDate) > stats.TREND_WINDOW_DAYS;
      if (projStale) {
        els.projectionLine.textContent = `Projection is stale — based on entries up to ${fmtMedium(proj.anchorDate)}. Log a new weight to refresh it.`;
        break;
      }
      let text = `On track to reach goal around ${fmtMedium(proj.projectedDate)}`;
      if (proj.lateByDays != null) {
        if (proj.lateByDays > 0) text += ` — ${proj.lateByDays} day${proj.lateByDays === 1 ? '' : 's'} after your target date`;
        else if (proj.lateByDays < 0) text += ` — ${-proj.lateByDays} day${proj.lateByDays === -1 ? '' : 's'} ahead of your target date`;
        else text += ' — right on your target date';
      }
      els.projectionLine.textContent = text + '.';
      els.projectionLine.className = 'stat-sentence';
      break;
    }
  }

  // Maintenance estimate tile (adaptive TDEE from recent weight + calorie logs)
  const maint = stats.estimateMaintenance(entries, unit, periods);
  const mVal = els.tiles.maint.querySelector('.tile-value');
  const mSub = els.tiles.maint.querySelector('.tile-sub');
  if (maint.status === 'ok') {
    mVal.textContent = `~${formatCalories(maint.maintenance)} cal`;
    mSub.textContent = `${formatCalories(maint.low)}–${formatCalories(maint.high)}${maint.clippedPhase ? ' · this phase' : ''}`;
  } else if (maint.status === 'insufficient') {
    mVal.textContent = '—';
    mSub.textContent = 'need ~2 wks of logs';
  } else {
    mVal.textContent = '—';
    mSub.textContent = 'log weight + calories';
  }

  // Historical maintenance by phase — shown only with 2+ phases that have data.
  const byPhase = stats.maintenanceByPhase(entries, unit, periods);
  if (byPhase.length >= 2) {
    els.maintenancePhases.hidden = false;
    els.maintenancePhases.textContent =
      'Maintenance by phase — ' + byPhase.map((p) => `${p.name}: ~${formatCalories(p.maintenance)}`).join(' · ');
  } else {
    els.maintenancePhases.hidden = true;
    els.maintenancePhases.textContent = '';
  }

  // Tiles
  const setTile = (tile, result, sub) => {
    const value = tile.querySelector('.tile-value');
    const subEl = tile.querySelector('.tile-sub');
    value.textContent = '';
    if (result == null) {
      value.textContent = '—';
      subEl.textContent = sub ?? 'not enough data';
    } else {
      value.append(deltaSpan(result.delta, dir), document.createTextNode(` ${unit}`));
      subEl.textContent = sub ?? '';
    }
  };

  const c1 = stats.changeOverDays(entries, unit, 1);
  const c7 = stats.changeOverDays(entries, unit, 7);
  const c30 = stats.changeOverDays(entries, unit, 30);
  setTile(els.tiles.d1, c1, c1 ? `vs ${fmtShort(c1.fromDate)}` : 'no entry yesterday');
  setTile(els.tiles.d7, c7, c7 ? `vs ${fmtShort(c7.fromDate)}` : undefined);
  setTile(els.tiles.d30, c30, c30 ? `vs ${fmtShort(c30.fromDate)}` : undefined);

  // "Since start" tile — anchored to the current phase if one is set.
  const phase = currentPhase(periods);
  const startLabel = els.tiles.start.querySelector('.tile-label');
  if (phase) {
    startLabel.textContent = phase.name;
    startLabel.title = phase.name; // full name on hover when the label is ellipsized
    const sp = stats.sincePhaseStart(entries, phase.startDate, unit);
    setTile(
      els.tiles.start,
      sp,
      sp ? `since ${fmtShort(phase.startDate)}` : `since ${fmtShort(phase.startDate)} · need 2 weigh-ins`
    );
  } else {
    startLabel.textContent = 'Since start';
    startLabel.removeAttribute('title');
    const start = stats.sinceStart(entries, unit);
    setTile(els.tiles.start, start, start ? `since ${fmtShort(start.fromDate)}` : undefined);
  }

  // "To goal" tile
  const dist = stats.distanceToGoal(entries, goal, unit);
  const goalValue = els.tiles.goal.querySelector('.tile-value');
  const goalSub = els.tiles.goal.querySelector('.tile-sub');
  goalValue.textContent = '';
  if (!dist) {
    goalValue.textContent = '—';
    goalSub.textContent = goal ? 'log a weight' : 'no goal set';
  } else if (Math.abs(dist.diff) < stats.atGoalBand(unit)) {
    goalValue.textContent = 'At goal';
    goalSub.textContent = `target ${formatNumber(dist.target)} ${unit}`;
  } else {
    goalValue.textContent = `${formatNumber(Math.abs(dist.diff))} ${unit}`;
    goalSub.textContent = `${dist.diff > 0 ? 'above' : 'below'} target ${formatNumber(dist.target)}`;
  }
}

const HALF_DAY_MS = 12 * 60 * 60 * 1000;
const RANGE_PILLS = [
  { value: '1w', label: '1W' },
  { value: '1m', label: '1M' },
  { value: '3m', label: '3M' },
  { value: '1y', label: '1Y' },
  { value: 'all', label: 'All' },
];

function saveRange(range) {
  store.saveSettings({ chartRange: range }).catch((err) => console.error(err));
}

function renderChartCard(entries, goal, unit, periods) {
  els.chartTitle.textContent = `Weight (${unit})`;
  // Plot anything with a weight or calories; the chart overlays both lines.
  const plottable = entries.filter((e) => (e.weight != null && Number.isFinite(e.weight)) || e.calories != null);
  const hasData = plottable.length > 0;
  els.chartWrap.hidden = !hasData;
  els.chartEmpty.hidden = hasData;
  if (!hasData) return;

  // Resolve the selected range to a window. A deleted phase yields null bounds —
  // fall back to the default range and persist the correction.
  let bounds = stats.chartRangeBounds(plottable, state.chartRange, periods);
  if (bounds === null && typeof state.chartRange === 'string' && state.chartRange.startsWith('phase:')) {
    state.chartRange = '1w';
    saveRange(state.chartRange);
    bounds = stats.chartRangeBounds(plottable, state.chartRange, periods);
  }
  const range = bounds
    ? {
        startMs: parseISO(bounds.start).getTime() - HALF_DAY_MS, // ½-day pad so edge points aren't clipped
        endMs: parseISO(bounds.end).getTime() + HALF_DAY_MS,
      }
    : null;
  renderChart(els.chartCanvas, plottable, goal, unit, range);
}

function renderChartRange(periods) {
  const onPhase = typeof state.chartRange === 'string' && state.chartRange.startsWith('phase:');

  els.chartRange.textContent = '';
  for (const p of RANGE_PILLS) {
    const active = !onPhase && state.chartRange === p.value;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pill' + (active ? ' is-active' : '');
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(active));
    btn.textContent = p.label;
    btn.addEventListener('click', () => {
      state.chartRange = p.value;
      saveRange(p.value);
      safeRefresh();
    });
    els.chartRange.append(btn);
  }

  // Phase dropdown — only when phases exist; lists all phases, newest first.
  els.chartPhase.textContent = '';
  if (!periods.length) {
    els.chartPhase.hidden = true;
    return;
  }
  els.chartPhase.hidden = false;
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Phase…';
  placeholder.disabled = true;
  placeholder.selected = !onPhase;
  els.chartPhase.append(placeholder);
  for (const ph of [...periods].reverse()) {
    const opt = document.createElement('option');
    opt.value = 'phase:' + ph.id;
    opt.textContent = ph.name; // user text — textContent only
    if (state.chartRange === opt.value) opt.selected = true;
    els.chartPhase.append(opt);
  }
}

function renderGoalCard(goal, unit) {
  els.goalUnitSuffix.textContent = unit;
  els.goalForm.hidden = !state.goalFormOpen;
  els.goalEdit.hidden = state.goalFormOpen;
  els.goalClear.hidden = state.goalFormOpen || !goal;
  if (goal) {
    const target = formatNumber(convert(goal.targetWeight, goal.unit, unit));
    let text = `${target} ${unit}`;
    if (goal.targetDate) text += ` by ${fmtMedium(goal.targetDate)}`;
    els.goalSummary.textContent = text;
    els.goalSummary.classList.remove('muted');
    els.goalEdit.textContent = 'Edit';
  } else {
    els.goalSummary.textContent = 'Not set';
    els.goalSummary.classList.add('muted');
    els.goalEdit.textContent = 'Set goal';
  }
}

function renderPhaseCard(periods) {
  const phase = currentPhase(periods);
  els.phaseForm.hidden = !state.phaseFormOpen;
  els.phaseEdit.hidden = state.phaseFormOpen;
  els.phaseNew.hidden = state.phaseFormOpen || !phase;
  els.phaseClear.hidden = state.phaseFormOpen || !phase;
  els.phaseEdit.textContent = phase ? 'Edit' : 'Start phase';
  if (phase) {
    els.phaseSummary.textContent = `${phase.name} — since ${fmtMedium(phase.startDate)}`;
  } else {
    els.phaseSummary.textContent = 'No phase set — “Since start” uses your first entry.';
  }
}

// Each phase covers [startDate, next phase's startDate). The current phase runs
// to the end of time.
function phaseSpans(periods) {
  return periods.map((p, i) => ({
    ...p,
    startDay: stats.epochDay(p.startDate),
    endDay: i + 1 < periods.length ? stats.epochDay(periods[i + 1].startDate) : Infinity,
  }));
}

function renderHistoryTabs(periods) {
  els.historyTabs.textContent = '';
  // Only worth showing once there's a past phase (i.e. 2+ phases).
  if (periods.length < 2) {
    els.historyTabs.hidden = true;
    return;
  }
  els.historyTabs.hidden = false;
  const tabs = [{ id: 'all', name: 'All' }, ...[...periods].reverse()]; // newest phase first
  for (const t of tabs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pill' + (state.historyFilter === t.id ? ' is-active' : '');
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(state.historyFilter === t.id));
    btn.textContent = t.name; // phase name is user text — textContent only
    btn.addEventListener('click', () => {
      state.historyFilter = t.id;
      safeRefresh();
    });
    els.historyTabs.append(btn);
  }
}

function renderHistory(entries, unit, periods) {
  // A deleted phase can leave a dangling filter — fall back to All.
  if (state.historyFilter !== 'all' && !periods.some((p) => p.id === state.historyFilter)) {
    state.historyFilter = 'all';
  }
  renderHistoryTabs(periods);

  let shown = entries;
  if (state.historyFilter !== 'all') {
    const span = phaseSpans(periods).find((p) => p.id === state.historyFilter);
    if (span) {
      shown = entries.filter((e) => {
        const day = stats.epochDay(e.date);
        return day >= span.startDay && day < span.endDay;
      });
    }
  }

  els.historyList.textContent = '';
  if (shown.length === 0) {
    els.historyEmpty.hidden = false;
    els.historyEmpty.textContent = entries.length === 0 ? 'No entries yet.' : 'No entries in this phase.';
  } else {
    els.historyEmpty.hidden = true;
  }

  const newestFirst = [...shown].reverse();
  for (const entry of newestFirst) {
    const li = document.createElement('li');
    li.className = 'history-row';

    const main = document.createElement('div');
    main.className = 'history-main';
    const dateEl = document.createElement('span');
    dateEl.className = 'history-date';
    dateEl.textContent = fmtMedium(entry.date);
    const weightEl = document.createElement('span');
    weightEl.className = 'history-weight';
    weightEl.textContent =
      entry.weight != null ? `${formatNumber(convert(entry.weight, entry.unit, unit))} ${unit}` : '—';
    main.append(dateEl, weightEl);

    const metaParts = [];
    if (entry.calories != null) metaParts.push(`${formatCalories(entry.calories)} cal`);
    if (entry.note) metaParts.push(entry.note);
    if (metaParts.length) {
      const metaEl = document.createElement('span');
      metaEl.className = 'history-note';
      metaEl.textContent = metaParts.join(' · '); // note is untrusted — textContent only
      main.append(metaEl);
    }

    const actions = document.createElement('div');
    actions.className = 'history-actions';
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'icon-btn';
    editBtn.setAttribute('aria-label', `Edit entry for ${fmtMedium(entry.date)}`);
    editBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';
    editBtn.addEventListener('click', () => startEdit(entry));
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'icon-btn';
    delBtn.setAttribute('aria-label', `Delete entry for ${fmtMedium(entry.date)}`);
    delBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
    delBtn.addEventListener('click', async () => {
      if (!window.confirm(`Delete the entry for ${fmtMedium(entry.date)}?`)) return;
      const res = await withStore(() => store.deleteEntry(entry.date), 'Could not delete the entry.');
      if (!res.ok) return;
      if (state.formDate === entry.date) state.loadedDate = null; // reload the (now-empty) form day
      toast('Entry deleted');
      await safeRefresh();
      els.historyTitle.focus(); // the focused button's row is gone — re-anchor keyboard users
    });
    actions.append(editBtn, delBtn);

    li.append(main, actions);
    els.historyList.append(li);
  }
}

function renderSettings(settings) {
  for (const radio of els.unitRadios()) {
    radio.checked = radio.value === settings.unit;
  }
}

// ---------- entry form: day navigation ----------

function goToDay(date) {
  state.formDate = date;
  els.entryDateInput.classList.remove('revealed'); // in case the fallback picker was shown
  safeRefresh();
}

function startEdit(entry) {
  state.formDate = entry.date;
  state.loadedDate = null; // force loadDay on the next render
  safeRefresh().then(() => {
    els.entryForm.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    els.weightInput.focus();
  });
}

els.dayPrev.addEventListener('click', () => goToDay(addDaysISO(state.formDate || todayISO(), -1)));
els.dayNext.addEventListener('click', () => {
  const next = addDaysISO(state.formDate || todayISO(), 1);
  if (next <= todayISO()) goToDay(next);
});
els.dayToday.addEventListener('click', () => goToDay(todayISO()));

// Calendar icon opens the native date picker (the old "Jump to a date").
els.dayPick.addEventListener('click', () => {
  els.entryDateInput.max = todayISO();
  els.entryDateInput.value = state.formDate || todayISO();
  try {
    els.entryDateInput.showPicker();
  } catch {
    // Older browsers without showPicker(): reveal the field inline and focus it.
    els.entryDateInput.classList.add('revealed');
    els.entryDateInput.focus();
  }
});

els.entryDateInput.addEventListener('change', () => {
  const picked = els.entryDateInput.value;
  if (!picked) return;
  if (picked > todayISO()) {
    toast('No future dates — this app never invents data.');
    return;
  }
  if (picked < '1900-01-01') {
    toast('That date looks wrong — double-check the year.');
    return;
  }
  goToDay(picked);
});

// Live button cue: any edit flips "✓ Logged" back to "Log".
for (const input of [els.weightInput, els.noteInput, els.caloriesInput]) {
  input.addEventListener('input', updateLogButton);
}

els.entryForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const date = state.formDate || todayISO();

  // Nothing changed since it was stored — treat the "✓ Logged" button as inert.
  if (state.original && formMatchesSaved()) {
    toast('Already logged for this day.');
    return;
  }

  // Weight — optional (a day can be calories-only).
  const wraw = els.weightInput.value.trim().replace(',', '.');
  let weight = null;
  if (wraw !== '') {
    const w = Number.parseFloat(wraw);
    if (!Number.isFinite(w) || w <= 0 || w >= 2000) {
      toast('Enter a weight between 0 and 2000, or leave it blank.');
      els.weightInput.focus();
      return;
    }
    weight = w;
  }

  // Calories — optional, whole number.
  const craw = els.caloriesInput.value.trim().replace(/[,\s]/g, '');
  let calories = null;
  if (craw !== '') {
    if (!/^\d+$/.test(craw)) {
      toast('Enter calories as a whole number (0–99999), or leave it blank.');
      els.caloriesInput.focus();
      return;
    }
    const c = Number.parseInt(craw, 10);
    if (!Number.isFinite(c) || c >= 100000) {
      toast('That calorie number looks too high — double-check it.');
      els.caloriesInput.focus();
      return;
    }
    calories = c;
  }

  if (weight == null && calories == null) {
    toast('Enter a weight or calories to log.');
    els.weightInput.focus();
    return;
  }

  const settings = await store.getSettings();
  const note = els.noteInput.value.trim();

  // If the weight field is unchanged from what was prefilled, keep the ORIGINAL
  // raw weight + unit — so re-logging (e.g. just to add calories) never
  // re-rounds or unit-shifts the stored measurement.
  let outWeight = weight;
  let outUnit = settings.unit;
  if (
    weight != null &&
    state.original &&
    state.original.weight != null &&
    els.weightInput.value.trim() === state.prefillWeightStr
  ) {
    outWeight = state.original.weight;
    outUnit = state.original.unit;
  }

  const entry = { date, weight: outWeight, unit: outUnit, note, calories };
  const res = await withStore(() => store.saveEntry(entry), 'Could not save — storage failed.');
  if (!res.ok) return;
  const wasLogged = Boolean(state.original);
  toast(wasLogged ? 'Updated' : 'Logged');
  state.loadedDate = null; // reload the saved values so the button flips to "✓ Logged"
  safeRefresh();
});

// ---------- goal form ----------

els.goalEdit.addEventListener('click', async () => {
  const [goal, settings] = await Promise.all([store.getGoal(), store.getSettings()]);
  state.goalFormOpen = true;
  // min only nudges the picker; the form is novalidate, so an existing PAST
  // target date never blocks re-saving (rules live in the submit handler).
  els.goalDateInput.min = todayISO();
  if (goal) {
    els.goalWeightInput.value = formatNumber(convert(goal.targetWeight, goal.unit, settings.unit));
    els.goalDateInput.value = goal.targetDate ?? '';
  } else {
    els.goalWeightInput.value = '';
    els.goalDateInput.value = '';
  }
  await safeRefresh();
  els.goalWeightInput.focus();
});

els.goalCancel.addEventListener('click', () => {
  state.goalFormOpen = false;
  safeRefresh();
});

els.goalForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const weight = Number.parseFloat(els.goalWeightInput.value.trim().replace(',', '.'));
  if (!Number.isFinite(weight) || weight <= 0 || weight >= 2000) {
    toast('Enter a target weight between 0 and 2000.');
    els.goalWeightInput.focus();
    return;
  }
  const settings = await store.getSettings();
  const res = await withStore(
    () =>
      store.saveGoal({
        targetWeight: weight,
        unit: settings.unit,
        targetDate: els.goalDateInput.value || null,
      }),
    'Could not save the goal — storage failed.'
  );
  if (!res.ok) return;
  state.goalFormOpen = false;
  toast('Goal saved');
  safeRefresh();
});

els.goalClear.addEventListener('click', async () => {
  if (!window.confirm('Clear your goal?')) return;
  const res = await withStore(() => store.saveGoal(null), 'Could not clear the goal.');
  if (!res.ok) return;
  toast('Goal cleared');
  safeRefresh();
});

// ---------- phase form ----------

function openPhaseForm(phase) {
  state.phaseFormOpen = true;
  state.phaseEditId = phase ? phase.id : null;
  els.phaseNameInput.value = phase ? phase.name : '';
  els.phaseDateInput.value = phase ? phase.startDate : todayISO();
  els.phaseDateInput.max = todayISO();
  safeRefresh().then(() => els.phaseNameInput.focus());
}

els.phaseEdit.addEventListener('click', async () => {
  const periods = await store.getPeriods();
  openPhaseForm(currentPhase(periods)); // edit current, or start the first one
});

els.phaseNew.addEventListener('click', () => {
  openPhaseForm(null); // start a brand-new phase
});

els.phaseCancel.addEventListener('click', () => {
  state.phaseFormOpen = false;
  safeRefresh();
});

els.phaseForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const name = els.phaseNameInput.value.trim();
  if (!name) {
    toast('Give the phase a name.');
    els.phaseNameInput.focus();
    return;
  }
  const startDate = els.phaseDateInput.value || todayISO();
  if (startDate > todayISO()) {
    toast('A phase can’t start in the future.');
    return;
  }
  if (startDate < '1900-01-01') {
    toast('That start date looks wrong — check the year.');
    return;
  }
  const res = await withStore(
    () => store.savePeriod({ id: state.phaseEditId ?? undefined, name, startDate }),
    'Could not save the phase — storage failed.'
  );
  if (!res.ok) return;
  state.phaseFormOpen = false;
  toast('Phase saved');
  safeRefresh();
});

els.phaseClear.addEventListener('click', async () => {
  if (!window.confirm('Clear the current phase? “Since start” will go back to your first entry.')) return;
  const periods = await store.getPeriods();
  const phase = currentPhase(periods);
  if (!phase) return;
  const res = await withStore(() => store.deletePeriod(phase.id), 'Could not clear the phase.');
  if (!res.ok) return;
  toast('Phase cleared');
  safeRefresh();
});

// ---------- settings ----------

for (const radio of els.unitRadios()) {
  radio.addEventListener('change', async () => {
    if (!radio.checked) return;
    const res = await withStore(() => store.saveSettings({ unit: radio.value }), 'Could not save settings.');
    if (!res.ok) return;
    state.loadedDate = null;    // re-prefill the entry form in the new unit
    state.goalFormOpen = false; // goal form's prefill is in the old unit
    safeRefresh();
  });
}

// Chart phase dropdown (persistent element — listener attached once).
els.chartPhase.addEventListener('change', () => {
  const v = els.chartPhase.value;
  if (!v) return;
  state.chartRange = v;
  saveRange(v);
  safeRefresh();
});

els.exportBtn.addEventListener('click', async () => {
  const res = await withStore(() => store.exportCSV(), 'Could not export CSV.');
  if (!res.ok) return;
  const filename = `weight-history-${todayISO()}.csv`;
  const file = new File([res.value], filename, { type: 'text/csv' });

  // On iOS the `<a download>` blob trick doesn't reliably save a file — it
  // opens the CSV as text instead (worse in standalone) — so on touch devices
  // that can share files, hand it to the native share sheet (Save to Files, or
  // send it on). Desktop/Android keep the plain download.
  const canShareFile =
    window.matchMedia('(pointer: coarse)').matches &&
    typeof navigator.canShare === 'function' &&
    navigator.canShare({ files: [file] });
  if (canShareFile) {
    try {
      await navigator.share({ files: [file], title: 'Weight history' });
      await store.markBackedUp(todayISO());
      toast('CSV shared');
      safeRefresh();
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return; // user dismissed the share sheet
      // any other failure falls through to the download path below
    }
  }

  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  await store.markBackedUp(todayISO());
  toast('CSV exported');
  safeRefresh();
});

// ---------- restore from CSV ----------

els.importBtn.addEventListener('click', () => els.importFile.click());

els.importFile.addEventListener('change', async () => {
  const file = els.importFile.files && els.importFile.files[0];
  els.importFile.value = ''; // let the same file be picked again later
  if (!file) return;

  let text;
  try {
    text = await file.text();
  } catch {
    toast('Could not read that file.');
    return;
  }

  let preview;
  try {
    preview = await store.importCSV(text, { dryRun: true });
  } catch (err) {
    console.error(err);
    toast(err.message || 'Could not read that CSV.');
    return;
  }
  if (preview.imported === 0) {
    toast(preview.invalid ? `No valid entries found (${preview.invalid} rows skipped).` : 'No entries found in that file.');
    return;
  }

  const n = preview.imported;
  if (!window.confirm(`Import ${n} entr${n === 1 ? 'y' : 'ies'} from this file? Any entry on the same date will be replaced.`)) {
    return;
  }
  const res = await withStore(() => store.importCSV(text, { overwrite: true }), 'Could not import that file.');
  if (!res.ok) return;
  state.loadedDate = null; // the shown day's values may have changed
  const done = res.value.imported;
  toast(`Restored ${done} entr${done === 1 ? 'y' : 'ies'}.`);
  safeRefresh();
});

// ---------- environment hooks ----------

// Ask the browser to keep our storage "persistent" so it isn't evicted under
// storage pressure. Granted reliably on Chrome/Android; best-effort on iOS
// (harmless if denied). The home-screen install already exempts us from iOS's
// 7-day cap; this is belt-and-suspenders.
if (navigator.storage && typeof navigator.storage.persist === 'function') {
  navigator.storage.persisted()
    .then((already) => (already ? null : navigator.storage.persist()))
    .catch(() => {});
}

// Re-render (chart colors, etc.) when the OS theme flips.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => safeRefresh());

// If the app sits open across midnight, catch the rollover when it becomes
// visible/focused again. If the form was tracking "today", follow into the new
// day; if it was parked on a specific past day, leave it there.
function handleRollover() {
  const t = todayISO();
  if (!state.renderedToday || state.renderedToday === t) return;
  if (state.formDate === state.renderedToday) {
    state.formDate = t;
    state.loadedDate = null;
  }
  safeRefresh();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') handleRollover();
});
window.addEventListener('focus', handleRollover);

// Service worker: registered ONLY on the deployed HTTPS site (that's where
// offline support matters). On localhost we deliberately DON'T register it —
// and we tear down any a previous version left behind, plus its caches — so
// local edits are never masked by a stale cached copy. (Offline still works
// once deployed.)
const onLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
if ('serviceWorker' in navigator) {
  if (location.protocol === 'https:' && !onLocalhost) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch((err) => {
        console.warn('Service worker registration failed:', err);
      });
    });
  } else if (onLocalhost) {
    navigator.serviceWorker.getRegistrations()
      .then((regs) => regs.forEach((r) => r.unregister()))
      .catch(() => {});
    if (window.caches && caches.keys) {
      caches.keys()
        .then((keys) => keys.forEach((k) => { if (k.startsWith('weight-tracker')) caches.delete(k); }))
        .catch(() => {});
    }
  }
}

safeRefresh();
