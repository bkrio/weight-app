// chart.js — Chart.js wiring for the weight graph. Reads data only via arguments
// (never storage), and reads its colors from the CSS custom properties so light
// and dark mode stay in sync with the stylesheet.
//
// Chart contents, deliberately: the raw entries as a 2px line with point markers,
// plus a dashed horizontal goal line when a goal is set. No moving average, no
// interpolated points.

import { convert, round1, formatNumber } from './units.js';

let chart = null;

function tokens() {
  const cs = getComputedStyle(document.documentElement);
  const t = (name) => cs.getPropertyValue(name).trim();
  return {
    series: t('--series'),
    surface: t('--surface'),
    grid: t('--grid'),
    baseline: t('--baseline'),
    muted: t('--ink-muted'),
    secondary: t('--ink-secondary'),
    primary: t('--ink-primary'),
    raised: t('--surface-raised'),
    border: t('--border'),
  };
}

// 'YYYY-MM-DD' -> ms at LOCAL midnight, so a point never renders on the
// previous calendar day in the user's timezone (UTC parsing would).
function localDateMs(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

function formatTooltipDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

const goalLinePlugin = {
  id: 'goalLine',
  afterDatasetsDraw(c, _args, opts) {
    if (opts.value == null) return;
    const { ctx, chartArea, scales } = c;
    if (!chartArea) return;
    const y = scales.y.getPixelForValue(opts.value);
    if (y < chartArea.top || y > chartArea.bottom) return;
    ctx.save();
    ctx.strokeStyle = opts.color;
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(chartArea.left, y);
    ctx.lineTo(chartArea.right, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = '600 11px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.fillStyle = opts.labelColor;
    ctx.textAlign = 'right';
    const roomAbove = y - chartArea.top > 16;
    ctx.textBaseline = roomAbove ? 'bottom' : 'top';
    ctx.fillText(opts.label, chartArea.right - 2, roomAbove ? y - 5 : y + 5);
    ctx.restore();
  },
};

// Vertical hairline that snaps to the hovered/focused entry, under the marks.
const crosshairPlugin = {
  id: 'crosshair',
  beforeDatasetsDraw(c, _args, opts) {
    const active = c.tooltip?.getActiveElements?.() ?? [];
    if (!active.length) return;
    const { ctx, chartArea } = c;
    const x = active[0].element.x;
    ctx.save();
    ctx.strokeStyle = opts.color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

// (Re)draws the chart from scratch — data volume is tiny, and rebuilding avoids
// stale-option bugs on unit/theme/goal changes.
export function renderChart(canvas, entries, goal, unit) {
  const tk = tokens();

  const data = entries
    .filter((e) => e.weight != null && Number.isFinite(e.weight)) // calorie-only days aren't plotted
    .map((e) => ({
      x: localDateMs(e.date),
      y: round1(convert(e.weight, e.unit, unit)),
      date: e.date,
      note: e.note,
      calories: e.calories,
    }));
  const goalY = goal ? round1(convert(goal.targetWeight, goal.unit, unit)) : null;

  const ys = data.map((p) => p.y).concat(goalY != null ? [goalY] : []);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const pad = Math.max(2, (yMax - yMin) * 0.15);

  const n = data.length;
  const pointRadius = n > 150 ? 2 : n > 60 ? 3 : 4;

  if (chart) chart.destroy();
  chart = new window.Chart(canvas, {
    type: 'line',
    data: {
      datasets: [
        {
          data,
          borderColor: tk.series,
          backgroundColor: tk.series,
          borderWidth: 2,
          borderJoinStyle: 'round',
          borderCapStyle: 'round',
          tension: 0, // straight segments between real points — nothing implied
          fill: false,
          pointRadius,
          pointHoverRadius: pointRadius + 2,
          pointBackgroundColor: tk.series,
          pointBorderColor: tk.surface, // 2px surface ring keeps dots legible on the line
          pointBorderWidth: 2,
          pointHoverBorderColor: tk.surface,
          pointHoverBorderWidth: 2,
          pointHitRadius: 24, // hit target much bigger than the mark
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? false
        : { duration: 250 },
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      layout: { padding: { top: 14 } },
      scales: {
        x: {
          type: 'time',
          time: {
            displayFormats: {
              day: 'MMM d',
              week: 'MMM d',
              month: 'MMM yyyy',
              quarter: 'MMM yyyy',
              year: 'yyyy',
            },
          },
          grid: { display: false },
          border: { color: tk.baseline, width: 1 },
          ticks: {
            color: tk.muted,
            font: { size: 11 },
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 6,
            padding: 6,
          },
        },
        y: {
          suggestedMin: yMin - pad,
          suggestedMax: yMax + pad,
          border: { display: false },
          grid: { color: tk.grid, lineWidth: 1, drawTicks: false },
          ticks: {
            color: tk.muted,
            font: { size: 11 },
            padding: 8,
            maxTicksLimit: 6,
            callback: (v) => formatNumber(v),
          },
        },
      },
      plugins: {
        legend: { display: false }, // single series — the card title names it
        goalLine: goalY != null
          ? { value: goalY, label: `Goal ${formatNumber(goalY)}`, color: tk.muted, labelColor: tk.secondary }
          : { value: null },
        crosshair: { color: tk.border },
        tooltip: {
          displayColors: false,
          backgroundColor: tk.raised,
          borderColor: tk.border,
          borderWidth: 1,
          titleColor: tk.secondary,
          titleFont: { size: 12, weight: '400' },
          bodyColor: tk.primary,
          bodyFont: { size: 14, weight: '600' },
          footerColor: tk.secondary,
          footerFont: { size: 12, weight: '400' },
          padding: 10,
          cornerRadius: 8,
          caretSize: 5,
          callbacks: {
            title: (items) => formatTooltipDate(items[0].raw.date),
            label: (item) => `${formatNumber(item.raw.y)} ${unit}`,
            footer: (items) => {
              const r = items[0].raw;
              const parts = [];
              if (r.calories != null) parts.push(`${r.calories.toLocaleString()} cal`);
              if (r.note) parts.push(r.note);
              return parts.join(' · ');
            },
          },
        },
      },
    },
    plugins: [goalLinePlugin, crosshairPlugin],
  });
  return chart;
}
