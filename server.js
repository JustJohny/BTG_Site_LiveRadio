/**
 * BeTheGrid — Simple static file server.
 * Serves the Site/ folder over HTTP so fetch() of JSON data works
 * (file:// protocol blocks XHR/fetch to local files).
 *
 * Usage:  node server.js   → http://localhost:8080
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8'
};

function contentType(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

// In-memory messages for the live radio stand-in (see /api/radio-poll below).
const RADIO_TEST = { lastId: 0, messages: [], enabled: {}, lastSend: {} };

const server = http.createServer((req, res) => {
  // Normalize URL, default to index.html
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('Bad Request'); return;
  }
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  // ── Local stand-in for the live radio backend (development only) ──────
  // Answers in the same shape as the database functions in
  // sql/radio-send-to-game.sql, so the site's Send button and the in-game
  // pop-up can be tested on this PC without the real backend.
  //   GET  /api/radio-poll?p_series=F1&p_after=N   what the game mod calls
  //   POST /api/radio-rpc/radio_status | radio_send | radio_set_enabled
  //                                                what radio-creator.html calls on localhost
  //   GET  /api/radio-test-send                    queue a sample message (open in a browser)
  //     optional: series, name, number, colour (rrggbb, no #), logo, text,
  //               reply, burst=N (N messages), old=1 (90 s old: must be skipped)
  // Differences from the real thing: any login token is accepted and treated
  // as an admin, every series starts switched ON, and nothing is saved.
  if (urlPath === '/api/radio-poll' || urlPath === '/api/radio-test-send' || urlPath.startsWith('/api/radio-rpc/')) {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const norm = (v) => { const u = String(v || '').trim().toUpperCase(); return u === 'GT1' ? 'XGT' : u; };
    const isOn = (series) => RADIO_TEST.enabled[series] !== false;
    const send = (obj) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };

    if (urlPath.startsWith('/api/radio-rpc/')) {
      const fn = urlPath.slice('/api/radio-rpc/'.length);
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 100000) req.destroy(); });
      req.on('end', () => {
        let b = {};
        try { b = JSON.parse(raw || '{}'); } catch (e) { send({ ok: false, error: 'bad_json' }); return; }
        const series = norm(b.p_series);
        const loggedIn = typeof b.p_token === 'string' && b.p_token.length >= 8;
        if (fn === 'radio_status') { send({ ok: true, series, enabled: isOn(series) }); return; }
        if (fn === 'radio_set_enabled') {
          if (!loggedIn) { send({ ok: false, error: 'unauthorized' }); return; }
          RADIO_TEST.enabled[series] = !!b.p_enabled;
          send({ ok: true, series, enabled: isOn(series) });
          return;
        }
        if (fn === 'radio_send') {
          if (!isOn(series)) { send({ ok: false, error: 'radio_off' }); return; }
          const p = b.p_payload || {};
          const lines = Array.isArray(p.lines) ? p.lines : [];
          if (lines.length < 1 || lines.length > 4) { send({ ok: false, error: 'bad_payload', field: 'lines' }); return; }
          if (lines.some((l) => !l || !String(l.text || '').trim() || String(l.text).length > 140)) { send({ ok: false, error: 'bad_payload', field: 'line_text' }); return; }
          if (!/^#[0-9a-fA-F]{6}$/.test(String(p.colour || ''))) { send({ ok: false, error: 'bad_payload', field: 'colour' }); return; }
          if (!loggedIn) { send({ ok: false, error: 'unauthorized' }); return; }
          if (Date.now() - (RADIO_TEST.lastSend[b.p_token] || 0) < 10000) { send({ ok: false, error: 'too_fast' }); return; }
          RADIO_TEST.lastSend[b.p_token] = Date.now();
          RADIO_TEST.messages.push({ id: ++RADIO_TEST.lastId, series, at: Date.now(), payload: p });
          send({ ok: true, id: RADIO_TEST.lastId });
          return;
        }
        send({ ok: false, error: 'unknown_function' });
      });
      return;
    }

    if (urlPath === '/api/radio-test-send') {
      const series = norm(q.get('series') || 'F1');
      const burst = Math.max(1, Math.min(12, parseInt(q.get('burst') || '1', 10) || 1));
      const ids = [];
      for (let i = 0; i < burst; i++) {
        const lines = [{ from: 'engineer', label: 'ENGINEER', text: (q.get('text') || 'Box this lap, box this lap.') + (burst > 1 ? ' (' + (i + 1) + '/' + burst + ')' : '') }];
        lines.push({ from: 'driver', label: '', text: q.get('reply') || 'Copy, coming in.' });
        RADIO_TEST.messages.push({
          id: ++RADIO_TEST.lastId,
          series,
          at: Date.now() - (q.get('old') ? 90000 : 0),
          payload: {
            name: (q.get('name') || 'Hamilton').toUpperCase(),
            number: q.get('number') || '44',
            team: 'FERRARI',
            colour: '#' + (q.get('colour') || 'e8002d').replace(/[^0-9a-fA-F]/g, '').slice(0, 6).toLowerCase(),
            textColour: '#ffffff',
            logo: q.get('logo') === null ? 'logos/mini/Ferrari.png' : q.get('logo'),
            lines
          }
        });
        ids.push(RADIO_TEST.lastId);
      }
      send({ ok: true, queued: ids, series });
      return;
    }

    const series = norm(q.get('p_series'));
    const mine = RADIO_TEST.messages.filter((m) => m.series === series);
    const max = mine.length ? mine[mine.length - 1].id : 0;
    if (q.get('p_after') === null || !isOn(series)) { send({ ok: true, enabled: isOn(series), cursor: max, messages: [] }); return; }
    const after = parseInt(q.get('p_after'), 10) || 0;
    const fresh = mine.filter((m) => m.id > after).slice(0, 10);
    send({
      ok: true, enabled: true,
      cursor: fresh.length === 10 ? fresh[9].id : Math.max(max, after),
      messages: fresh.map((m) => ({ id: m.id, age_ms: Date.now() - m.at, payload: m.payload }))
    });
    return;
  }

  // API: list series folders under Data/ (auto-discovery)
  if (urlPath === '/api/series') {
    const dataDir = path.join(ROOT, 'Data');
    fs.readdir(dataDir, { withFileTypes: true }, (err, entries) => {
      if (err) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('[]'); return; }
      const series = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(series));
    });
    return;
  }

  // API: list all files (recursive) inside a series folder
  // e.g. /api/series-files?series=XGT
  if (urlPath === '/api/series-files') {
    const url = new URL(req.url, 'http://localhost');
    const series = url.searchParams.get('series');
    if (!series || /[\\/]|\.\./.test(series)) {
      res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"invalid series"}'); return;
    }
    const dir = path.join(ROOT, 'Data', series);
    const dataRoot = path.resolve(ROOT, 'Data');
    const resolvedDir = path.resolve(dir);
    if (resolvedDir !== dataRoot && !resolvedDir.startsWith(dataRoot + path.sep)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    // A series may exist only in the roster (e.g. F2 has no folder yet) — in
    // that case there are simply no files to list.
    if (!fs.existsSync(dir)) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end('[]');
      return;
    }
    const out = [];
    (function walk(d) {
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      entries.forEach((e) => {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile()) out.push(path.relative(dir, full).split(path.sep).join('/'));
      });
    })(dir);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(out.sort()));
    return;
  }

  // API: list all available logo images under logos/ (auto-populates the admin
  // team-logo picker). Returns relative paths, e.g. ["teams/Haas.png",
  // "mini/Redbull.png", "f1.png"]. Static hosts fall back to logos/logos-manifest.json.
  if (urlPath === '/api/team-logos') {
    const logosDir = path.join(ROOT, 'logos');
    const IMG_EXT = ['.png', '.webp', '.svg', '.jpg', '.jpeg', '.gif'];
    const out = [];
    (function walk(d, rel) {
      if (!fs.existsSync(d)) return;
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      entries.forEach((e) => {
        const full = path.join(d, e.name);
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) walk(full, r);
        else if (e.isFile() && IMG_EXT.indexOf(path.extname(e.name).toLowerCase()) !== -1) out.push(r.split(path.sep).join('/'));
      });
    })(logosDir, '');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(out.sort()));
    return;
  }

  // Reject backslashes, parent traversal, and null bytes before touching the disk.
  if (/[\\]|\.\.|\0|%00/i.test(urlPath)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  let filePath = path.normalize(path.join(ROOT, urlPath));

  // Prevent path traversal outside ROOT (ROOT itself or a child path only).
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // Not found — try index.html fallback for clean paths
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found: ' + urlPath);
      return;
    }
    fs.readFile(filePath, (err2, data) => {
      if (err2) { res.writeHead(500); res.end('Server error'); return; }
      res.writeHead(200, { 'Content-Type': contentType(filePath) });
      res.end(data);
    });
  });
});

// Graceful handling if the port is already in use (e.g. F5 launched twice,
// or a dev server is already running). Exit 0 so the preLaunchTask passes
// and the browser simply connects to the existing server.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('Port ' + PORT + ' already in use — using existing server on http://localhost:' + PORT);
    process.exit(0);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log('BeTheGrid server running at http://localhost:' + PORT);
});
