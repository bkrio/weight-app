// tools/serve.mjs — a minimal, dependency-free static server for local testing.
//
// Why this exists: the app is built as ES modules, and browsers BLOCK ES modules
// (and service workers) on `file://` URLs. Opening index.html by double-clicking
// it makes the app look dead. Serve it over http instead — which is also how
// GitHub Pages serves it — and everything works.
//
// Run:  node tools/serve.mjs        (or double-click run-local.cmd)
// Then open the printed http://localhost:… URL.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo root = the parent of this tools/ directory, resolved from the script's
// own location so it works no matter where it's launched from. Strip any
// trailing separator so the traversal guard's `ROOT + sep` compares cleanly.
const ROOT = normalize(fileURLToPath(new URL('..', import.meta.url))).replace(/[\\/]+$/, '');
const PORT = Number(process.env.PORT) || 8123;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const filePath = normalize(join(ROOT, pathname));
    // Prevent path traversal outside the repo root.
    if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    const body = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-cache', // always serve the latest during local testing
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use.`);
    console.error(`Close whatever is using it, or run with a different port:  set PORT=8130 && node tools/serve.mjs\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`\nWeight Tracker is running.`);
  console.log(`Open  http://localhost:${PORT}/  in your browser.`);
  console.log(`Serving: ${ROOT}`);
  console.log(`Press Ctrl+C (or close this window) to stop.\n`);
});
