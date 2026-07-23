// chart.js — Chart.js wiring for the weight graph. Reads data only via arguments
// (never storage), and reads its colors from the CSS custom properties so light
// and dark mode stay in sync with the stylesheet.
//
// Chart contents, deliberately: raw weight points as a 2px blue line (left axis),
// an optional orange calorie line (right axis) when any calories are logged, and
// a dashed horizontal goal line when a goal is set. No moving average, no
// interpolated points (missing values are gaps the line bridges).
//
// NOTE: this is a dual-axis chart by explicit request. The left (weight) and
// right (calorie) scales are independent, so where the two lines cross carries
// no meaning — read each line against its own axis.

import { convert, round1, formatNumber } from './units.js';

let chart = null;

function tokens() {
  const cs = getComputedStyle(document.documentElement);
  const t = (name) => cs.getPropertyValue(name).trim();
  return {
    series: t('--series'),
    series2: t('--series-2'),
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

// Small titles sitting in the top padding band, each above its own y-axis
// numbers: "Weight" over the left axis, "Calories" over the right — colored to
// match their lines so each axis is unmistakable.
const axisTitlesPlugin = {
  id: 'axisTitles',
  afterDraw(c, _args, opts) {
    if (!opts || !opts.left || !opts.right) return;
    const { ctx, chartArea } = c;
    if (!chartArea) return;
    const y = Math.max(10, chartArea.top - 12);
    ctx.save();
    ctx.font = '600 11px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = opts.left.color;
    ctx.textAlign = 'left';
    ctx.fillText(opts.left.text, 2, y);
    ctx.fillStyle = opts.right.color;
    ctx.textAlign = 'right';
    ctx.fillText(opts.right.text, c.width - 2, y);
    ctx.restore();
  },
};

// (Re)draws the chart from scratch — data volume is tiny, and rebuilding avoids
// stale-option bugs on unit/theme/goal changes.
export function renderChart(canvas, entries, goal, unit, range = null) {
  const tk = tokens();

  // One sorted list of every date so both series align by index — that lets the
  // tooltip show weight AND calories for the hovered day. Missing values are
  // null: no point is drawn and the line bridges the gap (spanGaps).
  const sorted = [...entries].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const weightData = sorted.map((e) => ({
    x: localDateMs(e.date),
    y: e.weight != null && Number.isFinite(e.weight) ? round1(convert(e.weight, e.unit, unit)) : null,
    date: e.date,
    note: e.note,
  }));
  const calData = sorted.map((e) => ({
    x: localDateMs(e.date),
    y: e.calories != null ? e.calories : null,
    date: e.date,
    note: e.note,
  }));

  const weightVals = weightData.map((p) => p.y).filter((v) => v != null);
  const calVals = calData.map((p) => p.y).filter((v) => v != null);
  const hasCal = calVals.length > 0;

  const goalY = goal ? round1(convert(goal.targetWeight, goal.unit, unit)) : null;

  // Scale the y-axes to what's VISIBLE in the selected window, so a short range
  // isn't flattened by the full history's spread. Fall back to all points when
  // the window has none (keeps a sensible axis rather than collapsing).
  const inRange = (p) => !range || (p.x >= range.startMs && p.x <= range.endMs);
  const wWin = weightData.filter((p) => p.y != null && inRange(p)).map((p) => p.y);
  const cWin = calData.filter((p) => p.y != null && inRange(p)).map((p) => p.y);
  const wSource = wWin.length ? wWin : weightVals;
  const cSource = cWin.length ? cWin : calVals;

  const wYs = wSource.concat(goalY != null ? [goalY] : []);
  const wMin = wYs.length ? Math.min(...wYs) : 0;
  const wMax = wYs.length ? Math.max(...wYs) : 1;
  const wPad = Math.max(2, (wMax - wMin) * 0.15);

  const cMin = cSource.length ? Math.min(...cSource) : 0;
  const cMax = cSource.length ? Math.max(...cSource) : 1;
  const cPad = Math.max(50, (cMax - cMin) * 0.15);

  const visible = wWin.length + cWin.length;
  const pointRadius = visible > 150 ? 2 : visible > 60 ? 3 : 4;

  const lineDataset = (extra) => ({
    borderWidth: 2,
    borderJoinStyle: 'round',
    borderCapStyle: 'round',
    tension: 0, // straight segments between real points — nothing implied
    fill: false,
    spanGaps: true, // bridge missing days; never invent a point
    pointRadius,
    pointHoverRadius: pointRadius + 2,
    pointBorderColor: tk.surface, // 2px surface ring keeps dots legible on the line
    pointBorderWidth: 2,
    pointHoverBorderColor: tk.surface,
    pointHoverBorderWidth: 2,
    pointHitRadius: 24, // hit target much bigger than the mark
    ...extra,
  });

  const datasets = [
    lineDataset({
      label: 'Weight',
      data: weightData,
      yAxisID: 'y',
      borderColor: tk.series,
      backgroundColor: tk.series,
      pointBackgroundColor: tk.series,
    }),
  ];
  if (hasCal) {
    datasets.push(
      lineDataset({
        label: 'Calories',
        data: calData,
        yAxisID: 'yCal',
        borderColor: tk.series2,
        backgroundColor: tk.series2,
        pointBackgroundColor: tk.series2,
      })
    );
  }

  const scales = {
    x: {
      type: 'time',
      time: {
        displayFormats: { day: 'MMM d', week: 'MMM d', month: 'MMM yyyy', quarter: 'MMM yyyy', year: 'yyyy' },
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
      ...(range ? { min: range.startMs, max: range.endMs } : {}),
    },
    y: {
      position: 'left',
      suggestedMin: wMin - wPad,
      suggestedMax: wMax + wPad,
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
  };
  if (hasCal) {
    scales.yCal = {
      position: 'right',
      suggestedMin: Math.max(0, cMin - cPad),
      suggestedMax: cMax + cPad,
      border: { display: false },
      grid: { display: false }, // the left (weight) axis owns the horizontal grid
      ticks: {
        color: tk.series2, // tinted orange to tie it to the calorie line
        font: { size: 11 },
        padding: 8,
        maxTicksLimit: 6,
        callback: (v) => Math.round(v).toLocaleString(),
      },
    };
  }

  if (chart) chart.destroy();
  chart = new window.Chart(canvas, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? false : { duration: 250 },
      interaction: { mode: 'index', axis: 'x', intersect: false },
      layout: { padding: { top: hasCal ? 26 : 14 } }, // room for the axis titles
      scales,
      plugins: {
        legend: { display: false }, // replaced by per-axis titles (axisTitles plugin)
        axisTitles: hasCal
          ? { left: { text: 'Weight', color: tk.series }, right: { text: 'Calories', color: tk.series2 } }
          : { left: null, right: null },
        goalLine: goalY != null
          ? { value: goalY, label: `Goal ${formatNumber(goalY)}`, color: tk.muted, labelColor: tk.secondary }
          : { value: null },
        crosshair: { color: tk.border },
        tooltip: {
          displayColors: hasCal, // a color key helps once there are two series
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
          filter: (item) => item.parsed.y != null, // hide the series with no value that day
          callbacks: {
            title: (items) => (items.length ? formatTooltipDate(items[0].raw.date) : ''),
            label: (item) =>
              item.dataset.yAxisID === 'yCal'
                ? `${Math.round(item.parsed.y).toLocaleString()} cal`
                : `${formatNumber(item.parsed.y)} ${unit}`,
            footer: (items) => {
              const withNote = items.find((it) => it.raw && it.raw.note);
              return withNote ? withNote.raw.note : '';
            },
          },
        },
      },
    },
    plugins: [goalLinePlugin, crosshairPlugin, axisTitlesPlugin],
  });
  return chart;
}
