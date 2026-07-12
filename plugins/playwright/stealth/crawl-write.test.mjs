// End-to-end test for crawl-write.mjs — the gated interactive WRITE-mode exerciser. Drives a real browser
// (stealth harness) against a stub app with a JSON create form, asserting: dry-run submits nothing; armed
// runs capture the marker-tagged POST + created {id}; an unmarked submit is refused; a destructive-only
// control is never clicked; a validation error triggers a retry. Needs the stealth deps + chromium.
// Run:  node --test crawl-write.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, 'crawl-write.mjs');

const page = (body) => `<!doctype html><html><head><meta charset=utf-8></head><body>${body}</body></html>`;
// A JSON create form: inputs + a Create button that POSTs application/json (the modern SPA shape).
const createForm = (action) => page(`
  <h1>New vendor</h1>
  <form onsubmit="return false">
    <input name="name" type="text" required>
    <input name="email" type="email">
    <input name="amount" type="number" min="1">
    <select name="kind"><option value="">--</option><option value="supplier">supplier</option></select>
    <button type="button" id="go">Create</button>
  </form>
  <script>
    document.getElementById('go').addEventListener('click', () => {
      const b = { name: document.querySelector('[name=name]').value,
                  email: document.querySelector('[name=email]').value,
                  amount: Number(document.querySelector('[name=amount]').value),
                  kind: document.querySelector('[name=kind]').value };
      fetch('${action}', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })
        .then(r => r.json()).then(j => { document.title = 'ok ' + (j.id || ''); });
    });
  </script>`);

function readBody(req) { return new Promise((res) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => res(d)); }); }

// Server records every write it receives. `strictCounter` makes /api/v1/strict fail the FIRST POST (422).
function startServer() {
  const writes = [];
  let strictHits = 0;
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/') return html(res, page('<a href="/vendors/new">Create vendor</a> <a href="/strict/new">strict</a> <a href="/danger/new">danger</a>'));
    // deep page: reached only via a NON-create-labelled link ("Settings"), and a logout link that must NOT be followed
    if (req.method === 'GET' && u.pathname === '/deep') return html(res, page('<a href="/settings/panel">Settings</a> <a href="/logout">Log out</a>'));
    if (req.method === 'GET' && u.pathname === '/settings/panel') return html(res, createForm('/api/v1/settings'));
    if (req.method === 'GET' && u.pathname === '/logout') { writes.push({ path: '/logout', body: '' }); return html(res, page('bye')); }
    if (req.method === 'POST' && u.pathname === '/api/v1/settings') {
      const body = await readBody(req); writes.push({ path: u.pathname, body });
      res.writeHead(201, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ id: 'set-9' }));
    }
    if (req.method === 'GET' && u.pathname === '/vendors/new') return html(res, createForm('/api/v1/vendors'));
    if (req.method === 'GET' && u.pathname === '/strict/new') return html(res, createForm('/api/v1/strict'));
    // picker-first form the deterministic filler cannot complete (a combobox + a primary action, no fillable inputs)
    if (req.method === 'GET' && u.pathname === '/picker/new') return html(res, page('<h1>New invoice</h1><div role="combobox" aria-label="Search a Buyer"><input aria-autocomplete="list" placeholder="Search a Buyer"></div><button type="button" id="c">Create Invoice</button>'));
    // complex NO-PICKER form the backbone clicks-submits but that fires no write (validation-gated) → submit-no-write
    if (req.method === 'GET' && u.pathname === '/gated/new') return html(res, page('<h1>Wire transfer</h1><form onsubmit="return false"><input name="beneficiary" required><input name="iban" required><button type="button" id="g">Save</button></form>'));
    if (req.method === 'GET' && u.pathname === '/danger/new') return html(res, page('<form onsubmit="return false"><input name="name"><button type="button" id="d">Delete</button></form>'));
    if (req.method === 'POST' && u.pathname === '/api/v1/vendors') {
      const body = await readBody(req); writes.push({ path: u.pathname, body });
      res.writeHead(201, { 'Content-Type': 'application/json', Location: '/api/v1/vendors/4242' });
      return res.end(JSON.stringify({ id: 4242, data: { name: JSON.parse(body || '{}').name } }));
    }
    if (req.method === 'POST' && u.pathname === '/api/v1/strict') {
      const body = await readBody(req); writes.push({ path: u.pathname, body }); strictHits++;
      if (strictHits === 1) { res.writeHead(422, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'name already taken' })); }
      res.writeHead(201, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ id: 77 }));
    }
    res.writeHead(404); res.end('nope');
  });
  server._writes = writes;
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}
const html = (res, body) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(body); };

async function run(startPath, extraArgs = []) {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(path.join(tmpdir(), 'crudw-'));
  try {
    const { stdout } = await execFileP(process.execPath,
      [TOOL, '--url', base + startPath, '--scope', '127.0.0.1', '--cookie', 'sess=x', '--out', dir, ...extraArgs],
      { maxBuffer: 32 * 1024 * 1024 });
    // the tool emits one pretty-printed (multi-line) JSON object — parse the whole stdout
    const out = JSON.parse(stdout.trim());
    // read the emitted file BEFORE finally cleans the dir
    let crudFile = null;
    try { crudFile = JSON.parse(readFileSync(path.join(dir, 'crud-exercise.json'), 'utf8')); } catch { /* not written */ }
    return { out, writes: server._writes, crudFile };
  } finally { rmSync(dir, { recursive: true, force: true }); server.close(); }
}

test('emits forms_to_drive[] for a picker-first form the filler cannot complete (AI-tier handoff)', async () => {
  const { out } = await run('/picker/new', ['--submit', '--marker', 'PENTEST-ftd']);
  assert.ok(Array.isArray(out.forms_to_drive), 'forms_to_drive present in output');
  assert.ok(out.forms_to_drive.length >= 1, 'the picker-first form is flagged for the AI tier');
  const f = out.forms_to_drive[0];
  assert.match(f.route, /\/picker\/new/, 'route recorded');
  assert.ok(/picker-first|submit-no-write/.test(f.reason), 'reason set');
  assert.ok(f.detected && /Create/i.test(f.detected.primary_action || ''), 'primary action detected');
  assert.equal(out.totals.forms_to_drive, out.forms_to_drive.length, 'totals mirrors the list');
});

test('does NOT emit forms_to_drive in dry-run (driving is armed-only, so no picker/list noise)', async () => {
  const { out } = await run('/picker/new');   // no --submit → dry-run
  assert.equal((out.forms_to_drive || []).length, 0, 'no handoff emitted in dry-run');
});

test('flags a complex NO-PICKER form the backbone could not submit (submit-no-write → AI tier)', async () => {
  const { out } = await run('/gated/new', ['--submit', '--marker', 'PENTEST-gate']);
  const f = (out.forms_to_drive || []).find((x) => /\/gated\/new/.test(x.route));
  assert.ok(f, 'a no-picker gated form is handed off to the AI tier');
  assert.equal(f.reason, 'submit-no-write', 'reason is submit-no-write');
  assert.equal(f.detected.pickers.length, 0, 'no picker present — flagged on the submit-no-write trigger, not pickers');
});

test('dry-run (default) submits nothing but previews marker-tagged values', async () => {
  const { out, writes } = await run('/vendors/new');
  assert.equal(out.ok, true);
  assert.equal(out.mode, 'dry-run');
  assert.equal(writes.length, 0, 'no POST fired in dry-run');
  assert.ok(out.intents && out.intents.length >= 1, 'a create intent was previewed');
  const planned = out.intents[0].planned_values;
  assert.ok(planned.some((p) => p.name === 'name' && /PENTEST/.test(p.value)), 'name previewed with marker');
  assert.ok(planned.some((p) => p.name === 'email' && /@/.test(p.value)), 'email synthesized as an email');
});

