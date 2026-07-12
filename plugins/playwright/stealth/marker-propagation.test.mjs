// Proof for marker-propagation.mjs — the generic second-order (write→read) taint primitive.
// A value written by crawl-write carries a canary marker; this tool finds WHERE it resurfaces (a different
// read endpoint), classifies the reflection context, and — in --render mode — confirms EXECUTION via the
// window.__xh beacon (stored XSS). Reusable by xss (sink reachable?), injection (stored SQLi target), idor
// (which read exposes a created object).
//
// The static-HAR search needs no browser (always runs). The --render tests need the stealth deps + Chromium
// and skip cleanly without them.
//
// Run:  node --test marker-propagation.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MP = path.join(HERE, 'marker-propagation.mjs');
const HAVE_DEPS = existsSync(path.join(HERE, 'node_modules', 'playwright-extra'));

async function run(args) {
  const { stdout } = await execFileP('node', [MP, ...args], { timeout: 90000 });
  return JSON.parse(stdout.trim());
}

// canary: alnum core PENTEST7 proves reachability even if encoded; the <'"> metachars prove un-encoded reflection
const CANARY = `PENTEST7<'">`;

test('static HAR: finds the marker at a DIFFERENT read endpoint and separates raw vs encoded', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mp-'));
  try {
    const har = { log: { entries: [
      // the WRITE (POST) that stored the canary — a comment create
      { request: { url: 'https://app.example.com/api/comments', method: 'POST', postData: { text: `{"body":"${CANARY}"}` } },
        response: { content: { mimeType: 'application/json', text: '{"id":42}' } } },
      // a READ endpoint that reflects it RAW into HTML (dangerous — un-encoded, sink present)
      { request: { url: 'https://app.example.com/thread', method: 'GET' },
        response: { content: { mimeType: 'text/html', text: `<div class=c>${CANARY}</div><script>x.innerHTML=y</script>` } } },
      // another READ endpoint that reflects it HTML-ENCODED (inert)
      { request: { url: 'https://app.example.com/thread/safe', method: 'GET' },
        response: { content: { mimeType: 'text/html', text: `<div>PENTEST7&lt;&#39;&quot;&gt;</div>` } } },
    ] } };
    const harPath = path.join(dir, 'crawl.har');
    await writeFile(harPath, JSON.stringify(har));
    const r = await run(['--marker', CANARY, '--har', harPath, '--scope', 'example.com']);
    assert.equal(r.ok, true);
    const raw = r.surfaced_at.find((s) => s.url === 'https://app.example.com/thread');
    const enc = r.surfaced_at.find((s) => s.url === 'https://app.example.com/thread/safe');
    assert.ok(raw, 'raw-reflecting read endpoint surfaced');
    assert.equal(raw.metachars_unencoded, true, 'metachars survived un-encoded → dangerous');
    assert.equal(raw.sink_reachable, true, 'un-encoded reflection in an executable context = sink reachable');
    assert.ok(enc, 'encoded read endpoint surfaced (reachability) ...');
    assert.equal(enc.metachars_unencoded, false, '... but inert (encoded)');
    assert.equal(r.verdict, 'STORED XSS LIKELY (un-encoded cross-endpoint reflection)');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('static HAR: marker never resurfaces → not reachable', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mp-'));
  try {
    const har = { log: { entries: [
      { request: { url: 'https://app.example.com/x', method: 'GET' },
        response: { content: { mimeType: 'text/html', text: '<div>nothing here</div>' } } },
    ] } };
    const harPath = path.join(dir, 'c.har');
    await writeFile(harPath, JSON.stringify(har));
    const r = await run(['--marker', CANARY, '--har', harPath]);
    assert.equal(r.reachable_sink, false);
    assert.equal(r.verdict, 'marker not observed at any read endpoint');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('render + beacon: a stored payload EXECUTING at the read endpoint is CONFIRMED', { skip: !HAVE_DEPS && 'stealth deps missing' }, async () => {
  // The read page renders a "stored" value into innerHTML. The stored value is the beacon payload — as if
  // crawl-write had submitted it earlier. Loading the read endpoint must fire window.__xh → confirmed.
  const stored = `<img src=x onerror="window.__xh('stored')">`;
  const s = http.createServer((req, res) => {
    if (req.url.startsWith('/thread')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><body><div id=o></div>
        <script>document.getElementById('o').innerHTML = ${JSON.stringify(stored)};</script></body></html>`);
    } else { res.writeHead(404); res.end('x'); }
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  try {
    const r = await run(['--marker', '__xh', '--read-url', `http://127.0.0.1:${port}/thread`, '--render']);
    const hit = r.surfaced_at.find((x) => x.url.includes('/thread'));
    assert.ok(hit, 'read endpoint present');
    assert.equal(hit.executed, true, 'the stored payload executed on render → confirmed');
    assert.equal(r.verdict, 'STORED XSS CONFIRMED');
  } finally { s.close(); }
});

test('render: an ENCODED stored value does NOT execute (no false positive)', { skip: !HAVE_DEPS && 'stealth deps missing' }, async () => {
  const s = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    // textContent → inert; the canary is visible but never executes
    res.end(`<!doctype html><html><body><div id=o></div>
      <script>document.getElementById('o').textContent = ${JSON.stringify(CANARY)};</script></body></html>`);
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  try {
    const r = await run(['--marker', CANARY, '--read-url', `http://127.0.0.1:${port}/p`, '--render']);
    const hit = r.surfaced_at.find((x) => x.url.includes('/p'));
    assert.ok(hit, 'marker surfaced in the rendered DOM (reachability)');
    assert.notEqual(hit.executed, true, 'encoded/textContent value must never execute');
    assert.notEqual(r.verdict, 'STORED XSS CONFIRMED');
  } finally { s.close(); }
});
