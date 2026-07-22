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

// -> [{date, day, w}] sorted ascending, weights converted to `unit`
function normalize(entries, unit) {
  return entries
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

// Signed distance to goal: diff = current - target (positive = above target).
export function distanceToGoal(entries, goal, unit) {
  if (!goal) return null;
  const pts = normalize(entries, unit);
  if (pts.length === 0) return null;
  const latest = pts[pts.length - 1];
  const target = convert(goal.targetWeight, goal.unit, unit);
  return { current: latest.w, target, diff: latest.w - target, asOf: latest.date };
}
