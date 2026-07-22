// units.js — pure unit conversion + number formatting. No DOM, no storage.

export const UNITS = ['lbs', 'kg'];
export const KG_PER_LB = 0.45359237; // exact by international definition

// Convert a weight between 'lbs' and 'kg'. Stored values are never rewritten —
// conversion happens only at display/compute time, so history can't be corrupted
// by toggling units.
export function convert(weight, from, to) {
  if (from === to) return weight;
  if (from === 'lbs' && to === 'kg') return weight * KG_PER_LB;
  if (from === 'kg' && to === 'lbs') return weight / KG_PER_LB;
  throw new TypeError(`Unknown unit conversion: ${from} -> ${to}`);
}

export function round1(n) {
  return Math.round(n * 10) / 10;
}

// 182.4 -> "182.4", 182.0 -> "182"
export function formatNumber(n) {
  const r = round1(n);
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

export function formatWeight(n, unit) {
  return `${formatNumber(n)} ${unit}`;
}

// Signed, for deltas: "+1.2", "-0.4", "0"
export function formatSigned(n) {
  const r = round1(n);
  if (r === 0) return '0';
  return (r > 0 ? '+' : '') + formatNumber(r);
}
