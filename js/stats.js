// stats.js — pure derived-stat math. No DOM, no storage.
// All functions take raw entries ({date, weight, unit, note}) that may be a mix
// of units, plus the display unit; every returned number is in the display unit.
// Sparse data returns null / an explanatory status — never interpolated values.

import { convert } from './units.js';

export const TREND_WINDOW_DAYS = 14; // regression window, anchored to the latest entry
export const TREND_MIN_POINTS = 3;   // fewer than this -> no trend
export const MAX_PROJECTION_DAYS = 365 * 5;

// Thresholds are defined in one canonical unit (lbs) and converted to the
// display unit, so flat/at-goal verdicts don't flip when the user toggles units.
const FLAT_SLOPE_LBS_PER_WEEK = 0.05;
const AT_GOAL_BAND_LBS = 0.05;

export function flatSlopeThreshold(unit) {
  return convert(FLAT_SLOPE_LBS_PER_WEEK, 'lbs', unit);
}

export function atGoalBand(unit) {
  return convert(AT_GOAL_BAND_LBS, 'lbs', unit);
}

// 'YYYY-MM-DD' -> integer day number. Parsed as UTC so the math is
// timezone-independent (we only ever deal in calendar dates).
export function epochDay(date) {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

// integer day number -> 'YYYY-MM-DD'
export function dayToISO(day) {
  const d = new Date(day * 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// -> [{date, day, w}] sorted ascending, weights converted to `unit`.
// Calorie-only days (no weight) are dropped — they are never weight data points,
// so they never affect the trend, chart, or since-start math.
function normalize(entries, unit) {
  return entries
    .filter((e) => e.weight != null && Number.isFinite(e.weight))
    .map((e) => ({ date: e.date, day: epochDay(e.date), w: convert(e.weight, e.unit, unit) }))
    .sort((a, b) => a.day - b.day);
}

// Least-squares linear regression over entries in the last TREND_WINDOW_DAYS
// (anchored at the latest entry's date). Returns null when there isn't enough
// data — callers must handle that, not invent a slope.
export function computeTrend(entries, unit) {
  const pts = normalize(entries, unit);
  if (pts.length === 0) return null;
  const anchor = pts[pts.length - 1].day;
  const win = pts.filter((p) => p.day > anchor - TREND_WINDOW_DAYS);
  if (win.length < TREND_MIN_POINTS) return null;

  const n = win.length;
  const meanX = win.reduce((s, p) => s + p.day, 0) / n;
  const meanY = win.reduce((s, p) => s + p.w, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of win) {
    sxx += (p.day - meanX) * (p.day - meanX);
    sxy += (p.day - meanX) * (p.w - meanY);
  }
  if (sxx === 0) return null; // all points on one day — can't happen with unique dates, but be safe
  const slopePerDay = sxy / sxx;
  const intercept = meanY - slopePerDay * meanX;
  return {
    slopePerDay,
    slopePerWeek: slopePerDay * 7,
    points: n,
    windowDays: TREND_WINDOW_DAYS,
    anchorDay: anchor,
    valueAtAnchor: slopePerDay * anchor + intercept,
  };
}

// Honest goal projection. Returns { status, ... } where status is one of:
//   'no-goal' | 'no-data' | 'at-goal' | 'trend-at-goal' | 'insufficient' |
//   'flat' | 'away' | 'too-far' | 'ok'
// 'at-goal' means the latest RAW weigh-in is within the at-goal band.
// 'trend-at-goal' means the fitted trend line has crossed the target while the
// latest raw point hasn't — carries { target, diff } (diff = latest - target)
// so the UI can say both things instead of contradicting the goal tile.
// 'ok' carries { projectedDate, anchorDate, daysOut, slopePerWeek, lateByDays } —
// lateByDays > 0 means the projection lands AFTER the user's target date.
export function projectGoal(entries, goal, unit) {
  if (!goal) return { status: 'no-goal' };
  const pts = normalize(entries, unit);
  if (pts.length === 0) return { status: 'no-data' };

  const target = convert(goal.targetWeight, goal.unit, unit);
  const latest = pts[pts.length - 1];
  const need = target - latest.w; // negative -> needs to lose weight

  if (Math.abs(need) < atGoalBand(unit)) return { status: 'at-goal', target };

  const trend = computeTrend(entries, unit);
  if (!trend) {
    return { status: 'insufficient', minPoints: TREND_MIN_POINTS, windowDays: TREND_WINDOW_DAYS };
  }
  if (Math.abs(trend.slopePerWeek) < flatSlopeThreshold(unit)) {
    return { status: 'flat', slopePerWeek: trend.slopePerWeek };
  }
  if (Math.sign(trend.slopePerDay) !== Math.sign(need)) {
    return { status: 'away', slopePerWeek: trend.slopePerWeek };
  }

  const daysOut = (target - trend.valueAtAnchor) / trend.slopePerDay;
  if (!Number.isFinite(daysOut) || daysOut <= 0) {
    return { status: 'trend-at-goal', target, diff: latest.w - target };
  }
  if (daysOut > MAX_PROJECTION_DAYS) {
    return { status: 'too-far', slopePerWeek: trend.slopePerWeek, daysOut };
  }

  const projectedDay = Math.round(trend.anchorDay + daysOut);
  const result = {
    status: 'ok',
    projectedDate: dayToISO(projectedDay),
    anchorDate: dayToISO(trend.anchorDay),
    daysOut: Math.round(daysOut),
    slopePerWeek: trend.slopePerWeek,
    lateByDays: null,
  };
  if (goal.targetDate) {
    result.lateByDays = projectedDay - epochDay(goal.targetDate);
  }
  return result;
}

// Change between the latest entry and the nearest entry AT OR BEFORE
// (latest - daysBack). Null when history doesn't reach back that far —
// never interpolated. Also null when the nearest baseline is far older than
// the label implies (a "7-day change" spanning months would be misleading).
export function changeOverDays(entries, unit, daysBack) {
  const pts = normalize(entries, unit);
  if (pts.length < 2) return null;
  const latest = pts[pts.length - 1];
  const cutoff = latest.day - daysBack;
  let base = null;
  for (const p of pts) {
    if (p.day <= cutoff) base = p; // sorted ascending -> ends at the closest qualifying entry
    else break;
  }
  if (!base) return null;
  if (latest.day - base.day > daysBack * 1.5) return null;
  return {
    delta: latest.w - base.w,
    fromDate: base.date,
    toDate: latest.date,
    spanDays: latest.day - base.day,
  };
}

// Latest vs the very first entry. Null with fewer than 2 entries.
export function sinceStart(entries, unit) {
  const pts = normalize(entries, unit);
  if (pts.length < 2) return null;
  const first = pts[0];
  const latest = pts[pts.length - 1];
  return {
    delta: latest.w - first.w,
    fromDate: first.date,
    toDate: latest.date,
    spanDays: latest.day - first.day,
  };
}

// Change since the start of a named phase: baseline = first weigh-in ON OR AFTER
// startDate; latest = last weigh-in. Null until there are two weigh-ins within
// the phase to compare. Never interpolated.
export function sincePhaseStart(entries, startDate, unit) {
  const startDay = epochDay(startDate);
  const pts = normalize(entries, unit).filter((p) => p.day >= startDay);
  if (pts.length < 2) return null;
  const first = pts[0];
  const latest = pts[pts.length - 1];
  return {
    delta: latest.w - first.w,
    fromDate: first.date,
    toDate: latest.date,
    spanDays: latest.day - first.day,
  };
}

export const RANGE_DAYS = { '1w': 7, '1m': 30, '3m': 90, '1y': 365 };

// Resolve a chart range selection to inclusive date bounds, or null for "show
// everything" (auto-fit). Pure — anchored to the data, no reference to "now".
//   'all'            -> null
//   '1w'|'1m'|'3m'|'1y' -> a window of that many days ENDING at the latest entry
//                          (so a window is never empty after a logging gap)
//   'phase:<id>'     -> that phase's span: [startDate, day before the next
//                          phase's start]; the current (latest) phase ends at the
//                          latest entry. Unknown/deleted id -> null (fall back to all).
export function chartRangeBounds(entries, range, periods = []) {
  if (!range || range === 'all') return null;

  const dates = entries.map((e) => e.date).filter((d) => typeof d === 'string').sort();
  const latest = dates.length ? dates[dates.length - 1] : null;

  if (range.startsWith('phase:')) {
    const id = range.slice('phase:'.length);
    const sorted = [...periods].sort((a, b) =>
      a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0
    );
    const idx = sorted.findIndex((p) => p.id === id);
    if (idx === -1) return null;
    const start = sorted[idx].startDate;
    const end =
      idx + 1 < sorted.length
        ? dayToISO(epochDay(sorted[idx + 1].startDate) - 1) // day before the next phase
        : latest && latest >= start
        ? latest // current phase runs to the most recent entry
        : start;
    return { start, end };
  }

  const days = RANGE_DAYS[range];
  if (!days || !latest) return null;
  return { start: dayToISO(epochDay(latest) - (days - 1)), end: latest };
}

// ---------- maintenance estimate (adaptive TDEE from the user's own data) ----------
// Energy balance: maintenance = avg intake - (weight-change/day x energy density).
// The weight slope is fit by least-squares over the window (all weigh-ins, not
// endpoints). Deliberately uses a RECENT window, not all history, because
// maintenance drifts with body mass + metabolic adaptation.

export const MAINT_WINDOW_DAYS = 28;   // trailing window for the "current" estimate
export const MAINT_MIN_WEIGH_INS = 10; // gate: weigh-ins within the window
export const MAINT_MIN_CAL_DAYS = 10;  // gate: calorie-logged days within the window
export const MAINT_MIN_SPAN_DAYS = 14; // gate: first->last weigh-in must span this
const KCAL_PER_LB = 3500;
const KCAL_PER_KG = 7700;
const MAINT_BAND_FLOOR = 75; // never imply more precision than the model has

// Maintenance over an explicit inclusive [startDate, endDate] window.
// Returns { status:'insufficient'|'ok', ... }.
export function maintenanceOverWindow(entries, unit, startDate, endDate) {
  const startDay = epochDay(startDate);
  const endDay = epochDay(endDate);
  const inWin = (d) => { const x = epochDay(d); return x >= startDay && x <= endDay; };

  const w = entries
    .filter((e) => e.weight != null && Number.isFinite(e.weight) && inWin(e.date))
    .map((e) => ({ day: epochDay(e.date), val: convert(e.weight, e.unit, unit) }))
    .sort((a, b) => a.day - b.day);
  const cals = entries
    .filter((e) => e.calories != null && Number.isFinite(e.calories) && inWin(e.date))
    .map((e) => e.calories);

  const span = w.length ? w[w.length - 1].day - w[0].day : 0;
  const insufficient = () => ({
    status: 'insufficient', weighIns: w.length, calDays: cals.length, spanDays: span,
    needWeighIns: MAINT_MIN_WEIGH_INS, needCalDays: MAINT_MIN_CAL_DAYS, needSpanDays: MAINT_MIN_SPAN_DAYS,
  });
  if (w.length < MAINT_MIN_WEIGH_INS || cals.length < MAINT_MIN_CAL_DAYS || span < MAINT_MIN_SPAN_DAYS) {
    return insufficient();
  }

  const n = w.length;
  const meanX = w.reduce((s, p) => s + p.day, 0) / n;
  const meanY = w.reduce((s, p) => s + p.val, 0) / n;
  let sxx = 0, sxy = 0;
  for (const p of w) { sxx += (p.day - meanX) * (p.day - meanX); sxy += (p.day - meanX) * (p.val - meanY); }
  if (sxx === 0) return insufficient();
  const slopePerDay = sxy / sxx; // weight units / day
  const intercept = meanY - slopePerDay * meanX;

  // Standard error of the slope -> a data-driven uncertainty band.
  let sse = 0;
  for (const p of w) { const fit = slopePerDay * p.day + intercept; sse += (p.val - fit) * (p.val - fit); }
  const seSlope = n > 2 ? Math.sqrt((sse / (n - 2)) / sxx) : 0;

  const avgIntake = cals.reduce((s, c) => s + c, 0) / cals.length;
  const kcalPerUnit = unit === 'kg' ? KCAL_PER_KG : KCAL_PER_LB;
  const maintenance = avgIntake - slopePerDay * kcalPerUnit;
  const half = Math.max(MAINT_BAND_FLOOR, seSlope * kcalPerUnit);
  const r10 = (x) => Math.round(x / 10) * 10;
  return {
    status: 'ok',
    maintenance: r10(maintenance),
    low: r10(maintenance - half),
    high: r10(maintenance + half),
    avgIntake: Math.round(avgIntake),
    slopePerWeek: slopePerDay * 7,
    weighIns: n, calDays: cals.length, spanDays: span,
    startDate, endDate,
  };
}

// Current maintenance: a trailing MAINT_WINDOW_DAYS window ending at the latest
// entry, clipped so it never reaches back across the current phase's start.
export function estimateMaintenance(entries, unit, periods = []) {
  const dates = entries.map((e) => e.date).filter((d) => typeof d === 'string').sort();
  if (!dates.length) return { status: 'no-data' };
  const end = dates[dates.length - 1];
  let startDay = epochDay(end) - (MAINT_WINDOW_DAYS - 1);
  let clippedPhase = null;
  if (periods.length) {
    const cur = [...periods].sort((a, b) => (a.startDate < b.startDate ? -1 : 1)).pop();
    const curStartDay = epochDay(cur.startDate);
    if (curStartDay > startDay) { startDay = curStartDay; clippedPhase = cur.name; }
  }
  const res = maintenanceOverWindow(entries, unit, dayToISO(startDay), end);
  res.clippedPhase = clippedPhase; // phase name if the window was shortened to it, else null
  return res;
}

// Historical view: maintenance within each phase's own span (uses all history,
// segmented at phase boundaries so a bulk isn't blended with a cut). Only phases
// with enough data are returned.
export function maintenanceByPhase(entries, unit, periods = []) {
  const sorted = [...periods].sort((a, b) => (a.startDate < b.startDate ? -1 : 1));
  const dates = entries.map((e) => e.date).filter((d) => typeof d === 'string').sort();
  const latest = dates.length ? dates[dates.length - 1] : null;
  const out = [];
  sorted.forEach((p, i) => {
    const start = p.startDate;
    const end = i + 1 < sorted.length
      ? dayToISO(epochDay(sorted[i + 1].startDate) - 1)
      : (latest && latest >= start ? latest : start);
    const res = maintenanceOverWindow(entries, unit, start, end);
    if (res.status === 'ok') out.push({ name: p.name, startDate: start, endDate: end, maintenance: res.maintenance });
  });
  return out;
}

// Signed distance to goal: diff = current - target (positive = above target).
export function distanceToGoal(entries, goal, unit) {
  if (!goal) return null;
  const pts = normalize(entries, unit);
  if (pts.length === 0) return null;
  const latest = pts[pts.length - 1];
  const target = convert(goal.targetWeight, goal.unit, unit);
  return { current: latest.w, target, diff: latest.w - target, asOf: latest.date };
}
