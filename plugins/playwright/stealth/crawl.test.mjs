// End-to-end proof for crawl.mjs — the interaction-driven recon crawler.
// Serves a local page that mimics an ag-grid Server-Side Row Model: MANY POSTs to the SAME URL
// (/api/rows) with different bodies (load, pagination, sort, filter) plus one from an iframe. Then runs
// the real crawler and asserts it captures the operation VARIANTS (not one URL-deduped endpoint), collapses
// pagination, records bodies, and sees the cross-frame request. Zero external network.
//
// Requires the stealth deps + a Chromium (cd .. && npm install; npx playwright install chromium).
// Run:  node --test crawl.test.mjs      (skips cleanly if deps/browser are missing)

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
const CRAWL = path.join(HERE, 'crawl.mjs');
const HAVE_DEPS = existsSync(path.join(HERE, 'node_modules', 'playwright-extra'));

const HTML = `<!doctype html><html><head><meta charset="utf8"><title>SSRM demo</title></head><body>
<input type="search" id="q" placeholder="filter">
<table><thead><tr><th role="columnheader" id="amt" aria-sort="none">Amount</th></tr></thead></table>
<div id="grid" style="height:160px;overflow:auto"><div style="height:3000px">rows</div></div>
<iframe src="/frame" style="width:300px;height:80px"></iframe>
<script>
const post = (b) => fetch('/api/rows', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(b) });
const base = (sr) => ({ startRow:sr, endRow:sr+100, filterModel:{}, sortModel:[], rowGroupCols:[] });
// load-time: the SSRM asks for 3 blocks as it renders — same operation, different startRow (MUST collapse)
post(base(0)); setTimeout(() => post(base(100)), 120); setTimeout(() => post(base(200)), 260);
// pagination on scroll (also collapses into the baseline)
document.getElementById('grid').addEventListener('scroll', () => post(base(900)));
// sort — a DISTINCT operation
document.getElementById('amt').addEventListener('click', () =>
  post({ startRow:0, endRow:100, filterModel:{}, sortModel:[{colId:'amount', sort:'asc'}], rowGroupCols:[] }));
// filter — a DISTINCT operation (fires on Enter)
document.getElementById('q').addEventListener('keydown', (e) => { if (e.key === 'Enter')
  post({ startRow:0, endRow:100, filterModel:{ keyword:{ type:'contains', filter:e.target.value } }, sortModel:[], rowGroupCols:[] }); });
</script></body></html>`;

const FRAME = `<!doctype html><html><body><script>
fetch('/api/rows', { method:'POST', headers:{'content-type':'application/json'},
  body: JSON.stringify({ startRow:0, endRow:100, filterModel:{}, sortModel:[], rowGroupCols:[], source:'iframe' }) });
</script></body></html>`;

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/rows') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ rows: [], lastRow: 500 })); return; }
      if (req.url === '/frame') { res.setHeader('content-type', 'text/html'); res.end(FRAME); return; }
      res.setHeader('content-type', 'text/html'); res.end(HTML);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