test('armed run captures the marker POST + created id → crud-exercise.json', async () => {
  const { out, writes, crudFile } = await run('/vendors/new', ['--submit', '--marker', 'PENTEST-t1']);
  assert.equal(out.ok, true);
  assert.equal(out.armed, true);
  assert.equal(writes.length, 1, 'exactly one create POST');
  const sent = JSON.parse(writes[0].body);
  assert.match(sent.name, /^PENTEST-t1/, 'name field carried the marker');
  assert.equal(typeof sent.amount, 'number');

  assert.equal(out.actions.length, 1);
  const act = out.actions[0];
  assert.equal(act.action, 'create');
  assert.equal(act.request.method, 'POST');
  assert.equal(act.request.path, '/api/v1/vendors');
  assert.match(act.request.body.name, /^PENTEST-t1/);
  assert.equal(act.created.id, '4242', 'created id extracted from the response');
  // written to crud-exercise.json for crud-merge to consume
  assert.ok(crudFile, 'crud-exercise.json written');
  assert.equal(crudFile[0].created.id, '4242');
});

test('refuses to submit without a marker', async () => {
  let err;
  try { await execFileP(process.execPath, [TOOL, '--url', 'http://127.0.0.1:1/', '--submit']); }
  catch (e) { err = e; }
  assert.ok(err && err.code === 2, 'exit 2');
  const out = JSON.parse(err.stdout.trim());
  assert.equal(out.ok, false);
  assert.match(out.error, /marker/);
});

test('never clicks a destructive-only control', async () => {
  const { out, writes } = await run('/danger/new', ['--submit', '--marker', 'PENTEST-t2']);
  assert.equal(out.ok, true);
  assert.equal(writes.length, 0, 'the Delete button was not clicked');
  assert.equal(out.actions.length, 0);
});

test('follows links (incl. non-create-labelled) to reach a deep form, never following logout', async () => {
  const { out, writes } = await run('/deep', ['--submit', '--marker', 'PENTEST-t4']);
  assert.equal(out.ok, true);
  // the form lives at /settings/panel, reachable only by following the "Settings" link from /deep
  assert.ok(writes.some((w) => w.path === '/api/v1/settings'), 'deep form reached and submitted');
  assert.ok(!writes.some((w) => w.path === '/logout'), 'logout link was NOT followed');
  assert.ok(out.actions.some((a) => a.request.path === '/api/v1/settings' && a.created.id === 'set-9'));
});

test('a validation error triggers a retry that then succeeds', async () => {
  const { out, writes } = await run('/strict/new', ['--submit', '--marker', 'PENTEST-t3']);
  assert.equal(out.ok, true);
  assert.equal(writes.length, 2, 'first POST 422 → retried once');
  assert.equal(out.actions.length, 1);
  assert.equal(out.actions[0].created.id, '77', 'id captured after the retry');
  assert.equal(out.actions[0].response_status, 201);
});

// Reproduces the real-world Vue pattern (a micro-frontend sale/create +add dialog): a custom dropdown
// (role=combobox, NOT a native <select>) inside an add-dialog, hiding a searchable typeahead. Typing fires
// ?keyword=…, selecting an option echoes its value into ?name=… — both invisible to native-<select> scraping
// and path-crawl. Asserts the read-only widget pass discovers those endpoints/params.
const widgetPage = () => page(`
  <button id="addbtn">Add item</button>
  <div id="dlg" role="dialog" style="display:none">
    <div id="combo" role="combobox" tabindex="0">Select an item</div>
    <div id="lb" role="listbox" style="display:none">
      <input id="search" placeholder="Search items by name">
      <div role="option" data-v="PENTEST-run4-inv-a1-MOD">PENTEST-run4-inv-a1-MOD</div>
      <div role="option" data-v="beta-widget">beta-widget</div>
    </div>
  </div>
  <script>
    document.getElementById('addbtn').addEventListener('click', () => { document.getElementById('dlg').style.display='block'; });
    document.getElementById('combo').addEventListener('click', () => { document.getElementById('lb').style.display='block'; });
    document.getElementById('search').addEventListener('input', (e) => { fetch('/api/search?limit=10&keyword=' + encodeURIComponent(e.target.value)); });
    document.querySelectorAll('[role=option]').forEach(o => o.addEventListener('click', () => {
      fetch('/transaction/api/v1/inventories?limit=10&page=1&name=' + encodeURIComponent(o.getAttribute('data-v')));
      document.getElementById('lb').style.display='none';
    }));
  </script>`);

function startWidgetServer() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/') return html(res, widgetPage());
    if (u.pathname === '/api/search' || u.pathname === '/transaction/api/v1/inventories') {
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('[]');
    }
    res.writeHead(404); res.end('nope');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('read-only widget pass: custom combobox typeahead → ?keyword and option select → ?name are inventoried', async () => {
  const server = await startWidgetServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // dry-run (default) — no --submit; the widget pass is read-only
    const { stdout } = await execFileP(process.execPath,
      [TOOL, '--url', base + '/', '--scope', '127.0.0.1', '--cookie', 'sess=x', '--max-widgets', '5', '--max-options', '2'],
      { maxBuffer: 32 * 1024 * 1024 });
    const out = JSON.parse(stdout.trim());
    assert.equal(out.ok, true);
    const inv = out.param_inventory || [];
    const search = inv.find((e) => e.endpoint === '/api/search');
    assert.ok(search && search.params.some((p) => p.name === 'keyword'), `typeahead ?keyword captured (got ${JSON.stringify(inv)})`);
    const items = inv.find((e) => e.endpoint === '/transaction/api/v1/inventories');
    assert.ok(items && items.params.some((p) => p.name === 'name'), 'option-select ?name captured');
  } finally { server.close(); }
});

