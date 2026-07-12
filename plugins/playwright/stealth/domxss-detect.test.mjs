// End-to-end proof for domxss-detect.mjs — the deterministic DOM-XSS backbone.
// Serves local pages with real DOM sinks (hash→innerHTML, search→innerHTML, postMessage→innerHTML,
// window.name→innerHTML) plus a SAFE control (textContent — encoded, inert). Then runs the real detector
// and asserts: (1) each vulnerable source is CONFIRMED via the execution beacon (window.__xh fired),
// (2) the safe control is NOT flagged (no false positive from encoded reflection),
// (3) the verdict is stable across repeated runs (the whole point — kill the agent-path flakiness).
// Zero external network.
//
// Requires the stealth deps + a Chromium (cd .. && npm install; npx playwright install chromium).
// Run:  node --test domxss-detect.test.mjs      (skips cleanly if deps/browser are missing)

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DETECT = path.join(HERE, 'domxss-detect.mjs');
const HAVE_DEPS = existsSync(path.join(HERE, 'node_modules', 'playwright-extra'));

const PAGE = (body) => `<!doctype html><html><head><meta charset="utf8"><title>domxss fixture</title></head>
<body><div id="out"></div>${body}</body></html>`;

// Each route is a distinct source→sink. The beacon payloads the detector injects are
// `<img src=x onerror="window.__xh('...')">` etc; innerHTML parses img/svg and fires onerror/onload.
const ROUTES = {
  '/vuln-hash':   PAGE(`<script>
    function render(){ document.getElementById('out').innerHTML = decodeURIComponent(location.hash.slice(1) || ''); }
    window.addEventListener('hashchange', render); render();
  </script>`),
  '/vuln-search': PAGE(`<script>
    var q = new URLSearchParams(location.search).get('q') || '';
    document.getElementById('out').innerHTML = q;
  </script>`),
  '/vuln-pm':     PAGE(`<script>
    window.addEventListener('message', function(e){ document.getElementById('out').innerHTML = e.data; });
  </script>`),
  '/vuln-name':   PAGE(`<script>
    document.getElementById('out').innerHTML = window.name || '';
  </script>`),
  '/safe':        PAGE(`<script>
    var q = new URLSearchParams(location.search).get('q') || '';
    document.getElementById('out').textContent = q;   // encoded → inert
  </script>`),
};

function server() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const url = req.url.split('?')[0].split('#')[0];
      const body = ROUTES[url];
      if (body == null) { res.writeHead(404); res.end('nope'); return; }
      res.writeHead(200, { 'content-type': 'text/html' }); res.end(body);
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

async function run(args) {
  const { stdout } = await execFileP('node', [DETECT, ...args], { timeout: 90000 });
  return JSON.parse(stdout.trim());   // the detector emits a single pretty-printed JSON object
}

test('domxss-detect: confirms hash sink via the execution beacon', { skip: !HAVE_DEPS && 'stealth deps missing' }, async () => {
  const s = await server(); const port = s.address().port;
  try {
    const r = await run(['--url', `http://127.0.0.1:${port}/vuln-hash`, '--sources', 'hash']);
    assert.equal(r.ok, true);
    assert.equal(r.verdict, 'DOM-XSS CONFIRMED');
    const hash = r.results.find((x) => x.source === 'hash');
    assert.equal(hash.executed, true, 'hash sink must fire the beacon');
  } finally { s.close(); }
});

test('domxss-detect: confirms search + postmessage + name sinks', { skip: !HAVE_DEPS && 'stealth deps missing' }, async () => {
  const s = await server(); const port = s.address().port;
  try {
    const search = await run(['--url', `http://127.0.0.1:${port}/vuln-search`, '--sources', 'search', '--param', 'q']);
    assert.equal(search.results.find((x) => x.source === 'search').executed, true, 'search sink');

    const pm = await run(['--url', `http://127.0.0.1:${port}/vuln-pm`, '--sources', 'postmessage']);
    assert.equal(pm.results.find((x) => x.source === 'postmessage').executed, true, 'postMessage sink');

    const name = await run(['--url', `http://127.0.0.1:${port}/vuln-name`, '--sources', 'name']);
    assert.equal(name.results.find((x) => x.source === 'name').executed, true, 'window.name sink');
  } finally { s.close(); }
});

test('domxss-detect: encoded reflection is NOT a false positive', { skip: !HAVE_DEPS && 'stealth deps missing' }, async () => {
  const s = await server(); const port = s.address().port;
  try {
    const r = await run(['--url', `http://127.0.0.1:${port}/safe`, '--sources', 'search,hash', '--param', 'q']);
    assert.equal(r.verdict, 'no DOM-XSS execution observed');
    assert.equal(r.results.every((x) => x.executed === false), true, 'a textContent (encoded) sink must never fire the beacon');
  } finally { s.close(); }
});

test('domxss-detect: verdict is reproducible across repeated runs (determinism)', { skip: !HAVE_DEPS && 'stealth deps missing' }, async () => {
  const s = await server(); const port = s.address().port;
  try {
    const a1 = await run(['--url', `http://127.0.0.1:${port}/vuln-hash`, '--sources', 'hash']);
    const a2 = await run(['--url', `http://127.0.0.1:${port}/vuln-hash`, '--sources', 'hash']);
    const a3 = await run(['--url', `http://127.0.0.1:${port}/vuln-hash`, '--sources', 'hash']);
    assert.equal(a1.verdict, a2.verdict);
    assert.equal(a2.verdict, a3.verdict);
    assert.equal(a1.verdict, 'DOM-XSS CONFIRMED', 'the same sink must confirm on every run — no run-to-run drop');
  } finally { s.close(); }
});