test('crawl.mjs captures same-URL POST variants + pagination collapse + cross-frame + bodies', { skip: HAVE_DEPS ? false : 'stealth deps/browser not installed' }, async () => {
  const { srv, port } = await startServer();
  try {
    const url = `http://127.0.0.1:${port}/`;
    const { stdout } = await execFileP(process.execPath,
      [CRAWL, '--url', url, '--scope', '127.0.0.1', '--scroll', '3', '--max-views', '2'],
      { timeout: 90000, maxBuffer: 16 * 1024 * 1024 });
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true, out.error || 'crawl ok');

    const rows = out.endpoints.find((e) => e.path === '/api/rows' && e.method === 'POST');
    assert.ok(rows, 'POST /api/rows captured');

    // URL-dedup alone would report 1 endpoint; the fix keeps operation VARIANTS as distinct surfaces.
    assert.ok(rows.variant_count >= 3, `expected >=3 body-signature variants, got ${rows.variant_count}`);

    // Pagination collapse: the 3+ same-operation startRow POSTs fold into ONE high-count variant.
    const maxCount = Math.max(...rows.variants.map((v) => v.count));
    assert.ok(maxCount >= 3, `pagination should collapse into one variant (>=3), got ${maxCount}`);

    // Interaction-driven: a sort or filter operation was actually triggered by the crawler and captured.
    assert.ok(rows.variants.some((v) => /amount|contains|keyword/.test(v.signature)),
      'sort/filter POST captured via real interaction');

    // Request bodies are captured (not just method+URL).
    assert.ok(rows.variants.every((v) => v.sample_body && v.sample_body.includes('filterModel')), 'POST bodies captured');

    // Cross-frame: the iframe request was captured (context-level, all frames).
    assert.ok(rows.frames.some((f) => f.includes('/frame')), `iframe request captured, frames=${JSON.stringify(rows.frames)}`);

    // param-inventory slice carries the body field names for downstream injection/BOLA routing.
    const pi = out.param_inventory.find((e) => e.endpoint === '/api/rows');
    assert.ok(pi && pi.params.some((p) => p.in === 'json' && /filterModel/.test(p.name)), 'body params flattened into param-inventory');

    // Surface the before/after for humans.
    console.log(`  before (URL-dedup): 1 endpoint /api/rows`);
    console.log(`  after  (signature): ${rows.variant_count} distinct operation variants, bodies captured, iframe seen`);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

// Phase 3 — interaction depth in READ recon: a picker-select fires GET /api/items?name=<item> (the incident
// class). crawl.mjs alone (no crud/write crawler) must now trigger AND capture it, plus raw-traffic + completeness.
const PICKER_HTML = `<!doctype html><html><head><meta charset=utf8></head><body>
<h1>Invoice</h1>
<div id="cb" role="combobox" tabindex="0">Select item</div>
<div id="lb" role="listbox" style="display:none">
  <input id="s" placeholder="search items"><div role="option" data-v="alpha">alpha</div><div role="option" data-v="beta">beta</div>
</div>
<table><tbody><tr role="row"><td>row-one</td></tr></tbody></table>
<script>
document.getElementById('cb').addEventListener('click',()=>{document.getElementById('lb').style.display='block';});
document.getElementById('s').addEventListener('input',(e)=>{fetch('/api/items?keyword='+encodeURIComponent(e.target.value));});
document.querySelectorAll('#lb [role=option]').forEach(o=>o.addEventListener('click',()=>{fetch('/api/items?limit=10&page=1&name='+encodeURIComponent(o.getAttribute('data-v')));document.getElementById('lb').style.display='none';}));
document.querySelector('tr[role=row] td').addEventListener('click',()=>{fetch('/api/orders/123');});
</script></body></html>`;
function startPickerServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url.startsWith('/api/items') || req.url.startsWith('/api/orders')) { res.setHeader('content-type', 'application/json'); res.end('[]'); return; }
      res.setHeader('content-type', 'text/html'); res.end(PICKER_HTML);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

test('crawl.mjs interaction engine fires + captures the picker-select read (?name) and row-drill in READ recon', { skip: HAVE_DEPS ? false : 'stealth deps/browser not installed' }, async () => {
  const { srv, port } = await startPickerServer();
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(path.join(tmpdir(), 'crawlpk-'));
  try {
    const { stdout } = await execFileP(process.execPath,
      [CRAWL, '--url', `http://127.0.0.1:${port}/`, '--scope', '127.0.0.1', '--scroll', '1', '--max-views', '1', '--max-options', '2', '--out', dir],
      { timeout: 90000, maxBuffer: 16 * 1024 * 1024 });
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true, out.error || 'crawl ok');
    // *** the incident, in read recon *** — the picker-select ?name= read is now an endpoint with `name`
    const items = out.endpoints.find((e) => e.path === '/api/items' && e.method === 'GET');
    assert.ok(items, `picker-select GET /api/items captured (got ${out.endpoints.map((e) => e.method + ' ' + e.path)})`);
    assert.ok(items.params.includes('query:name'), `the ?name param is captured (got ${items.params})`);
    // row-drill fired the detail GET
    assert.ok(out.endpoints.some((e) => e.path === '/api/orders/{id}' && e.method === 'GET'), 'row-drill GET …/{id} captured');
    // Phase 2 artifacts: completeness block + raw-traffic corpus
    assert.ok(out.completeness && out.completeness.observed_requests > 0, 'completeness block present');
    const raw = readFileSync(path.join(dir, 'raw-traffic.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(raw.some((r) => r.path === '/api/items' && /name=/.test(r.query || '')), 'raw-traffic.jsonl carries the picker read');
  } finally { rmSync(dir, { recursive: true, force: true }); srv.close(); }
});
