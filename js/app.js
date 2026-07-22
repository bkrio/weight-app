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
  entryHint: $('entry-hint'),
  entryCancel: $('entry-cancel'),
  otherDayToggle: $('other-day-toggle'),
  entryDateInput: $('entry-date-input'),
  trendLine: $('trend-line'),
  projectionLine: $('projection-line'),
  tiles: {
    d7: $('tile-7d'),
    d30: $('tile-30d'),
    start: $('tile-start'),
    goal: $('tile-goal'),
  },
  chartTitle: $('chart-title'),
  chartCanvas: $('chart-canvas'),
  chartWrap: $('chart-wrap'),
  chartEmpty: $('chart-empty'),
  goalSummary: $('goal-summary'),
  goalEdit: $('goal-edit'),
  goalClear: $('goal-clear'),
  goalForm: $('goal-form'),
  goalWeightInput: $('goal-weight-input'),
  goalUnitSuffix: $('goal-unit-suffix'),
  goalDateInput: $('goal-date-input'),
  goalCancel: $('goal-cancel'),
  historyTitle: $('history-title'),
  historyList: $('history-list'),
  historyEmpty: $('history-empty'),
  unitRadios: () => document.querySelectorAll('input[name="unit"]'),
  exportBtn: $('export-btn'),
  toast: $('toast'),
};

const state = {
  editingDate: null,      // date of the entry being edited via History, else null
  editingPrefill: null,   // exact string prefilled on edit, to detect "unchanged"
  editingOriginal: null,  // original entry being edited
  goalFormOpen: false,    // single source of truth for goal-card button/form visibility
  renderedToday: null,    // catches the date rolling over while the app stays open
};

// ---------- date helpers (local calendar, never UTC) ----------

const pad2 = (n) => String(n).padStart(2, '0');

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
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
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2200);
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