// General "complete the form like a user, whatever the action is called": a page-level +add button opens a
// dialog, a custom combobox must be selected, a Continue step advances, and the final action is labelled 確定
// (NOT in any create-hint list) next to a Cancel — proving submit is LABEL-AGNOSTIC (excludes cancel, takes the
// primary) and multi-step aware. Not tailored to any specific app.
function startFlowServer() {
  const writes = [];
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/') return html(res, page(`
      <button id="logout" onclick="fetch('/logout')">Logout</button>
      <button id="menu" onclick="fetch('/menu')">Menu</button>
      <button id="add" onclick="document.getElementById('d1').style.display='block'">Add sale</button>
      <div id="d1" role="dialog" style="display:none">
        <div id="cb" role="combobox" onclick="document.getElementById('lb').style.display='block'">Pick buyer</div>
        <div id="lb" role="listbox" style="display:none"><div role="option" onclick="this.parentElement.style.display='none'">Buyer A</div></div>
        <input id="ref" placeholder="reference">
        <button id="next" onclick="document.getElementById('d1').style.display='none';document.getElementById('d2').style.display='block'">Continue</button>
      </div>
      <div id="d2" role="dialog" style="display:none">
        <input id="note" placeholder="note">
        <button id="cancel" onclick="document.getElementById('d2').style.display='none'">Cancel</button>
        <button id="ok">確定</button>
      </div>
      <script>
        document.getElementById('ok').addEventListener('click', () => {
          fetch('/api/sales', { method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ ref: document.getElementById('ref').value, note: document.getElementById('note').value }) })
            .then(r=>r.json()).then(j=>{document.title='ok'+(j.id||'');});
        });
      </script>`));
    if (req.method === 'POST' && u.pathname === '/api/sales') {
      const body = await readBody(req); writes.push({ path: u.pathname, body });
      res.writeHead(201, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ id: 'sale-1' }));
    }
    if (u.pathname === '/logout' || u.pathname === '/menu') { writes.push({ path: u.pathname, body: '' }); res.writeHead(200); return res.end('x'); }
    res.writeHead(404); res.end('nope');
  });
  server._writes = writes;
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('armed: opens dialog → fills custom widget → advances a step → submits via 確定 (label-agnostic) → captures create', async () => {
  const server = await startFlowServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { stdout } = await execFileP(process.execPath,
      [TOOL, '--url', base + '/', '--scope', '127.0.0.1', '--cookie', 'sess=x', '--submit', '--marker', 'PENTEST-flow', '--owner', 'A', '--max-steps', '4'],
      { maxBuffer: 32 * 1024 * 1024 });
    const out = JSON.parse(stdout.trim());
    assert.equal(out.ok, true);
    // *** regression guard *** — completion is scoped to the dialog, so the page-level Logout/Menu buttons are
    // NEVER clicked (page-wide "last button" picking used to derail real apps into these).
    assert.ok(!server._writes.some((w) => w.path === '/logout' || w.path === '/menu'), 'page-level nav buttons not clicked');
    const posts = server._writes.filter((w) => w.path === '/api/sales');
    assert.equal(posts.length, 1, 'exactly one create POST (the 確定 action, not Cancel/Continue/nav)');
    const sent = JSON.parse(posts[0].body);
    assert.match(sent.ref, /^PENTEST-flow/, 'step-1 field filled with the marker');
    assert.match(sent.note, /^PENTEST-flow/, 'step-2 field filled after advancing');
    const act = out.actions.find((a) => a.request.path === '/api/sales');
    assert.ok(act, 'create captured');
    assert.ok(act.steps >= 2, `multi-step completion recorded (steps=${act && act.steps})`);
    assert.equal(act.owner, 'A', '--owner stamped on the action (feeds the BOLA oracle)');
  } finally { server.close(); }
});

// D1: body params. A POST typeahead / GraphQL-style search echoes its term into the JSON BODY (not the query
// string). The read-only discovery must inventory those body params (in:json), incl. nested ones — the injection
// surface a query-only capture drops entirely.
function startBodyParamServer() {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/') return html(res, page(`
      <div id="cb" role="combobox" onclick="document.getElementById('lb').style.display='block'">Search</div>
      <div id="lb" role="listbox" style="display:none"><input id="s" placeholder="Search items"></div>
      <script>
        document.getElementById('s').addEventListener('input', (e) => {
          fetch('/api/graphql', { method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ query:'q', variables:{ filter:{ keyword: e.target.value } }, page:1 }) });
        });
      </script>`));
    if (req.method === 'POST' && u.pathname === '/api/graphql') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{}'); }
    res.writeHead(404); res.end('nope');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('read-only discovery captures POST BODY params (nested json), not just query (D1)', async () => {
  const server = await startBodyParamServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { stdout } = await execFileP(process.execPath,
      [TOOL, '--url', base + '/', '--scope', '127.0.0.1', '--cookie', 'sess=x', '--max-widgets', '3'],
      { maxBuffer: 32 * 1024 * 1024 });
    const out = JSON.parse(stdout.trim());
    assert.equal(out.ok, true);
    const gql = (out.param_inventory || []).find((e) => e.endpoint === '/api/graphql');
    assert.ok(gql, `POST /api/graphql inventoried despite no query params (got ${JSON.stringify(out.param_inventory)})`);
    assert.ok(gql.params.some((p) => p.name === 'variables.filter.keyword' && p.in === 'json'), 'nested body param captured as in:json');
    assert.ok(gql.params.some((p) => p.name === 'page' && p.in === 'json'), 'top-level body param captured');
  } finally { server.close(); }
});

// review fix: a dead SPA/hash link (create-labelled, so sorted first) whose click doesn't change the URL used to
// be re-selected every iteration, burning the whole --max-views budget so a real page behind it was never reached.
function startDeadLinkServer() {
  const hits = [];
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/') return html(res, page('<a href="#/new" onclick="return false">Create</a> <a href="/real">Real page</a>'));
    if (u.pathname === '/real') return html(res, createForm('/api/real'));
    if (req.method === 'POST' && u.pathname === '/api/real') { hits.push(1); res.writeHead(201, { 'Content-Type': 'application/json' }); return res.end('{"id":"r1"}'); }
    res.writeHead(404); res.end('nope');
  });
  server._hits = hits;
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('a dead SPA/hash link does not starve navigation — a real page behind it is still reached (review fix)', async () => {
  const server = await startDeadLinkServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { stdout } = await execFileP(process.execPath,
      [TOOL, '--url', base + '/', '--scope', '127.0.0.1', '--cookie', 'sess=x', '--submit', '--marker', 'PENTEST-dl', '--max-views', '3'],
      { maxBuffer: 32 * 1024 * 1024 });
    const out = JSON.parse(stdout.trim());
    assert.equal(out.ok, true);
    assert.ok(server._hits.length >= 1, 'the /real create form was reached + submitted (not starved by the dead #/new link)');
  } finally { server.close(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
// SPA / micro-frontend nested-form gaps (G1–G6) — each stub reproduces a real-world Vue/React failure mode
// (client routing, formless regions, poisoned options, nested sub-entities). Red before the patch, green after.
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════

// G1 — SPA route discovery. A launcher whose tiles are NOT <a href> but [routerlink]/[data-href]/[role=link]
// (Angular/Vue routing) → the old `a[href]`-only BFS stalls on the launcher and never reaches the create form.
function startSpaRouteServer() {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/') return html(res, page(`
      <h1>All products</h1>
      <div class="tile" role="link" routerlink="/transaction/sale/new">Invoices</div>
      <span class="tile" data-href="/vendors/new">Vendors</span>
      <div class="tile" data-route="/misc">Misc</div>`));
    if (u.pathname === '/vendors/new') return html(res, createForm('/api/v1/vendors'));
    if (req.method === 'POST' && u.pathname === '/api/v1/vendors') {
      const body = await readBody(req); server._writes.push({ path: u.pathname, body });
      res.writeHead(201, { 'Content-Type': 'application/json', Location: '/api/v1/vendors/9001' });
      return res.end(JSON.stringify({ id: 9001 }));
    }
    res.writeHead(404); res.end('nope');
  });
  server._writes = [];
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('G1: follows non-anchor SPA routes ([routerlink]/[data-href]) to reach a create form the a[href] BFS misses', async () => {
  const server = await startSpaRouteServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { stdout } = await execFileP(process.execPath,
      [TOOL, '--url', base + '/', '--scope', '127.0.0.1', '--cookie', 'sess=x', '--submit', '--marker', 'PENTEST-g1', '--max-views', '6'],
      { maxBuffer: 32 * 1024 * 1024 });
    const out = JSON.parse(stdout.trim());
    assert.equal(out.ok, true);
    assert.ok(out.totals.pages_visited >= 2, `navigated past the launcher (pages=${out.totals.pages_visited})`);
    assert.ok(server._writes.some((w) => w.path === '/api/v1/vendors'), 'reached the create form behind a routerlink tile');
  } finally { server.close(); }
});

// G2 — formless form-region. No <form>, and the inputs have NO name/id — only placeholder/aria-label (the real
// Vuetify shape: form_inventory.json shows "forms":[] with randomized/absent names). The old INTROSPECT keys on
// name||id and finds nothing → forms_processed:0.
function startFormlessServer() {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/') return html(res, page(`
      <h1>New vendor (no &lt;form&gt;)</h1>
      <input placeholder="Vendor name" aria-label="name">
      <input placeholder="Amount" type="number" min="1">
      <div contenteditable="true" role="textbox" aria-label="notes"></div>
      <button id="go">Create</button>
      <script>
        document.getElementById('go').addEventListener('click', () => {
          const name = document.querySelector('[aria-label=name]').value;
          const amount = Number(document.querySelector('[type=number]').value);
          const notes = document.querySelector('[role=textbox]').textContent;
          fetch('/api/v1/vendors', { method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ name, amount, notes }) }).then(r=>r.json()).then(j=>{document.title='ok'+j.id;});
        });
      </script>`));
    if (req.method === 'POST' && u.pathname === '/api/v1/vendors') {
      const body = await readBody(req); server._writes.push({ path: u.pathname, body });
      res.writeHead(201, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ id: 'v-77' }));
    }
    res.writeHead(404); res.end('nope');
  });
  server._writes = [];
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('G2: detects a formless region (no <form>, nameless placeholder/aria-label inputs + contenteditable) and completes it', async () => {
  const server = await startFormlessServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // dry-run first: the region must be RECOGNIZED (forms_processed >= 1) even read-only
    const dry = await execFileP(process.execPath,
      [TOOL, '--url', base + '/', '--scope', '127.0.0.1', '--cookie', 'sess=x'], { maxBuffer: 32 * 1024 * 1024 });
    const outDry = JSON.parse(dry.stdout.trim());
    assert.ok(outDry.totals.forms_processed >= 1, `formless region recognized in dry-run (forms=${outDry.totals.forms_processed})`);
    // armed: fills the nameless fields (marker) + contenteditable → POST fires
    const { stdout } = await execFileP(process.execPath,
      [TOOL, '--url', base + '/', '--scope', '127.0.0.1', '--cookie', 'sess=x', '--submit', '--marker', 'PENTEST-g2'],
      { maxBuffer: 32 * 1024 * 1024 });
    const out = JSON.parse(stdout.trim());
    assert.equal(out.ok, true);
    assert.equal(server._writes.length, 1, 'formless region submitted exactly one create');
    const sent = JSON.parse(server._writes[0].body);
    assert.match(sent.name, /^PENTEST-g2/, 'nameless input filled via placeholder/aria-label');
  } finally { server.close(); }
});

// G3 — validation-aware option selection. The FIRST combobox option is poisoned (fires a blocking toast +
// disables the submit); the SECOND is valid. The old fillWidgets takes .first() → stuck on the poison → no write.
function startPoisonOptionServer() {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/') return html(res, page(`
      <h1>Pick a buyer</h1>
      <div id="cb" role="combobox" tabindex="0">Select buyer</div>
      <div id="lb" role="listbox" style="display:none">
        <div role="option" data-ok="0">Invalid party (bad tax id)</div>
        <div role="option" data-ok="1">Valid party</div>
      </div>
      <div id="toast" role="alert" style="display:none">Missing Tax and Contact Info</div>
      <button id="go" disabled>Create</button>
      <script>
        const go=document.getElementById('go'), toast=document.getElementById('toast');
        document.getElementById('cb').addEventListener('click',()=>{document.getElementById('lb').style.display='block';});
        document.querySelectorAll('[role=option]').forEach(o=>o.addEventListener('click',()=>{
          document.getElementById('lb').style.display='none';
          if(o.getAttribute('data-ok')==='1'){ toast.style.display='none'; go.disabled=false; }
          else { toast.style.display='block'; go.disabled=true; }
        }));
        go.addEventListener('click',()=>{ if(go.disabled) return;
          fetch('/api/ok',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"buyer":"valid"}'})
            .then(r=>r.json()).then(j=>{document.title='ok'+j.id;}); });
      </script>`));
    if (req.method === 'POST' && u.pathname === '/api/ok') {
      const body = await readBody(req); server._writes.push({ path: u.pathname, body });
      res.writeHead(201, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ id: 'ok-1' }));
    }
    res.writeHead(404); res.end('nope');
  });
  server._writes = [];
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('G3: advances past a poisoned first option (blocking toast / disabled submit) to a valid one, then submits', async () => {
  const server = await startPoisonOptionServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { stdout } = await execFileP(process.execPath,
      [TOOL, '--url', base + '/', '--scope', '127.0.0.1', '--cookie', 'sess=x', '--submit', '--marker', 'PENTEST-g3', '--max-options', '3'],
      { maxBuffer: 32 * 1024 * 1024 });
    const out = JSON.parse(stdout.trim());
    assert.equal(out.ok, true);
    assert.equal(server._writes.length, 1, 'submitted after selecting the VALID (2nd) option, not stuck on the poison');
    assert.ok(out.actions.some((x) => x.request.path === '/api/ok'), 'create captured after option recovery');
  } finally { server.close(); }
});

// G4 + G6 — nested sub-entity commit order + intermediate-write capture. A parent create with a buyer sub-card
// (own Save → POST /vendor 201) and a line row (own Save → PUT /inventories/1 200); the parent "Create Invoice"
// (→ POST /sales) only succeeds AFTER both sub-saves. The old MAX_STEPS wizard loop never clicks the per-card Saves.
function startNestedServer() {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/') return html(res, page(`
      <h1>New invoice</h1>
      <div class="line-item" id="buyer"><input placeholder="Buyer name" aria-label="buyer">
        <button class="rowsave" data-k="buyer">Save</button></div>
      <div class="line-item" id="line"><input placeholder="Item" aria-label="item">
        <button class="rowsave" data-k="line">Save</button></div>
      <div class="line-item" id="cf"><span>custom fields</span>
        <button class="rowsave" data-k="cf">Save</button></div>
      <button id="create" class="btn-primary">Create Invoice</button>
      <div id="log"></div>
      <script>
        let buyerOk=false, lineOk=false;
        function save(k,el){ if(k==='buyer'){ fetch('/vendor',{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({name:document.querySelector('[aria-label=buyer]').value})}).then(()=>{buyerOk=true;}); }
          else if(k==='line'){ fetch('/inventories/1',{method:'PUT',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({item:document.querySelector('[aria-label=item]').value})}).then(()=>{lineOk=true;}); }
          else { fetch('/api/v1/custom-field/contents',{method:'POST',headers:{'Content-Type':'application/json'},body:'[]'}); } }
        document.querySelectorAll('.rowsave').forEach(b=>b.addEventListener('click',()=>save(b.getAttribute('data-k'))));
        document.getElementById('create').addEventListener('click',()=>{ if(!(buyerOk&&lineOk)) return; // no-op until sub-saves done
          fetch('/sales',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"final":true}'})
            .then(r=>r.json()).then(j=>{document.title='ok'+j.id;}); });
      </script>`));
    if (req.method === 'POST' && u.pathname === '/vendor') { const b=await readBody(req); server._writes.push({m:'POST',path:'/vendor',status:201,body:b}); res.writeHead(201,{'Content-Type':'application/json'}); return res.end(JSON.stringify({data:{name:'x'},id:'ven-1'})); }
    if (req.method === 'PUT' && u.pathname === '/inventories/1') { const b=await readBody(req); server._writes.push({m:'PUT',path:'/inventories/1',status:200,body:b}); res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify({code:'00',data:'updated'})); }
    if (req.method === 'POST' && u.pathname === '/api/v1/custom-field/contents') { server._writes.push({m:'POST',path:'/api/v1/custom-field/contents',status:500}); res.writeHead(500,{'Content-Type':'application/json'}); return res.end(JSON.stringify({error:{code:'90',message:'Whoops! Something went wrong!'}})); }
    if (req.method === 'POST' && u.pathname === '/sales') { const b=await readBody(req); server._writes.push({m:'POST',path:'/sales',status:201,body:b}); res.writeHead(201,{'Content-Type':'application/json'}); return res.end(JSON.stringify({id:'sale-9'})); }
    res.writeHead(404); res.end('nope');
  });
  server._writes = [];
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('G4+G6: commits nested sub-entities (buyer Save→POST, line Save→PUT) before the parent Create; captures the whole write chain', async () => {
  const server = await startNestedServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { stdout } = await execFileP(process.execPath,
      [TOOL, '--url', base + '/', '--scope', '127.0.0.1', '--cookie', 'sess=x', '--submit', '--marker', 'PENTEST-g4', '--max-forms', '2'],
      { maxBuffer: 32 * 1024 * 1024 });
    const out = JSON.parse(stdout.trim());
    assert.equal(out.ok, true);
    const paths = server._writes.map((w) => w.path);
    assert.ok(paths.includes('/vendor') && paths.includes('/inventories/1'), `sub-entity writes fired (got ${paths})`);
    assert.ok(paths.includes('/sales'), 'parent create fired after sub-saves');
    assert.ok(paths.indexOf('/sales') > paths.indexOf('/vendor'), 'parent create came AFTER the buyer sub-save');
    // G6: intermediate writes surfaced as seeds (session_writes), not just the terminal create
    const sw = out.session_writes || [];
    assert.ok(sw.some((w) => w.path === '/vendor' && w.status === 201), `vendor write captured as a seed (got ${JSON.stringify(sw)})`);
    assert.ok(sw.some((w) => w.path === '/inventories/1' && w.method === 'PUT'), 'inventory PUT captured as a seed');
    // G6: a 4xx/5xx sub-write is routed to findings (endpoint contract + server bug), not silently dropped
    const findings = out.findings || [];
    assert.ok(findings.some((f) => f.status === 500 && /custom-field/.test(f.path)), `5xx write surfaced as a finding (got ${JSON.stringify(findings)})`);
  } finally { server.close(); }
});

// G5 — state-delta oracle. The submit is ENABLED and clicking it fires ZERO network writes (client no-op) and
// shows a blocking toast → the old code returned "did work" silently. There must be NO false `created`, and the
// block reason (the read toast) must be recorded. (The 5xx→findings path is covered by the G4+G6 test, where a
// write actually fires an error.)
function startNoopServer() {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/') return html(res, page(`
      <h1>New sale</h1>
      <input name="ref" placeholder="ref">
      <div id="toast" role="alert" style="display:none">Missing Tax and Contact Info</div>
      <button id="go" class="btn-primary">Create</button>
      <script>
        document.getElementById('go').addEventListener('click',()=>{ document.getElementById('toast').style.display='block'; /* NO fetch: pure client no-op */ });
      </script>`));
    res.writeHead(404); res.end('nope');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('G5: a submit that fires no network write → intent_blocked (with reason), no false created', async () => {
  const server = await startNoopServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { stdout } = await execFileP(process.execPath,
      [TOOL, '--url', base + '/', '--scope', '127.0.0.1', '--cookie', 'sess=x', '--submit', '--marker', 'PENTEST-g5', '--max-forms', '3'],
      { maxBuffer: 32 * 1024 * 1024 });
    const out = JSON.parse(stdout.trim());
    assert.equal(out.ok, true);
    // a 200/enabled button is NOT proof — no create must be emitted for the no-op form
    assert.ok(!out.actions.some((a) => a.action === 'create' && a.response_status < 400), 'no false `created` for the no-write submit');
    // the block is recorded with the toast reason
    const blocked = out.blocked || [];
    assert.ok(blocked.some((b) => /Missing Tax|Contact Info/i.test(b.reason || '')), `intent_blocked carries the toast reason (got ${JSON.stringify(blocked)})`);
  } finally { server.close(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
// Patch #2 — adversarial-review correctness fixes (F1–F5). Each stub reproduces a downstream-poisoning defect
// found by 3 independent reviewers of the G1–G6 patch. Red before the P0/P1/P2 fixes, green after.
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════

// T-F1/F4 — a submit that fires ONLY a non-persistent write (a preview/validation 200, no object created) must
// NOT be recorded as `created`; it must be `blocked`. (On the real app: preview-doc-definition / activity-log /
// ag-grid count POSTs all return 200 but persist nothing.)
function startPreviewOnlyServer() {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/') return html(res, page(`
      <h1>New invoice</h1>
      <input name="ref" placeholder="ref">
      <div id="toast" role="alert" style="display:none">Please complete the required fields</div>
      <button id="go" class="btn-primary">Create</button>
      <script>
        document.getElementById('go').addEventListener('click',()=>{
          document.getElementById('toast').style.display='block';
          fetch('/api/v1/invoices/preview-doc-definition',{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({ref:document.querySelector('[name=ref]').value})}); /* preview only — persists NOTHING */
        });
      </script>`));
    if (req.method === 'POST' && u.pathname === '/api/v1/invoices/preview-doc-definition') {
      server._writes.push({ path: u.pathname }); res.writeHead(200,{'Content-Type':'application/json'});
      return res.end(JSON.stringify({ items: [], total: 0, owner: { id: 700123 } }));
    }
    res.writeHead(404); res.end('nope');
  });
  server._writes = [];
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('T-F1/F4: a preview/validation-only 200 (no persistence) is NOT a create — it is blocked', async () => {
  const server = await startPreviewOnlyServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { stdout } = await execFileP(process.execPath,
      [TOOL, '--url', base + '/', '--scope', '127.0.0.1', '--cookie', 'x', '--submit', '--marker', 'PENTEST-fp', '--max-forms', '2'],
      { maxBuffer: 32 * 1024 * 1024 });
    const out = JSON.parse(stdout.trim());
    assert.equal(out.ok, true);
    assert.equal(out.totals.created, 0, `no create recorded for a preview-only submit (actions=${JSON.stringify(out.actions)})`);
    assert.ok((out.actions || []).length === 0, 'actions[] empty');
    assert.ok((out.blocked || []).length >= 1, `submit recorded as blocked (got ${JSON.stringify(out.blocked)})`);
  } finally { server.close(); }
});

// T-F2 — the created id must be the REAL object id (top-level, not echoed), never the auth company/user id that
// the response happens to echo back (owner.id = the JWT tenant/company id). Poisoning that into crud-merge would derive
// a cross-tenant DELETE against the real company.
function startEchoIdServer() {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/') return html(res, page(`
      <h1>New vendor</h1>
      <input name="name" placeholder="name">
      <button id="go" class="btn-primary">Create</button>
      <script>
        document.getElementById('go').addEventListener('click',()=>{
          fetch('/api/v1/vendor',{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({name:document.querySelector('[name=name]').value, company_id:700123})})
            .then(r=>r.json()).then(j=>{document.title='ok';});
        });
      </script>`));
    if (req.method === 'POST' && u.pathname === '/api/v1/vendor') {
      res.writeHead(201,{'Content-Type':'application/json'});
      // owner.id echoes the request tenant id (700123); the REAL created id is data.id
      return res.end(JSON.stringify({ owner: { id: 700123 }, data: { id: 'ven-4242', name: 'x' } }));
    }
    res.writeHead(404); res.end('nope');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('T-F2: findId returns the real object id (data.id), never the echoed auth/tenant id (700123)', async () => {
  const server = await startEchoIdServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { stdout } = await execFileP(process.execPath,
      [TOOL, '--url', base + '/', '--scope', '127.0.0.1', '--cookie', 'x', '--submit', '--marker', 'PENTEST-f2'],
      { maxBuffer: 32 * 1024 * 1024 });
    const out = JSON.parse(stdout.trim());
    assert.equal(out.ok, true);
    const act = (out.actions || []).find((a) => a.request.path === '/api/v1/vendor');
    assert.ok(act, 'the 201 create was captured');
    assert.notEqual(act.created && act.created.id, '700123', 'the echoed tenant id must NOT become the object id');
    assert.notEqual(act.created && act.created.id, 700123, 'the echoed tenant id (number) must NOT become the object id');
  } finally { server.close(); }
});

// T-F3 — a parent create whose terminal action returns 500 must NOT re-click the sub-entity Saves on each retry
// step (write amplification → many objects for one form). Each sub-Save fires exactly once.
function startAmplifyServer() {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/') return html(res, page(`
      <h1>New invoice</h1>
      <div class="line-item"><input placeholder="Buyer" aria-label="buyer"><button class="rowsave" data-k="buyer">Save</button></div>
      <div class="line-item"><input placeholder="Item" aria-label="item"><button class="rowsave" data-k="line">Save</button></div>
      <button id="create" class="btn-primary">Create Invoice</button>
      <script>
        function save(k){ if(k==='buyer') fetch('/vendor',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"n":1}'});
          else fetch('/inventories/1',{method:'PUT',headers:{'Content-Type':'application/json'},body:'{"n":1}'}); }
        document.querySelectorAll('.rowsave').forEach(b=>b.addEventListener('click',()=>save(b.getAttribute('data-k'))));
        document.getElementById('create').addEventListener('click',()=>{ fetch('/sales',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}); });
      </script>`));
    if (req.method === 'POST' && u.pathname === '/vendor') { server._c.vendor++; res.writeHead(201,{'Content-Type':'application/json'}); return res.end('{"data":{"id":"ven-1"}}'); }
    if (req.method === 'PUT' && u.pathname === '/inventories/1') { server._c.inv++; res.writeHead(200,{'Content-Type':'application/json'}); return res.end('{"code":"00"}'); }
    if (req.method === 'POST' && u.pathname === '/sales') { server._c.sales++; res.writeHead(500,{'Content-Type':'application/json'}); return res.end('{"error":{"message":"Whoops"}}'); }
    res.writeHead(404); res.end('nope');
  });
  server._c = { vendor: 0, inv: 0, sales: 0 };
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('T-F3: a 500 terminal does NOT amplify sub-entity Saves — each fires exactly once (1 object/form)', async () => {
  const server = await startAmplifyServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { stdout } = await execFileP(process.execPath,
      [TOOL, '--url', base + '/', '--scope', '127.0.0.1', '--cookie', 'x', '--submit', '--marker', 'PENTEST-f3', '--max-forms', '2'],
      { maxBuffer: 32 * 1024 * 1024 });
    const out = JSON.parse(stdout.trim());
    assert.equal(out.ok, true);
    assert.equal(server._c.vendor, 1, `buyer sub-Save fired exactly once (got ${server._c.vendor})`);
    assert.equal(server._c.inv, 1, `line sub-Save fired exactly once (got ${server._c.inv})`);
    assert.equal(out.totals.created, 0, 'the 500 terminal is not a create');
  } finally { server.close(); }
});

// T-F7 — a poisoned first option that rejects via a multilingual negated-valid toast ("non valide") AND an
// detected so the harness cycles to the valid option. (Generic multilingual negated-valid + inline validation.)
function startInlineValidServer() {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/') return html(res, page(`
      <h1>Pick party</h1>
      <div id="cb" role="combobox" tabindex="0">Select party</div>
      <div id="lb" role="listbox" style="display:none">
        <div role="option" data-ok="0">Party bad</div>
        <div role="option" data-ok="1">Party good</div></div>
      <input id="taxid" aria-label="tax id">
      <div id="toast" role="alert" style="display:none">id non valide</div>
      <button id="go" class="btn-primary" disabled>Create</button>
      <script>
        const go=document.getElementById('go'),toast=document.getElementById('toast'),taxid=document.getElementById('taxid');
        document.getElementById('cb').addEventListener('click',()=>{document.getElementById('lb').style.display='block';});
        document.querySelectorAll('[role=option]').forEach(o=>o.addEventListener('click',()=>{
          document.getElementById('lb').style.display='none';
          if(o.getAttribute('data-ok')==='1'){ toast.style.display='none'; taxid.removeAttribute('aria-invalid'); go.disabled=false; }
          else { toast.style.display='block'; taxid.setAttribute('aria-invalid','true'); go.disabled=true; }
        }));
        go.addEventListener('click',()=>{ if(go.disabled) return;
          fetch('/api/v1/vendor',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"ok":1}'}).then(r=>r.json()).then(()=>{document.title='ok';}); });
      </script>`));
    if (req.method === 'POST' && u.pathname === '/api/v1/vendor') { server._w.push(1); res.writeHead(201,{'Content-Type':'application/json'}); return res.end('{"data":{"id":"v9"}}'); }
    res.writeHead(404); res.end('nope');
  });
  server._w = [];
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('T-F7: detects a negated-valid toast (non valide) + inline aria-invalid and cycles to the valid option, then submits', async () => {
  const server = await startInlineValidServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { stdout } = await execFileP(process.execPath,
      [TOOL, '--url', base + '/', '--scope', '127.0.0.1', '--cookie', 'x', '--submit', '--marker', 'PENTEST-f7', '--max-options', '3'],
      { maxBuffer: 32 * 1024 * 1024 });
    const out = JSON.parse(stdout.trim());
    assert.equal(out.ok, true);
    assert.equal(server._w.length, 1, 'submitted after cycling to the valid party (not stuck on the invalid one)');
  } finally { server.close(); }
});

// T-bug3 — a LIST page with a visible search input + a "+Add" button that opens a dialog holding a typeahead
// widget: the read-only pass must still open the dialog and discover the widget's ?keyword param.
function startListSearchServer() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/') return html(res, page(`
      <input id="search" type="search" placeholder="Search invoices">
      <button id="add">Add invoice</button>
      <div id="dlg" role="dialog" style="display:none">
        <div id="combo" role="combobox">Select item</div>
        <div id="olb" role="listbox" style="display:none"><input id="s2" placeholder="Search items by name"></div>
      </div>
      <script>
        document.getElementById('add').addEventListener('click',()=>{document.getElementById('dlg').style.display='block';});
        document.getElementById('combo').addEventListener('click',()=>{document.getElementById('olb').style.display='block';});
        document.getElementById('s2').addEventListener('input',(e)=>{ fetch('/api/items?keyword='+encodeURIComponent(e.target.value)); });
      </script>`));
    if (u.pathname === '/api/items') { res.writeHead(200,{'Content-Type':'application/json'}); return res.end('[]'); }
    res.writeHead(404); res.end('nope');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('T-bug3: read-only pass opens the +Add dialog on a list-with-search page and discovers the widget ?keyword', async () => {
  const server = await startListSearchServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { stdout } = await execFileP(process.execPath,
      [TOOL, '--url', base + '/', '--scope', '127.0.0.1', '--cookie', 'x', '--max-widgets', '4'],
      { maxBuffer: 32 * 1024 * 1024 });
    const out = JSON.parse(stdout.trim());
    assert.equal(out.ok, true);
    const items = (out.param_inventory || []).find((e) => e.endpoint === '/api/items');
    assert.ok(items && items.params.some((p) => p.name === 'keyword'), `widget ?keyword discovered behind +Add (got ${JSON.stringify(out.param_inventory)})`);
  } finally { server.close(); }
});

// ── Patch #3 (P1) — the patch #2 over-correction (false negatives) is undone ────────────────────────────────

// T-P1-F1 — a REAL create whose endpoint's terminal segment happens to be a non-persist TOKEN (e.g.
// `/vendor/id-validation`, `/checks`, `/lists`) but returns 201 must be recorded as `created`, NOT `blocked`:
// a strong positive signal (201/Location/id) OVERRIDES the advisory token.
function startTokenPathCreateServer() {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/') return html(res, page(`
      <h1>New vendor</h1>
      <input name="name" placeholder="name">
      <button id="go" class="btn-primary">Create</button>
      <script>
        document.getElementById('go').addEventListener('click',()=>{
          fetch('/api/v1/vendor/id-validation',{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({name:document.querySelector('[name=name]').value})})
            .then(r=>r.json()).then(j=>{document.title='ok'+j.id;});
        });
      </script>`));
    if (req.method === 'POST' && u.pathname === '/api/v1/vendor/id-validation') {
      server._writes.push(1); res.writeHead(201, { 'Content-Type': 'application/json' });   // a REAL 201 on a "validation" path
      return res.end(JSON.stringify({ data: { id: 'ven-88' } }));
    }
    res.writeHead(404); res.end('nope');
  });
  server._writes = [];
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('T-P1-F1: a real 201 create on a token-named path (id-validation) is `created`, not `blocked` (positive overrides token)', async () => {
  const server = await startTokenPathCreateServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { stdout } = await execFileP(process.execPath,
      [TOOL, '--url', base + '/', '--scope', '127.0.0.1', '--cookie', 'x', '--submit', '--marker', 'PENTEST-p1a'],
      { maxBuffer: 32 * 1024 * 1024 });
    const out = JSON.parse(stdout.trim());
    assert.equal(out.ok, true);
    const act = (out.actions || []).find((a) => a.request.path === '/api/v1/vendor/id-validation');
    assert.ok(act, `the 201 create was recorded (actions=${JSON.stringify(out.actions)}, blocked=${JSON.stringify(out.blocked)})`);
    assert.equal(act.created && act.created.id, 'ven-88', 'the real object id was captured');
  } finally { server.close(); }
});

// T-P1-F2 — a legitimate CLIENT-SUPPLIED id echoed back (a UUID / idempotency key under a NON-auth key) must be
// KEPT as the created id; only an AUTH-PRINCIPAL echo (company/tenant/owner id) is rejected.
function startClientIdServer() {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/') return html(res, page(`
      <h1>New doc</h1>
      <input name="title" placeholder="title">
      <button id="go" class="btn-primary">Create</button>
      <script>
        document.getElementById('go').addEventListener('click',()=>{
          // client supplies its own resource id (idempotency) AND its tenant id
          fetch('/api/v1/doc',{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({title:document.querySelector('[name=title]').value, client_ref:'c-9f8e', company_id:700123})})
            .then(r=>r.json()).then(j=>{document.title='ok';});
        });
      </script>`));
    if (req.method === 'POST' && u.pathname === '/api/v1/doc') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      // response echoes the client_ref as the object id, and the tenant id under owner
      return res.end(JSON.stringify({ id: 'c-9f8e', owner: { id: 700123 } }));
    }
    res.writeHead(404); res.end('nope');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('T-P1-F2: a client-supplied resource id (non-auth key) echoed back is KEPT; the tenant id is not', async () => {
  const server = await startClientIdServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { stdout } = await execFileP(process.execPath,
      [TOOL, '--url', base + '/', '--scope', '127.0.0.1', '--cookie', 'x', '--submit', '--marker', 'PENTEST-p1b'],
      { maxBuffer: 32 * 1024 * 1024 });
    const out = JSON.parse(stdout.trim());
    assert.equal(out.ok, true);
    const act = (out.actions || []).find((a) => a.request.path === '/api/v1/doc');
    assert.ok(act, 'the create was recorded');
    assert.equal(act.created && act.created.id, 'c-9f8e', 'the client-supplied id was kept (not wrongly rejected as an echo)');
    assert.notEqual(act.created && act.created.id, '700123', 'the tenant id was NOT used as the object id');
  } finally { server.close(); }
});

// T-P2-array — findId must also read the created id from an ARRAY wrapper: `{data:[{id:…}]}` (APIs that return
// the created object as the first element of a list).
function startArrayIdServer() {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/') return html(res, page(`
      <h1>New</h1><input name="name" placeholder="name"><button id="go" class="btn-primary">Create</button>
      <script>document.getElementById('go').addEventListener('click',()=>{fetch('/api/v1/thing',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"name":"x"}'}).then(r=>r.json()).then(()=>{document.title='ok';});});</script>`));
    if (req.method === 'POST' && u.pathname === '/api/v1/thing') { res.writeHead(201, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'arr-7', name: 'x' }] })); }
    res.writeHead(404); res.end('nope');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('T-P2-array: findId reads the created id from an array wrapper {data:[{id}]}', async () => {
  const server = await startArrayIdServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { stdout } = await execFileP(process.execPath,
      [TOOL, '--url', base + '/', '--scope', '127.0.0.1', '--cookie', 'x', '--submit', '--marker', 'PENTEST-p2arr'],
      { maxBuffer: 32 * 1024 * 1024 });
    const out = JSON.parse(stdout.trim());
    const act = (out.actions || []).find((a) => a.request.path === '/api/v1/thing');
    assert.ok(act, 'create captured');
    assert.equal(act.created && act.created.id, 'arr-7', 'id read from data[0].id');
  } finally { server.close(); }
});

