# Weight Tracker (PWA)

A private, offline-first Progressive Web App for daily weight tracking. Plain
HTML/CSS/JavaScript + a vendored copy of Chart.js — **no framework, no build
step**. Deploys as static files (GitHub Pages) and installs to a phone home
screen as a standalone app.

## Architecture: the storage rule

**All reads/writes go through `js/storage.js`.** It exposes a fully async
interface (`saveEntry`, `getEntry`, `getAllEntries`, `deleteEntry`, `saveGoal`,
`getGoal`, `saveSettings`, `getSettings`, `exportCSV`) and is the **only** file
that touches `localStorage`. Swapping to a cloud backend (e.g. Supabase) later
means rewriting the internals of that one file — every caller already awaits
Promises, so nothing else changes.

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
```

Data notes:

- One entry per day; saving again the same day overwrites. Missed days stay
  gaps — nothing is interpolated or invented.
- Each entry stores the number **and the unit it was entered in**; toggling
  lbs/kg only converts at display time and never rewrites history.
- Everything lives in this browser's storage on this device. **Export CSV**
  (Settings) is your backup — use it now and then. On iPhone/iPad the export
  opens the native share sheet (choose **Save to Files** or send it on);
  on desktop and Android it downloads a `.csv`. Backing up matters more on
  iOS: if you don't open the app for ~7 days, Safari may clear its stored data.

## Run locally

ES modules and service workers need `http://`, not `file://`, so serve the
folder with any static server:

```bash
cd weight-tracker
npx serve .            # or: npx http-server -p 8080 .
```

Open the printed `http://localhost:…` URL. (Node.js is the only requirement;
any other static server works too.)

To test offline: open the app once, then in DevTools → Network tick
"Offline" and reload — it should still work.

To run the unit tests (37 checks over the storage contract, unit conversion,
and the trend/projection math — re-run these after any storage.js rewrite):

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

`date,weight,unit,note` — one row per entry, dates as `YYYY-MM-DD`, weight as
the raw number in the unit it was entered in. Notes are RFC-4180 quoted, so
commas/quotes in notes are safe. A note starting with `=`, `+`, `-`, or `@`
gets a leading space so spreadsheet apps don't misread it as a formula.