// Delta direction color: green when moving toward the goal, red when away,
// neutral when there is no goal. The arrow glyph + wording carry the meaning
// too — color is never the only channel.
function deltaSpan(delta, goalDirection) {
  // Judge direction from the ROUNDED value so the arrow/color never contradict
  // a displayed "0" (a -0.03 delta must not show a green ▼ next to "0").
  const rounded = round1(delta);
  const span = document.createElement('span');
  const arrow = document.createElement('span');
  arrow.className = 'delta-arrow';
  arrow.textContent = rounded > 0 ? '▲' : rounded < 0 ? '▼' : '';
  if (goalDirection !== 0 && rounded !== 0) {
    arrow.classList.add(Math.sign(rounded) === goalDirection ? 'delta-good' : 'delta-bad');
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

// ---------- render ----------

let refreshGen = 0;

async function refresh() {
  const gen = ++refreshGen;
  const [entries, goal, settings] = await Promise.all([
    store.getAllEntries(),
    store.getGoal(),
    store.getSettings(),
  ]);
  if (gen !== refreshGen) return; // a newer refresh superseded this one — let it paint
  const unit = settings.unit;
  state.renderedToday = todayISO();

  renderEntryCard(entries, unit);
  renderStats(entries, goal, unit);
  renderChartCard(entries, goal, unit);
  renderGoalCard(entries, goal, unit);
  renderHistory(entries, unit);
  renderSettings(settings);
}

function safeRefresh() {
  return refresh().catch((err) => {
    console.error(err);
    toast('Could not load data.');
  });
}

function renderEntryCard(entries, unit) {
  const today = todayISO();
  els.weightUnitSuffix.textContent = unit;

  if (state.editingDate) {
    els.entryTitle.textContent = `Editing ${fmtMedium(state.editingDate)}`;
    els.entryCancel.hidden = false;
    els.otherDayToggle.hidden = true;
    els.entryDateInput.hidden = true;
    els.entryHint.textContent = 'Saving replaces this entry.';
    return;
  }

  els.entryTitle.textContent = fmtWeekday(today);
  els.entryCancel.hidden = true;
  els.otherDayToggle.hidden = !els.entryDateInput.hidden;
  els.entryDateInput.max = today;

  const todayEntry = entries.find((e) => e.date === today);
  els.weightInput.placeholder = todayEntry
    ? formatNumber(convert(todayEntry.weight, todayEntry.unit, unit))
    : '0.0';

  if (!els.entryDateInput.hidden) {
    updateBackfillHint().catch(console.error); // hint tracks the picked date, not today
  } else if (todayEntry) {
    const shown = formatNumber(convert(todayEntry.weight, todayEntry.unit, unit));
    els.entryHint.textContent = `Logged today: ${shown} ${unit} — saving replaces it.`;
  } else {
    els.entryHint.textContent = '';
  }
}

// When backfilling, say what the picked date already holds — mis-picking a
// date must not silently destroy a measurement.
async function updateBackfillHint() {
  const date = els.entryDateInput.value;
  if (els.entryDateInput.hidden || !date) {
    els.entryHint.textContent = '';
    return;
  }
  const [existing, settings] = await Promise.all([store.getEntry(date), store.getSettings()]);
  if (existing) {
    const shown = formatNumber(convert(existing.weight, existing.unit, settings.unit));
    els.entryHint.textContent = `Logged ${fmtMedium(date)}: ${shown} ${settings.unit} — saving replaces it.`;
  } else {
    els.entryHint.textContent = `Will save to ${fmtMedium(date)}.`;
  }
}

function renderStats(entries, goal, unit) {
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

  const c7 = stats.changeOverDays(entries, unit, 7);
  const c30 = stats.changeOverDays(entries, unit, 30);
  const start = stats.sinceStart(entries, unit);
  setTile(els.tiles.d7, c7, c7 ? `vs ${fmtShort(c7.fromDate)}` : undefined);
  setTile(els.tiles.d30, c30, c30 ? `vs ${fmtShort(c30.fromDate)}` : undefined);
  setTile(els.tiles.start, start, start ? `since ${fmtShort(start.fromDate)}` : undefined);

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

function renderChartCard(entries, goal, unit) {
  els.chartTitle.textContent = `Weight (${unit})`;
  const hasData = entries.length > 0;
  els.chartWrap.hidden = !hasData;
  els.chartEmpty.hidden = hasData;
  if (hasData) renderChart(els.chartCanvas, entries, goal, unit);
}

function renderGoalCard(entries, goal, unit) {
  els.goalUnitSuffix.textContent = unit;
  els.goalForm.hidden = !state.goalFormOpen;
  els.goalEdit.hidden = state.goalFormOpen;
  els.goalClear.hidden = state.goalFormOpen || !goal;
  if (goal) {
    const target = formatNumber(convert(goal.targetWeight, goal.unit, unit));
    let text = `Target: ${target} ${unit}`;
    if (goal.targetDate) text += ` by ${fmtMedium(goal.targetDate)}`;
    els.goalSummary.textContent = text;
    els.goalEdit.textContent = 'Edit';
  } else {
    els.goalSummary.textContent = 'No goal set.';
    els.goalEdit.textContent = 'Set goal';
  }
}

function renderHistory(entries, unit) {
  els.historyList.textContent = '';
  els.historyEmpty.hidden = entries.length > 0;
  const newestFirst = [...entries].reverse();
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
    weightEl.textContent = `${formatNumber(convert(entry.weight, entry.unit, unit))} ${unit}`;
    main.append(dateEl, weightEl);
    if (entry.note) {
      const noteEl = document.createElement('span');
      noteEl.className = 'history-note';
      noteEl.textContent = entry.note; // untrusted text — textContent only
      main.append(noteEl);
    }

    const actions = document.createElement('div');
    actions.className = 'history-actions';
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'icon-btn';
    editBtn.setAttribute('aria-label', `Edit entry for ${fmtMedium(entry.date)}`);
    editBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';
    editBtn.addEventListener('click', () => startEdit(entry, unit));
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
      if (state.editingDate === entry.date) cancelEdit();
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

// ---------- entry form ----------

function startEdit(entry, unit) {
  state.editingDate = entry.date;
  state.editingOriginal = entry;
  state.editingPrefill = formatNumber(convert(entry.weight, entry.unit, unit));
  els.weightInput.value = state.editingPrefill;
  els.noteInput.value = entry.note ?? '';
  els.entryDateInput.hidden = true;
  els.entryDateInput.value = '';
  safeRefresh().then(() => {
    els.entryForm.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    els.weightInput.focus();
  });
}

function cancelEdit() {
  state.editingDate = null;
  state.editingOriginal = null;
  state.editingPrefill = null;
  els.weightInput.value = '';
  els.noteInput.value = '';
}

els.entryCancel.addEventListener('click', () => {
  cancelEdit();
  safeRefresh();
});

els.otherDayToggle.addEventListener('click', () => {
  els.entryDateInput.hidden = false;
  els.otherDayToggle.hidden = true;
  els.entryDateInput.max = todayISO();
  els.entryDateInput.value = todayISO();
  els.entryDateInput.focus();
  updateBackfillHint().catch(console.error);
});

els.entryDateInput.addEventListener('change', () => {
  updateBackfillHint().catch(console.error);
});

els.entryForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();

  // The date can roll over while the app stays open and visible (desktop past
  // midnight). Don't stamp a day the UI never showed — re-render and re-ask.
  if (!state.editingDate && state.renderedToday && state.renderedToday !== todayISO()) {
    await safeRefresh();
    toast("It's a new day — check the date, then save again.");
    return;
  }

  const raw = els.weightInput.value.trim().replace(',', '.');
  const weight = Number.parseFloat(raw);
  if (!Number.isFinite(weight) || weight <= 0 || weight >= 2000) {
    toast('Enter a weight between 0 and 2000.');
    els.weightInput.focus();
    return;
  }

  const settings = await store.getSettings();
  const note = els.noteInput.value.trim();
  let date;
  if (state.editingDate) {
    date = state.editingDate;
  } else if (!els.entryDateInput.hidden) {
    date = els.entryDateInput.value;
    if (!date) {
      toast('Pick a date, or cancel "Log a different day".');
      els.entryDateInput.focus();
      return;
    }
    if (date > todayISO()) {
      toast('No future dates — this app never invents data.');
      return;
    }
    if (date < '1900-01-01') {
      toast('That date looks wrong — double-check the year.');
      return;
    }
  } else {
    date = todayISO();
  }

  // Backfilling over an existing entry is destructive and easy to hit by
  // mis-picking a date — confirm it (today's overwrite is by design and the
  // card already says so).
  if (!state.editingDate && date !== todayISO()) {
    const existing = await store.getEntry(date);
    if (existing) {
      const shown = formatNumber(convert(existing.weight, existing.unit, settings.unit));
      if (!window.confirm(`Replace the ${fmtMedium(date)} entry (${shown} ${settings.unit})?`)) return;
    }
  }

  // Editing with an unchanged number keeps the original raw weight + unit, so
  // fixing a note never rewrites (and re-rounds) the stored measurement.
  const unchanged =
    state.editingOriginal && els.weightInput.value.trim() === state.editingPrefill;
  const entry = unchanged
    ? { date, weight: state.editingOriginal.weight, unit: state.editingOriginal.unit, note }
    : { date, weight, unit: settings.unit, note };

  const res = await withStore(() => store.saveEntry(entry), 'Could not save — storage failed.');
  if (!res.ok) return;
  const wasEditing = Boolean(state.editingDate);
  cancelEdit();
  els.entryDateInput.hidden = true;
  toast(wasEditing ? 'Entry updated' : 'Saved');
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

// ---------- settings ----------

for (const radio of els.unitRadios()) {
  radio.addEventListener('change', async () => {
    if (!radio.checked) return;
    const res = await withStore(() => store.saveSettings({ unit: radio.value }), 'Could not save settings.');
    if (!res.ok) return;
    if (state.editingDate) cancelEdit();  // prefilled number is in the old unit
    state.goalFormOpen = false;           // same for the goal form's prefill
    safeRefresh();
  });
}

els.exportBtn.addEventListener('click', async () => {
  const res = await withStore(() => store.exportCSV(), 'Could not export CSV.');
  if (!res.ok) return;
  const blob = new Blob([res.value], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `weight-history-${todayISO()}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast('CSV exported');
});

// ---------- environment hooks ----------

// Re-render (chart colors, etc.) when the OS theme flips.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => safeRefresh());

// If the app sits open overnight (common for a home-screen app), catch the
// date rollover when it becomes visible or focused again. (The submit handler
// also checks, for the window-stayed-visible-past-midnight case.)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.renderedToday !== todayISO()) {
    safeRefresh();
  }
});

window.addEventListener('focus', () => {
  if (state.renderedToday && state.renderedToday !== todayISO()) {
    safeRefresh();
  }
});

if ('serviceWorker' in navigator &&
    (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}

safeRefresh();