// ── Patch #4 — reach & engage real SPA forms (G1 seeds, G2 picker) + regressions (bug#1, bug#2) ─────────────

// T-G1-seed — a launcher with NO crawlable create route; an operator --seed-route reaches the create form anyway.
function startSeedServer() {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/') return html(res, page('<h1>Launcher</h1><a href="/logout">Log out</a>'));  // no create link
    if (req.method === 'GET' && u.pathname === '/make') return html(res, createForm('/api/make'));
    if (req.method === 'POST' && u.pathname === '/api/make') { const b = await readBody(req); server._writes.push({ path: u.pathname, body: b }); res.writeHead(201, { 'Content-Type': 'application/json' }); return res.end('{"id":"m-1"}'); }
    res.writeHead(404); res.end('nope');
  });
  server._writes = [];
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('T-G1-seed: --seed-route reaches a create form the launcher does not link to', async () => {
  const server = await startSeedServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { stdout } = await execFileP(process.execPath,
      [TOOL, '--url', base + '/', '--scope', '127.0.0.1', '--cookie', 'x', '--submit', '--marker', 'PENTEST-g1s', '--seed-route', '/make', '--max-views', '4'],
      { maxBuffer: 32 * 1024 * 1024 });
    const out = JSON.parse(stdout.trim());
    assert.equal(out.ok, true);
    assert.equal(out.seed_routes, 1, 'the seed route was enqueued');
    assert.ok(server._writes.some((w) => w.path === '/api/make'), 'the seeded create form was reached + submitted');
  } finally { server.close(); }
});

