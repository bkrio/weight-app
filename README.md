# Weight Tracker (PWA)

A private, offline-first Progressive Web App for daily weight tracking. Plain
HTML/CSS/JavaScript + a vendored copy of Chart.js — **no framework, no build
step**. Deploys as static files (GitHub Pages) and installs to a phone home
screen as a standalone app.

## Architecture: the storage rule

**All reads/writes go through `js/storage.js`.** It exposes a fully async
interface (`saveEntry`, `getEntry`, `getAllEntries`, `deleteEntry`, `saveGoal`,
`getGoal`, `saveSettings`, `getSettings`, `getPeriods`, `savePeriod`,
`deletePeriod`, `exportCSV`) and is the **only** file that touches
`localStorage`. Swapping to a cloud backend (e.g. Supabase) later means
rewriting the internals of that one file — every caller already awaits Promises,
so nothing else changes.

```
index.html         single page
styles.css         mobile-first styles, light/dark via prefers-color-scheme
js/storage.js      THE data layer (localStorage today, cloud later)
js/app.js          UI wiring
js/chart.js        Chart.js graph (raw entries + goal line)
js/stats.js        pure math: trend regression, projection, rolling changes
js/units.js        pure lbs↔kg conversion
vendor/            Chart.js + date adapter (vendored so offline works)
sw.js              service worker: precache app shell, cache-first
manifest.json      PWA manifest (standalone display)
icons/             app icons (any + maskable + apple-touch)
tools/serve.mjs    tiny local test server (no dependencies)
run-local.cmd      double-click to test locally on Windows
tests/run-tests.mjs  unit tests for the data + math layers
```

What you can log, per day:

- **Weight** (the morning fast path) and/or **calories** (optional). A day can
  be a weigh-in, a calorie log, or both. Calories are optional and reachable
  later — open the app that evening or the next day, and today's weigh-in is
  already prefilled so you can add calories without disturbing it. Use the **‹ ›
  arrows** by the date to scan to another day, **Jump to a date** for a far one,
  or the pencil in History.
- An optional **note** ("traveled", "high sodium").
- A **goal** (target weight + optional date), shown big on the Goal card header.
- A **phase** (e.g. "Summer cut") with a start date — the "Since start" stat then
  measures from your phase start and is labeled with the phase name. Start a new
  phase anytime; the most recent one is active. Once you have a past phase,
  History grows **tabs** to filter entries by phase.

The **Log** button doubles as a "have I logged today?" cue: it's blue **Log**
when there's something new to save, and turns grey **✓ Logged** once the fields
match what's stored. Editing a field flips it back to blue; your saved data
isn't changed until you press Log again.

Derived stats shown as text: current trend (lbs or kg per week, linear
regression), a projected goal date, and rolling changes — **1-day** (yesterday →
today), 7-day, 30-day, since phase/start, and distance to goal.

Data notes:

- One entry per day; saving again the same day updates it. Missed days stay
  gaps — nothing is interpolated or invented. Calorie-only days never appear on
  the weight graph or affect the weight trend.
- Weight is stored as the raw number **and the unit it was entered in**; toggling
  lbs/kg only converts at display time and never rewrites history.
- Everything lives in this browser's storage on this device. **Export CSV**
  (Settings) is your backup — use it now and then. On iPhone/iPad the export
  opens the native share sheet (choose **Save to Files** or send it on);
  on desktop and Android it downloads a `.csv`. Backing up matters more on
  iOS: if you don't open the app for ~7 days, Safari may clear its stored data.

## Run locally (test on your computer)

The app is built as ES modules, which browsers **block on `file://`** — so
double-clicking `index.html` makes it look dead (nothing saves, buttons don't
respond). Run it over `http://` instead:

- **Quickest (Windows):** double-click **`run-local.cmd`**. It starts a tiny
  local server and opens `http://localhost:8123/` in your browser. Keep the
  little black window open while you use it; close it to stop. (If the page
  doesn't load on the very first open, refresh once.)
- **Any platform:** `node tools/serve.mjs` then open the printed URL, or use any
  static server (`npx serve .`).

To test offline: open the app once over localhost, then in DevTools → Network
tick "Offline" and reload — it should still work.

Run the unit tests (data-layer contract, unit conversion, trend/projection math —
re-run after any `storage.js` change):

```bash
node tests/run-tests.mjs
```

## Deploy to GitHub Pages

1. Create a new GitHub repository (public is simplest for Pages), e.g.
   `weight-tracker`.
2. Push these files to the repo **root** on the `main` branch:

   ```bash
   cd weight-tracker
   git init
   git add .
   git commit -m "Weight tracker PWA"
   git branch -M main
   git remote add origin https://github.com/<your-username>/weight-tracker.git
   git push -u origin main
   ```

3. On GitHub: **Settings → Pages → Build and deployment** → Source:
   **Deploy from a branch** → Branch: `main`, folder `/ (root)` → **Save**.
4. Wait a minute or two, then open
   `https://<your-username>.github.io/weight-tracker/`.

All asset paths in the app are relative, so it works at that subpath with no
edits.

### Shipping updates

After changing any app file, **bump `CACHE_VERSION` in `sw.js`** (v1 → v2 → …)
and push. Installed phones pick the new version up on the next launch after
that (close the app fully, reopen twice if it seems stale). GitHub Pages'
own edge cache takes up to ~10 minutes to serve a new deploy, so wait a few
minutes after pushing before judging whether the update arrived.

## Install on your phone

The app must be served over HTTPS — the GitHub Pages URL, not localhost on
your PC — so do this after deploying.

**iPhone (Safari):**
1. Open your GitHub Pages URL in Safari.
2. Tap the **Share** button → **Add to Home Screen** → **Add**.
3. Launch from the home-screen icon — it opens fullscreen (standalone) and
   works offline.

**Android (Chrome):**
1. Open the URL in Chrome.
2. Tap the **⋮** menu → **Add to Home screen** (or the "Install app" prompt).
3. Launch from the icon.

## CSV export format

`date,weight,unit,note,calories` — one row per entry, dates as `YYYY-MM-DD`,
weight as the raw number in the unit it was entered in (blank on a calorie-only
day), calories as a whole number (blank when none). Notes are RFC-4180 quoted,
so commas/quotes in notes are safe. A note starting with `=`, `+`, `-`, or `@`
gets a leading space so spreadsheet apps don't misread it as a formula.
