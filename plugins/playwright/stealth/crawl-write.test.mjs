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

// Reproduces the real-world Vue pattern (app.demo-achilles.id /transaction sale +add): a custom dropdown
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
      [TOOL, '--url', base + '/', '--scope', '127.0.0.1', '--cookie', 'sess=x', '--submit', '--marker', 'PENTEST-flow', '--max-steps', '4'],
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
  } finally { server.close(); }
});