// T-G2-picker — a picker-first form (no input cluster at load): a buyer combobox that, once a valid option is
// picked, REVEALS two line rows to Save, then the Create button (disabled until the lines commit). The harness
// recognizes the picker as a form-region, selects a valid option, commits the revealed rows, then creates.
function startPickerServer() {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/') return html(res, page(`
      <h1>New invoice</h1>
      <div id="buyer" role="combobox" tabindex="0">Select buyer</div>
      <div id="lb" role="listbox" style="display:none"><div role="option" data-ok="1">Valid buyer</div></div>
      <div id="lines"></div>
      <button id="create" class="btn-primary" disabled>Create Invoice</button>
      <script>
        let saved=0;
        document.getElementById('buyer').addEventListener('click',()=>{document.getElementById('lb').style.display='block';});
        document.querySelectorAll('#lb [role=option]').forEach(o=>o.addEventListener('click',()=>{
          document.getElementById('lb').style.display='none';
          const box=document.getElementById('lines');
          box.innerHTML='<div class="line-item"><input aria-label="i1"><button class="ls" data-n="1">Save</button></div>'+
                        '<div class="line-item"><input aria-label="i2"><button class="ls" data-n="2">Save</button></div>';
          box.querySelectorAll('.ls').forEach(b=>b.addEventListener('click',()=>{
            fetch('/inventories/'+b.getAttribute('data-n'),{method:'PUT',headers:{'Content-Type':'application/json'},body:'{"x":1}'})
              .then(()=>{ saved++; if(saved>=2) document.getElementById('create').disabled=false; });
          }));
        }));
        document.getElementById('create').addEventListener('click',()=>{ if(document.getElementById('create').disabled) return;
          fetch('/invoice',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"final":1}'}).then(r=>r.json()).then(()=>{document.title='ok';}); });
      </script>`));
    if (req.method === 'PUT' && /^\/inventories\/[12]$/.test(u.pathname)) { server._c[u.pathname]=(server._c[u.pathname]||0)+1; res.writeHead(200,{'Content-Type':'application/json'}); return res.end('{"code":"00"}'); }
    if (req.method === 'POST' && u.pathname === '/invoice') { server._c['/invoice']=(server._c['/invoice']||0)+1; res.writeHead(201,{'Content-Type':'application/json'}); return res.end('{"id":"inv-1"}'); }
    res.writeHead(404); res.end('nope');
  });
  server._c = {};
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('T-G2-picker: recognizes a picker-first form, selects a valid option, commits revealed rows, then creates', async () => {
  const server = await startPickerServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { stdout } = await execFileP(process.execPath,
      [TOOL, '--url', base + '/', '--scope', '127.0.0.1', '--cookie', 'x', '--submit', '--marker', 'PENTEST-g2p', '--max-forms', '2'],
      { maxBuffer: 32 * 1024 * 1024 });
    const out = JSON.parse(stdout.trim());
    assert.equal(out.ok, true);
    assert.equal(server._c['/inventories/1'], 1, `line 1 committed once (got ${server._c['/inventories/1']})`);
    assert.equal(server._c['/inventories/2'], 1, `line 2 committed once (got ${server._c['/inventories/2']})`);
    assert.equal(server._c['/invoice'], 1, 'the parent invoice was created once after the rows committed');
    assert.ok((out.actions || []).some((a) => a.request.path === '/invoice'), 'the create was captured');
  } finally { server.close(); }
});

// T-bug1 — a create whose ONLY proof is a URL change to a detail route (POST 200, no id/Location) must be
// `created`, not `blocked`.
function startUrlChangeServer() {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/') return html(res, page(`
      <h1>New order</h1><input name="ref" placeholder="ref"><button id="go" class="btn-primary">Create</button>
      <script>document.getElementById('go').addEventListener('click',()=>{
        fetch('/api/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"ref":"x"}'})
          .then(()=>{ history.pushState({},'', '/orders/123'); });  // create proven only by client navigation
      });</script>`));
    if (req.method === 'POST' && u.pathname === '/api/orders') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"status":"ok"}'); }  // 200, NO id, NO Location
    res.writeHead(404); res.end('nope');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('T-bug1: a create proven only by a URL change to /…/{id} is `created`, not `blocked`', async () => {
  const server = await startUrlChangeServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { stdout } = await execFileP(process.execPath,
      [TOOL, '--url', base + '/', '--scope', '127.0.0.1', '--cookie', 'x', '--submit', '--marker', 'PENTEST-b1'],
      { maxBuffer: 32 * 1024 * 1024 });
    const out = JSON.parse(stdout.trim());
    assert.equal(out.ok, true);
    const act = (out.actions || []).find((a) => a.request.path === '/api/orders');
    assert.ok(act, `URL-change create recorded in actions, not blocked (blocked=${JSON.stringify(out.blocked)})`);
    assert.equal(act.created && act.created.id, '123', 'id captured from the URL detail route');
  } finally { server.close(); }
});

// T-bug2 — a GraphQL read-POST (`{query}`) and an ag-grid list POST are classified mutation:false (not seeded).
function startReadPostServer() {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/') return html(res, page(`
      <div id="cb" role="combobox">Search</div>
      <div id="lb" role="listbox" style="display:none"><input id="s" placeholder="Search items"></div>
      <script>
        document.getElementById('cb').addEventListener('click',()=>{document.getElementById('lb').style.display='block';});
        document.getElementById('s').addEventListener('input',()=>{
          fetch('/api/graphql',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:'query Q($k:String){items(k:$k){id}}',variables:{k:'a'}})});
          fetch('/api/rows',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filterModel:{},startRow:0,endRow:100})});
          fetch('/transaction/api/v1/create-activity-log',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"e":1}'});
        });
      </script>`));
    if (u.pathname === '/api/graphql' || u.pathname === '/api/rows' || u.pathname === '/transaction/api/v1/create-activity-log') { res.writeHead(200,{'Content-Type':'application/json'}); return res.end('{"data":{}}'); }
    res.writeHead(404); res.end('nope');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('T-bug2: a GraphQL query / ag-grid list POST is classified mutation:false (read-POST, not a seed)', async () => {
  const server = await startReadPostServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { stdout } = await execFileP(process.execPath,
      [TOOL, '--url', base + '/', '--scope', '127.0.0.1', '--cookie', 'x', '--max-widgets', '3'],   // dry-run: the read-POSTs still fire
      { maxBuffer: 32 * 1024 * 1024 });
    const out = JSON.parse(stdout.trim());
    assert.equal(out.ok, true);
    const sw = out.session_writes || [];
    const gql = sw.find((w) => w.path === '/api/graphql');
    const rows = sw.find((w) => w.path === '/api/rows');
    assert.ok(gql, `graphql POST was captured (got ${JSON.stringify(sw)})`);
    assert.equal(gql.mutation, false, 'GraphQL query POST is mutation:false');
    assert.ok(rows && rows.mutation === false, 'ag-grid list POST is mutation:false');
    const log = sw.find((w) => w.path === '/transaction/api/v1/create-activity-log');
    assert.ok(log && log.mutation === false, 'a telemetry (activity-log) POST is mutation:false, not a seed');
  } finally { server.close(); }
});
