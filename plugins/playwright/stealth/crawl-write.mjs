#!/usr/bin/env node
// crawl-write.mjs — AUTHORIZED, gated interactive WRITE-mode exerciser (the deterministic backbone of the
// pentest `crud-exerciser` agent). It drives an authenticated app, finds CREATE forms, fills them with
// MARKER-tagged, field-compliant values, SUBMITS, and captures the real write request (method/host/path/body)
// + the created object {id} — emitting `crud-exercise.json` that `crud-merge.mjs` turns into the BOLA/injection
// seeds (crud-merge DERIVES the {id}-bearing GET/PUT/DELETE, so we never execute a destructive request here).
//
// SAFETY — this tool MUTATES state, so it is armed by TWO explicit flags and refuses otherwise:
//   • default is --dry-run: it discovers/introspects/synthesizes and reports what it WOULD send, submitting NOTHING.
//   • it submits ONLY with BOTH `--submit` AND a non-empty `--marker` (every created value carries the marker).
//   • it only ever clicks a form's own create/save submit; it NEVER clicks delete/remove/bulk/reset controls.
//   • CREATE only (1 object/form, capped). Modify/Delete are DERIVED downstream, never performed here.
// Authorization (environment/RoE) is the caller's gate — see the crud-exerciser agent Phase 0.
//
// WIDGET/TYPEAHEAD DISCOVERY (--widgets, default ON, READ-ONLY — safe even in dry-run): custom dropdowns
// (`<div role=combobox>`, mat-select, …) and searchable typeaheads are INVISIBLE to native-`<select>` scraping,
// yet they hide injectable params: typing in a typeahead fires `?keyword=…`, selecting an option echoes its
// value into `?name=…`. This pass opens add-dialogs + custom dropdowns, types a probe, and selects a few
// options — capturing those option-driven data endpoints/params into `widget-param-inventory.json` (feeds
// `/pentest:sql`). It only reads (search/select never submit the form), so it runs regardless of --submit.
//
// Usage:
//   node crawl-write.mjs --url https://app/ [--cookie "sess=…"|--header "Authorization: Bearer …"|--state s.json]
//     --marker PENTEST-run7 --submit           # ARM: actually create marker-tagged objects
//     [--dry-run]                              # (default) discover + preview, submit nothing
//     [--scope host.com] [--exclude idp.host.com,/admin] [--proxy http://127.0.0.1:8080]
//     [--max-forms 6] [--out outputs/ENG/crud]
//     [--viewport 1366x900] [--timeout 30000] [--no-headless] [--insecure]

import { parseArgs } from 'node:util';
import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bodySignature, flattenParams, normPath } from './op-signature.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const emit = (o) => process.stdout.write(JSON.stringify(o, null, 2) + '\n');

try { await access(path.join(here, 'node_modules', 'playwright-extra')); }
catch { emit({ ok: false, error: 'deps_missing', hint: `run once: (cd ${here} && npm install)` }); process.exit(2); }

let a;
try {
  ({ values: a } = parseArgs({ allowNegative: true, options: {
    url:      { type: 'string' },
    marker:   { type: 'string' },
    owner:    { type: 'string' },   // identity label to stamp on captured creates (feeds the BOLA oracle via crud-merge)
    scope:    { type: 'string' },
    exclude:  { type: 'string' },   // out-of-scope deny-list: host suffixes and/or '/path' prefixes (comma-separated)
    state:    { type: 'string' },
    cookie:   { type: 'string' },
    header:   { type: 'string', multiple: true },
    proxy:    { type: 'string' },
    out:      { type: 'string' },
    viewport: { type: 'string' },
    timeout:  { type: 'string', default: '30000' },
    'max-forms': { type: 'string', default: '6' },
    'max-views': { type: 'string', default: '15' },   // pages to visit while following links looking for forms
    'seed-route': { type: 'string', multiple: true },  // G1 — operator-supplied create routes to visit (repeatable)
    seeds: { type: 'string' },                         // G1 — a file of seed routes, one per line
    widgets:  { type: 'boolean', default: true },     // read-only: exercise custom dropdowns/typeaheads for param discovery
    'max-widgets': { type: 'string', default: '10' },
    'max-options': { type: 'string', default: '3' },  // option values to select per dropdown (each may echo a param)
    'max-steps':   { type: 'string', default: '4' },  // multi-step (wizard) advances to try before giving up on a create
    submit:   { type: 'boolean', default: false },   // ARM: without it, dry-run (no submit)
    'dry-run':{ type: 'boolean', default: false },   // force dry-run even if --submit
    headless: { type: 'boolean', default: true },
    insecure: { type: 'boolean', default: true },
  } }));
} catch (e) { emit({ ok: false, error: `bad args: ${e.message}` }); process.exit(2); }
if (!a.url) { emit({ ok: false, error: 'missing --url' }); process.exit(2); }
// Safety: submitting requires a marker so every created object is identifiable. Refuse an unmarked submit.
if (a.submit && !(a.marker && a.marker.trim())) {
  emit({ ok: false, error: 'refusing to submit without --marker (every created object must be marker-tagged)' }); process.exit(2);
}
const armed = !!(a.submit && a.marker && a.marker.trim() && !a['dry-run']);
const MARKER = (a.marker || 'PENTEST-DRYRUN').trim();

// ── scope (same model as crawl.mjs): a domain-suffix allow-list, default = start host registrable domain ──
const startHost = new URL(a.url).hostname;
const MULTI_SUFFIX = /\.(co|com|net|org|gov|edu|ac|or|ne|go)\.[a-z]{2}$/i;
const defaultScope = (MULTI_SUFFIX.test(startHost) ? startHost.split('.').slice(-3) : startHost.split('.').slice(-2)).join('.');
const SCOPE = (a.scope ? a.scope.split(',') : [defaultScope]).map((s) => s.trim().toLowerCase()).filter(Boolean);
// ── out-of-scope deny-list (--exclude): entries starting with '/' are PATH prefixes, the rest are HOST suffixes ──
// DENY BEATS ALLOW. This matters because the allow-list above is a *registrable-domain* suffix match, so it admits
// every sibling subdomain of the start host — including ones the operator explicitly excluded (a third-party IdP,
// a shared SSO host, a prod twin). Without this, an ARMED run fills and SUBMITS forms on hosts that were never
// authorized. The check is applied to every URL the crawler records, enqueues, navigates to, or submits on.
const EX = (a.exclude ? a.exclude.split(',') : []).map((s) => s.trim().toLowerCase()).filter(Boolean);
const EXCLUDE_HOSTS = EX.filter((s) => !s.startsWith('/'));
const EXCLUDE_PATHS = EX.filter((s) => s.startsWith('/'));
const excluded = { hits: 0, samples: [] };   // reported in the output so a silent deny is still visible
const isExcluded = (host, pathname) =>
  EXCLUDE_HOSTS.some((s) => host === s || host.endsWith('.' + s)) ||
  (!!pathname && EXCLUDE_PATHS.some((p) => pathname.toLowerCase().startsWith(p)));
const inScope = (host, pathname = '') => {
  if (!SCOPE.some((s) => host === s || host.endsWith('.' + s))) return false;
  if (isExcluded(host, pathname)) {
    excluded.hits++;
    if (excluded.samples.length < 10 && !excluded.samples.includes(host + pathname)) excluded.samples.push(host + pathname);
    return false;
  }
  return true;
};
const timeout = +a.timeout;
const viewport = a.viewport ? { width: +a.viewport.split('x')[0], height: +a.viewport.split('x')[1] } : undefined;

// NEVER click a submit that looks destructive.
const DESTRUCTIVE = /\b(delete|remove|supprim|effac|drop|purge|reset|clear|bulk|deactivate|revoke|hapus)\b/i;
// The submit is chosen LABEL-AGNOSTICALLY: we don't match the action's name (Save/Submit/Valider/Kirim/Simpan/
// 確定/…) — we EXCLUDE these cancel/back/close labels (multilingual) and take the primary action among the rest.
const CANCEL_BACK = /\b(cancel|annul|close|fermer|ferme|back|retour|previous|préc[eé]dent|precedent|dismiss|discard|batal|tutup|kembali|abort|logout|log-out|signout|sign-out|deconnex|déconnex|menu|help|aide)\b/i;
const CREATE_HINT = /\b(save|submit|create|add|new|nouveau|créer|creer|ajouter|enregistrer|valider|confirm|simpan|kirim|buat|tambah)\b/i;
const cssAttr = (s) => String(s).replace(/["\\]/g, '\\$&');
// Never follow a link that would end the session or mutate state by navigation alone.
const AVOID_LINK = /\b(logout|log-out|signout|sign-out|deconnex|déconnex|disconnect|delete|remove|supprim|drop|revoke)\b/i;
const CREATEISH_LINK = /(create|\/new\b|\/add\b|nouveau|ajouter|créer|creer|register|inscription)/i;
// G2 — custom pickers/typeaheads that act as a form ENTRY POINT (Vuetify v-autocomplete/v-select, Angular
// Material mat-select, ARIA comboboxes, searchable typeaheads). Recognizing these is what lets the harness treat
// a picker-first form (a buyer search that, once selected, REVEALS the rest of the form) as a form-region.
const PICKER_SEL = '[role="combobox"], [aria-haspopup="listbox"], mat-select, .v-autocomplete, .v-select, .v-combobox, [class*="autocomplete"], [class*="typeahead"], input[aria-autocomplete]';
const PICKER_SEL_VIS = PICKER_SEL.split(', ').map((s) => s + ':visible').join(', ');
// F7/G3 — a blocking error can surface as a toast OR inline validation. Multilingual: match "invalid"/"error"/…
// AND a generic "<negation> … valid" (e.g. "not a valid", "non valide", "nicht gültig") — no single language hard-coded.
// (Defined here, before the main top-level-await block, so the hoisted helpers below can use them without a TDZ error.)
const BLOCKING_RE = /(error|invalid|missing|required|mandatory|must\s+be|failed|failure|wrong|incomplete|not\s+valid)/i;
const NEG_VALID_RE = /\b(tidak|not|non|no|nicht|geen|pas|niet|belum|ne|nem|inte)\b(?:\s+\S+){0,3}\s+valid/i;
const isBlockingText = (t) => !!t && (BLOCKING_RE.test(t) || NEG_VALID_RE.test(t));

// ── field-compliant, marker-tagged value synthesis ──────────────────────────────────────────────────────
const today = () => new Date().toISOString().slice(0, 10);
function synthValue(f, n, salt = 0) {
  const name = (f.name || '').toLowerCase();
  const t = (f.type || 'text').toLowerCase();
  const tag = f.tag;
  const clip = (s) => (f.maxlength && f.maxlength > 0 ? s.slice(0, f.maxlength) : s);
  const num = () => {
    // vary with salt (the retry/step index) so a unique-constrained numeric field gets a fresh value on retry,
    // while staying within [min, max]. (The old ternary returned v on both branches → salt was dead.)
    let v = (Number.isFinite(f.min) ? f.min : 1) + salt;
    if (Number.isFinite(f.max)) v = Math.min(v, f.max);
    return String(v);
  };
  if (t === 'email' || /e-?mail/.test(name)) return `${MARKER}+${n}${salt || ''}@example.com`;
  if (t === 'number' || t === 'range' || /(amount|price|qty|quantity|count|total|number|montant|prix)/.test(name)) return num();
  if (t === 'date') return today();
  if (t === 'datetime-local') return today() + 'T12:00';
  if (t === 'month') return today().slice(0, 7);
  if (t === 'time') return '12:00';
  if (t === 'tel' || /(phone|tel|mobile|gsm)/.test(name)) return `+1555000${String(1000 + n + salt).slice(-4)}`;
  if (t === 'url' || /(url|website|site|lien)/.test(name)) return `https://example.com/${MARKER}-${n}`;
  if (t === 'password') return `${MARKER}-Aa1!${n}${salt}`;
  if (t === 'color') return '#3366cc';
  // text / textarea / search / default — marker-tagged, boundary-safe
  return clip(`${MARKER}-${n}${salt ? '-' + salt : ''}`);
}
// F2 — extract the CREATED object's id from the response, robustly. The old version returned the FIRST id found
// at ANY depth, so a response echoing `owner:{id:<company_id>}` yielded the auth principal's id — which
// crud-merge then turned into a cross-tenant GET/PUT/DELETE corpus (a DELETE against the real company). Now:
//   • prefer a TOP-LEVEL id, or one under a standard result wrapper (data/result/…), shallow-first;
//   • NEVER descend into an auth-principal node (owner/user/company/tenant/…) to read an id;
//   • REJECT any value echoed from the request body (an id the client itself sent back is not proof of a new object).
const ID_KEY = /^(id|_id|uuid|pk|guid|slug)$/i;
const WRAP_KEY = /^(data|result|results|payload|item|object|record|entity|created|resource|response)$/i;
const AUTH_WRAP = /^(owner|user|users|company|companies|tenant|account|author|creator|created_?by|principal|actor|org|organization|profile|parent)$/i;
function findId(obj, echo, prefix = '', depth = 0) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || depth > 4) return null;
  // 1) an id key at THIS level, not echoed from the request
  for (const [k, v] of Object.entries(obj)) {
    if (ID_KEY.test(k) && (typeof v === 'string' || typeof v === 'number') && String(v)) {
      const val = String(v);
      if (!(echo && echo.has(val))) return { id: val, id_field: prefix ? `${prefix}.${k}` : k };
    }
  }
  // 2) descend ONLY into standard result wrappers — never into an auth-principal node. Handle both an object
  //    wrapper (`{data:{id}}`) and an ARRAY wrapper (`{data:[{id}]}` — the created object as the first element).
  for (const [k, v] of Object.entries(obj)) {
    if (!v || typeof v !== 'object' || !WRAP_KEY.test(k) || AUTH_WRAP.test(k)) continue;
    const child = Array.isArray(v) ? v[0] : v;
    const childField = Array.isArray(v) ? `${prefix ? prefix + '.' : ''}${k}[0]` : (prefix ? `${prefix}.${k}` : k);
    const r = findId(child, echo, childField, depth + 1); if (r) return r;
  }
  return null;
}
// F2 — a response id is an ECHO (not a new object id) only when the SAME value was sent under an AUTH-PRINCIPAL
// key (company/tenant/owner/user/…). The patch #2 version collected EVERY request leaf, so it wrongly rejected a
// legitimate client-supplied id (a UUID, an idempotency key, a low integer that collides with a submitted number)
// → `created` without an id → an EMPTY BOLA corpus. Restrict the echo set to auth-principal fields only.
const AUTH_PRINCIPAL_KEY = /^(company|companies|tenant|org|organization|owner|user|users|account|principal|actor|created_?by)(_?id)?$/i;
function collectEchoValues(reqBodyStr) {
  const set = new Set();
  if (!reqBodyStr) return set;
  const add = (k, v) => { if ((typeof v === 'string' || typeof v === 'number') && AUTH_PRINCIPAL_KEY.test(String(k))) set.add(String(v)); };
  try {
    (function walk(o) { if (o == null || typeof o !== 'object') return; for (const [k, v] of Object.entries(o)) { if (v && typeof v === 'object') walk(v); else add(k, v); } })(JSON.parse(reqBodyStr));
  } catch { for (const kv of String(reqBodyStr).split('&')) { const [k, v] = kv.split('='); if (v) { try { add(k, decodeURIComponent(v)); } catch { add(k, v); } } } }
  return set;
}
// F1 — token fragments that HINT a non-persistent write (preview / validation / telemetry / typeahead / read).
// For the CREATE oracle this is ADVISORY: a strong positive signal (201 / Location / URL→detail / non-echoed id)
// OVERRIDES it, so a real 201 on a `…/validation` path is still a create. Checked on the TERMINAL segment ONLY
// (a create nested under `.../vendor/` is not disqualified by a parent segment). The full set (incl. activity/
// log/count/list) is kept because the collector's positive-override makes it safe, and it correctly marks a
// telemetry POST (e.g. an activity-log 200) as a NON-mutation for session-write seeding. See non-persist-tokens.mjs.
import { NON_PERSIST_TOKENS } from './non-persist-tokens.mjs';
const isNonPersistTerminal = (pathname) => {
  const segs = String(pathname).toLowerCase().replace(/\/+$/, '').split('/').filter(Boolean);
  const last = segs[segs.length - 1] || '';
  return last.split(/[-_.]+/).filter(Boolean).some((t) => NON_PERSIST_TOKENS.has(t));
};
// bug#2 — a POST can be a READ, not a mutation: a GraphQL query (`{query, variables}` where the op is not a
// `mutation`, or a `/graphql` terminal) or an ag-grid/datatable list POST (`filterModel`/`startRow`/`rowGroupCols`
// /`sortModel`). Classify these as reads so crud-merge never replays them cross-identity as mutations.
function isReadPost(pathname, reqBodyStr) {
  const last = String(pathname).toLowerCase().replace(/\/+$/, '').split('/').filter(Boolean).pop() || '';
  let graphqlTerminal = last === 'graphql';
  if (!reqBodyStr) return graphqlTerminal;
  try {
    const j = JSON.parse(reqBodyStr);
    if (j && typeof j === 'object') {
      if (typeof j.query === 'string') return !/^\s*mutation\b/i.test(j.query);   // GraphQL: only `mutation …` writes
      if (j.operationName && !('input' in j) && !('variables' in j && j.variables && j.variables.input)) return true;
      if ('filterModel' in j || 'startRow' in j || 'endRow' in j || 'rowGroupCols' in j || 'sortModel' in j) return true;   // ag-grid list
    }
  } catch { /* form-encoded / non-JSON → not a recognizable read-POST */ }
  return graphqlTerminal;
}
function idFromLocation(loc) { if (!loc) return null; const seg = String(loc).split('?')[0].replace(/\/$/, '').split('/').pop(); return seg && /[0-9a-f-]{2,}/i.test(seg) ? { id: seg, id_field: 'Location' } : null; }

// ── DOM introspection: enumerate a form's fillable named fields (runs in the page) ───────────────────────
// G2 — a "form region" is a cluster of fillable controls, with or without a <form>. Enumerate native inputs
// AND framework controls (contenteditable, role=textbox/spinbutton — the Vuetify/React shape that has no
// <form> and often no name), derive a name from aria-label/placeholder so NAMELESS fields stay typeable, and
// tag each element with data-cx-field so we can locate it reliably regardless of name/id.
const INTROSPECT = `(formEl) => {
  const F = formEl || document;
  // clear stale tags first so re-introspection (each step) never collides two elements on one data-cx-field.
  document.querySelectorAll('[data-cx-field]').forEach((e) => e.removeAttribute('data-cx-field'));
  const out = [];
  let idx = 0;
  for (const el of F.querySelectorAll('input, select, textarea, [contenteditable="true"], [role="textbox"], [role="spinbutton"]')) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || '';
    const ce = el.getAttribute('contenteditable') === 'true' || role === 'textbox' || role === 'spinbutton';
    const type = ce ? (role === 'spinbutton' ? 'number' : 'text')
                    : (el.getAttribute('type') || (tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : 'text')).toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(type)) continue; // skip: tokens kept as-is, files unsafe
    const name = el.getAttribute('name') || el.getAttribute('id') || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
    if (!name) continue;
    const hidden = el.offsetParent === null && type !== 'radio' && type !== 'checkbox';
    if (hidden) continue; // not visible
    el.setAttribute('data-cx-field', String(idx));
    const opts = tag === 'select' ? Array.from(el.options).map((o) => o.value).filter((v) => v !== '') : null;
    const min = el.getAttribute('min'), max = el.getAttribute('max'), ml = el.getAttribute('maxlength');
    out.push({ cx: idx, name, tag, type, ce, required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
      pattern: el.getAttribute('pattern') || null, options: opts,
      min: min != null ? Number(min) : null, max: max != null ? Number(max) : null,
      maxlength: ml != null ? Number(ml) : null });
    idx++;
  }
  return out;
}`;

const { launch, newStealthContext } = await import('./browser.mjs');
const emitOut = { ok: true, armed, marker: armed ? MARKER : null, mode: armed ? 'submit' : 'dry-run', start_url: a.url,
  scope: SCOPE, exclude: { hosts: EXCLUDE_HOSTS, paths: EXCLUDE_PATHS } };
const actions = [];
const intents = [];
const blocked = [];        // G5: submits that fired no real write (client no-op / validation block) + the read reason
const sessionWrites = [];  // G6: every in-scope write seen this session (seeds for BOLA/injection), incl. intermediate
const findings = [];       // G6: 4xx/5xx writes (endpoint contract + server bug), never silently dropped
const formsToDrive = [];   // HANDOFF: complex/picker-first form-regions the deterministic filler did NOT complete
                           // — emitted for the AI tier (crud-exerciser / form-driver) to drive adaptively.
let browser, ctx;
try {
  browser = await launch({ headless: a.headless, proxy: a.proxy || null });
  // --header goes into extraHTTPHeaders (Authorization Bearer etc. — browser-honored); --cookie is injected as
  // REAL cookies via addCookies (P0: a Cookie HEADER is dropped on HTTPS+proxy and invisible to document.cookie).
  const extraHeaders = {};
  for (const h of (a.header || [])) { const i = h.indexOf(':'); if (i > 0) extraHeaders[h.slice(0, i).trim()] = h.slice(i + 1).trim(); }
  // COMPLETE-TRAFFIC HAR (per-session timestamped path) — captures the reads the crud pass fires but persists only as writes.
  let harPath;
  if (a.out) { const harDir = path.join(a.out, 'har'); await mkdir(harDir, { recursive: true }).catch(() => {}); harPath = path.join(harDir, `crud-${Date.now()}.har`); }
  ctx = await newStealthContext(browser, { insecure: a.insecure, viewport, harPath, storageState: a.state || undefined,
    extraHeaders: Object.keys(extraHeaders).length ? extraHeaders : undefined, cookie: a.cookie || undefined, cookieScope: SCOPE[0] });

  // Wire-level enforcement of --exclude. The frontier filter and the pre-submit gate stop us NAVIGATING to or
  // WRITING on an excluded page, but an in-scope page's own JS can still fire an XHR at an excluded host/path
  // (a shared IdP, an /admin API) — and a browser-driven crawler cannot know a button's target before it fires.
  // Aborting at the request layer is the only place that guarantee can be made. Installed ONLY when the operator
  // actually passed --exclude, so the default crawl keeps its untouched, un-intercepted network path.
  if (EX.length) {
    await ctx.route('**/*', (route) => {
      try {
        const u = new URL(route.request().url());
        if (isExcluded(u.hostname.toLowerCase(), u.pathname)) {
          excluded.hits++;
          if (excluded.samples.length < 10 && !excluded.samples.includes(u.hostname + u.pathname)) excluded.samples.push(u.hostname + u.pathname);
          return route.abort('blockedbyclient');
        }
      } catch { /* unparseable URL — fall through to continue */ }
      return route.continue();
    });
  }

  // Read-only data-request capture (for widget/typeahead param discovery): record in-scope XHR/fetch WITH their
  // request BODY, deduped by operation signature. A dropdown search (?keyword=…), an option select (?name=…),
  // OR a POST-body param (typeahead POST, ag-grid filterModel.keyword, GraphQL variables) becomes an inventoried,
  // testable parameter here — the injection surface a native-<select> scrape and a path-crawl both miss.
  const captured = [];
  const seenReq = new Set();
  ctx.on('request', (req) => {
    try {
      if (!['xhr', 'fetch'].includes(req.resourceType())) return;
      const u = new URL(req.url());
      if (!inScope(u.hostname.toLowerCase(), u.pathname)) return;
      const post = req.postData() || null;
      // dedup by operation signature (method + normalized path + body shape + query) — the same canonical kernel
      // the recon crawler uses, so filter/sort variants of one grid POST stay distinct while pagination collapses.
      const key = bodySignature(req.method(), normPath(u.pathname), post, u.search);
      if (seenReq.has(key)) return; seenReq.add(key);
      captured.push({ method: req.method(), host: u.hostname, path: u.pathname, query: u.search, post_data: post });
    } catch { /* ignore */ }
  });

  // G6 — WRITE capture (all statuses): every in-scope non-GET/HEAD response becomes a seed; 4xx/5xx also
  // becomes a `finding` (endpoint contract + server bug). This captures the INTERMEDIATE writes of a nested
  // form (a buyer-create POST, a line PUT) — not just the terminal create — and the errors the app leaks.
  const seenWrite = new Set();
  ctx.on('response', async (resp) => {
    try {
      const rq = resp.request(); const m = rq.method();
      if (m === 'GET' || m === 'HEAD') return;
      const u = new URL(rq.url());
      if (!inScope(u.hostname.toLowerCase(), u.pathname)) return;
      const status = resp.status();
      const key = `${m} ${u.hostname}${normPath(u.pathname)} ${status}`;
      if (seenWrite.has(key)) return; seenWrite.add(key);
      const ct = (resp.headers()['content-type'] || '').split(';')[0] || null;
      let reqBody; try { reqBody = rq.postData() || undefined; } catch { reqBody = undefined; }
      // F5 — classify each write so crud-merge seeds only real MUTATIONS, not read-POSTs (a GraphQL query, an
      // ag-grid list POST, a search). Signal = method + status + form: PUT/PATCH/DELETE always mutate; a POST is a
      // mutation only on a 201, a Location, or a 2xx to a non-preview/search/telemetry terminal segment.
      const loc = resp.headers()['location'] || null;
      // bug#2 — a GraphQL query / ag-grid list POST is a READ, never a mutation seed (even to a non-preview path).
      const mutation = /^(PUT|PATCH|DELETE)$/i.test(m)
        || (m === 'POST' && !isReadPost(u.pathname, reqBody) && (status === 201 || !!loc || (status >= 200 && status < 300 && !isNonPersistTerminal(u.pathname))));
      sessionWrites.push({ method: m, host: u.hostname, path: u.pathname, status, content_type: ct, mutation });
      if (status >= 400) {
        let snippet = ''; try { snippet = (await resp.text()).slice(0, 300); } catch { /* body unavailable */ }
        findings.push({ type: 'error_write', method: m, host: u.hostname, path: u.pathname, status, request_body: reqBody, snippet });
      }
    } catch { /* ignore */ }
  });

  // a write "landed" = a non-GET/HEAD in-scope response — used to await each sub-entity commit.
  const writePredicate = (r) => { try { const rq = r.request(); const uu = new URL(rq.url()); return rq.method() !== 'GET' && rq.method() !== 'HEAD' && inScope(uu.hostname.toLowerCase(), uu.pathname); } catch { return false; } };

  const page = await ctx.newPage();
  await page.goto(a.url, { waitUntil: 'domcontentloaded', timeout }).catch(() => {});
  await mountSettle(page);   // G1: wait for the SPA shell + micro-app to mount before introspecting

  // Breadth-first navigation: follow the links we find (create-labelled ones FIRST, then any in-scope
  // internal link) and discover/exercise forms on EVERY page we land on — not just the start page. Bounded
  // by --max-views (pages) and --max-forms (forms). Never follows a logout/delete link (would kill the session).
  const maxForms = +a['max-forms'];
  const maxViews = +a['max-views'];
  const MAX_WIDGETS = +a['max-widgets'];
  const MAX_OPTIONS = +a['max-options'];
  const MAX_STEPS = +a['max-steps'];
  const DLG = '[role="dialog"]:visible, mat-dialog-container:visible, .modal:visible, .cdk-dialog-container:visible, .cdk-overlay-pane:visible';
  let processedForms = 0;
  const visited = new Set();     // routeKeys already SELECTED as a nav target OR landed on — nav dedup
  const processed = new Set();   // routeKeys whose forms/widgets we've exercised — page-work dedup (distinct!)
  const pagesVisited = [];

  const visitAndExercise = async () => {
    const key = routeKey(page.url());
    if (processed.has(key)) return;   // dedup page WORK on `processed`, not `visited` — a pre-selected target
    processed.add(key);               // key may already be in `visited`, but its page still needs exercising.
    visited.add(key);
    pagesVisited.push(page.url());
    const beforeA = actions.length, beforeB = blocked.length;
    await processFormsOnPage(page);
    // HANDOFF (armed only — driving is state-changing, so "could not complete" is meaningless in dry-run where the
    // filler completes nothing). Flag a form-region the backbone did NOT complete, on two INDEPENDENT triggers:
    //  - submit-no-write: it clicked submit and captured no write (ANY form, picker or not) — the hardest forms;
    //  - picker-first:   a picker + a create-hint primary action it never drove to a write.
    // An out-of-scope page must NOT reach this handoff: `blocked` grows when the gate refuses a form, which would
    // otherwise read as "submit-no-write" and dispatch the form-driver AI tier against an excluded form — worse
    // than the bug the gate exists to fix. Re-check the page here rather than infer it from `blocked`.
    const pageInScope = (() => { try { const u = new URL(page.url()); return inScope(u.hostname.toLowerCase(), u.pathname); } catch { return false; } })();
    try {
      if (armed && pageInScope && actions.length === beforeA && !formsToDrive.some((f) => f.url === page.url())) {
        const submittedNoWrite = blocked.length > beforeB;
        const pickers = await page.$$eval(PICKER_SEL_VIS, (els) => els.slice(0, 6)
          .map((e) => (e.getAttribute('placeholder') || e.getAttribute('aria-label') || e.tagName).trim().slice(0, 60)).filter(Boolean));
        const btns = await page.$$eval('button,[role="button"]', (els) => els
          .map((e) => (e.innerText || e.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(0, 60)).catch(() => []);
        const cands = [...new Set(btns.filter((t) => CREATE_HINT.test(t) && !CANCEL_BACK.test(t) && !DESTRUCTIVE.test(t)))];
        // prefer the PARENT submit over a sub-entity add ("new line item", "add another", "add documents", …)
        const primary = cands.find((t) => !/\b(new line|add (item|line|row|another|documents?))\b/i.test(t)) || cands[cands.length - 1] || null;
        if (submittedNoWrite || (pickers.length && primary)) {
          formsToDrive.push({
            id: 'ff-' + (formsToDrive.length + 1), route: routeOf(page.url()), url: page.url(),
            reason: submittedNoWrite ? 'submit-no-write' : 'picker-first',
            detected: { pickers, primary_action: primary, candidate_actions: cands.slice(0, 8) },
            // recent in-scope writes = the load-time telemetry/preview endpoints the driver must NOT count as creates
            background_writes: sessionWrites.slice(-10).map((w) => ({ method: w.method, host: w.host, path: w.path, status: w.status, mutation: w.mutation })),
          });
        }
      }
    } catch { /* detection best-effort */ }
    await enumerateWidgets(page);   // read-only: custom dropdowns / typeaheads → option-driven param discovery
  };

  // G1 — GLOBAL BFS frontier (not just the current page's links). A dead-end route (a 404 tile, an empty SPA
  // stub) visited first would otherwise stall the crawl before a real form is reached; a persistent queue of all
  // discovered in-scope routes (create-ish first) survives dead-ends. navigateTo() reaches non-anchor routes via goto.
  const frontier = [];
  const enqueued = new Set();
  const harvest = async () => {
    const found = await collectRoutes(page);   // broadened attr harvest → absolute, in-scope, non-avoid routes
    found.sort((x, y) => (CREATEISH_LINK.test(y.href + ' ' + y.text) ? 1 : 0) - (CREATEISH_LINK.test(x.href + ' ' + x.text) ? 1 : 0));
    for (const l of found) { const k = routeKey(l.href); if (!enqueued.has(k) && !visited.has(k)) { enqueued.add(k); frontier.push(l.href); } }
  };

  // G1 — SEED ROUTES: an operator-supplied list of known create routes (--seed-route, repeatable, and/or a
  // --seeds file). On a micro-frontend launcher that exposes no crawlable `<a href>`, this is the most reliable
  // way to reach a create view. Seeds are resolved against the start URL, scope-checked, and enqueued FIRST (they
  // are the highest-value targets); auto-discovery still runs on top. Operator INPUT — never a hard-coded target.
  const seedRoutes = [...(a['seed-route'] || [])];
  if (a.seeds) { try { for (const line of (await readFile(a.seeds, 'utf8')).split(/\r?\n/)) { const s = line.trim(); if (s && !s.startsWith('#')) seedRoutes.push(s); } } catch { /* unreadable seeds file — ignore */ } }
  const seedFrontier = [];
  for (const s of seedRoutes) {
    let abs; try { abs = new URL(s, a.url).href; } catch { continue; }
    try { const uu = new URL(abs); if (!inScope(uu.hostname.toLowerCase(), uu.pathname)) continue; } catch { continue; }
    const k = routeKey(abs);
    if (!enqueued.has(k) && !visited.has(k)) { enqueued.add(k); seedFrontier.push(abs); }
  }
  emitOut.seed_routes = seedFrontier.length;

  await visitAndExercise();                              // start page
  await harvest();
  frontier.unshift(...seedFrontier);                     // seeds jump the queue — visit the known create routes first
  let views = 0;
  while (views < maxViews && frontier.length) {          // navigation budget = --max-views, independent of --max-forms
    const target = frontier.shift();
    const k = routeKey(target);
    if (visited.has(k)) continue;                        // already landed here via another link
    visited.add(k);                                      // mark BEFORE navigating so a dead/hash link can't be re-queued
    views++;
    try {
      if (!(await navigateTo(page, target))) continue;
      await mountSettle(page);   // G1: SPA route change re-mounts a micro-app — wait for it before exercising
      await visitAndExercise();
      await harvest();                                   // discover routes revealed by THIS page too
    } catch { /* stale/blocked link — keep going */ }
  }

  // ── widget/typeahead discovery → param inventory (query AND body params, normalized-path keyed) ──
  const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  const epMap = new Map();
  for (const r of captured) {
    const np = normPath(r.path);                          // /api/vendors/42/x → /api/vendors/{id}/x (dedup)
    const k = `${r.host} ${r.method} ${np}`;
    if (!epMap.has(k)) epMap.set(k, { host: r.host, method: r.method, path: np, params: new Set() });
    const e = epMap.get(k);
    if (r.query) for (const key of new URLSearchParams(r.query).keys()) e.params.add('query:' + key);
    if (r.post_data) {                                    // BODY params — json leaves (nested) or form keys
      try { const j = JSON.parse(r.post_data); const s = new Set(); flattenParams(j, '', s); for (const p of s) e.params.add('json:' + p); }
      catch { for (const kv of r.post_data.split('&')) if (kv.split('=')[0]) e.params.add('form:' + safeDecode(kv.split('=')[0])); }
    }
  }
  const discovered = [...epMap.values()].map((e) => ({ host: e.host, method: e.method, path: e.path, params: [...e.params] }));
  const paramInv = discovered.filter((e) => e.params.length)
    .map((e) => ({ endpoint: e.path, method: e.method, host: e.host,
      params: e.params.map((p) => { const [loc, ...rest] = p.split(':'); return { name: rest.join(':'), in: loc, sample: null }; }) }));

  emitOut.totals = { pages_visited: pagesVisited.length, forms_processed: processedForms, created: actions.length,
    dry_run_intents: intents.length, data_endpoints: discovered.length, param_endpoints: paramInv.length,
    session_writes: sessionWrites.length, findings: findings.length, blocked: blocked.length };
  emitOut.discovered_endpoints = discovered;
  emitOut.param_inventory = paramInv;
  emitOut.session_writes = sessionWrites;   // G6 — all in-scope writes (seeds), incl. intermediate sub-entity writes
  emitOut.findings = findings;              // G6 — 4xx/5xx writes (endpoint contract + server bug)
  emitOut.blocked = blocked;                // G5 — submits that produced no real create + the read reason
  emitOut.forms_to_drive = formsToDrive;    // HANDOFF — complex forms for the AI tier to drive (see ARCHITECTURE)
  // A deny is never silent: the operator sees WHAT the --exclude list kept the crawler away from, so an empty
  // result on an excluded area reads as "not tested (out of scope)", never as "tested, nothing there".
  emitOut.out_of_scope_blocked = { count: excluded.hits, samples: excluded.samples };
  emitOut.totals.out_of_scope_blocked = excluded.hits;
  emitOut.totals.forms_to_drive = formsToDrive.length;
  // discovery output is written even in dry-run (read-only) — it feeds /pentest:sql etc.
  if (a.out && paramInv.length) { await mkdir(a.out, { recursive: true }); await writeFile(path.join(a.out, 'widget-param-inventory.json'), JSON.stringify(paramInv, null, 2)); }

  async function processFormsOnPage(pg) {
    const n = await pg.locator('form').count().catch(() => 0);
    const useN = n > 0 ? n : 1;                          // formless SPA page → treat the page as one pseudo-form
    // --max-forms bounds SUBMISSIONS, not page visits: only count a form that did REAL work (had fields / a
    // dialog to complete) — so a formless dashboard never burns the budget before we reach a real create form.
    for (let fi = 0; fi < useN && processedForms < maxForms; fi++) { if (await processForm(pg, n > 0 ? fi : null)) processedForms++; }
  }
  emitOut.actions = actions;
  if (!armed) emitOut.intents = intents;
  if (a.out) {
    const wrote = [];
    if (armed && actions.length) wrote.push(['crud-exercise.json', actions]);
    if (sessionWrites.length) wrote.push(['session-writes.json', sessionWrites]);   // seeds for BOLA/injection
    if (findings.length) wrote.push(['findings.json', findings]);                    // 4xx/5xx endpoint bugs
    if (formsToDrive.length) wrote.push(['forms-to-drive.json', formsToDrive]);       // HANDOFF to the AI tier
    if (wrote.length) { await mkdir(a.out, { recursive: true }); for (const [f, d] of wrote) await writeFile(path.join(a.out, f), JSON.stringify(d, null, 2)); }
  }

  // introspect fillable fields WITHIN a scope element (the open dialog or the <form>) — null = whole document.
  async function introspectFields(pg, scopeEl) {
    return await pg.evaluate(new Function('formEl', `return (${INTROSPECT})(formEl);`), scopeEl).catch(() => []);
  }
  async function fillFields(scopeLoc, fields, salt, record) {
    let n = 0;
    for (const f of fields) {
      // locate by the data-cx-field tag INTROSPECT stamped (works for nameless fields); fall back to name/id.
      const loc = f.cx != null
        ? scopeLoc.locator(`[data-cx-field="${f.cx}"]`).first()
        : scopeLoc.locator(`[name="${cssAttr(f.name)}"], [id="${cssAttr(f.name)}"]`).first();
      const val = synthValue(f, ++n, salt);
      try {
        if (f.tag === 'select') { if (f.options && f.options.length) await loc.selectOption(f.options[Math.min(salt, f.options.length - 1)] || f.options[0], { timeout: 1500 }); }
        else if (f.type === 'checkbox' || f.type === 'radio') { if (f.required) await loc.check({ timeout: 1500 }); }
        else if (f.ce) { // contenteditable / role=textbox — not a real <input>: set text + fire input so the app reacts
          await loc.click({ timeout: 1500 }).catch(() => {});
          await loc.evaluate((el, v) => { el.textContent = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, String(val)).catch(() => {});
        }
        else { await loc.fill(String(val), { timeout: 1500 }); }
        if (record) record.push({ name: f.name, type: f.type, required: !!f.required });
      } catch { /* not interactable — skip */ }
    }
  }
  // Drive CUSTOM dropdowns/typeaheads as part of completing the form: open each, and select a VALID option
  // (type a probe in a typeahead → pick the first result; else pick the first option). This is what satisfies
  // required custom selects so the primary/submit button enables. Complements native-<select> filling.
  async function fillWidgets(scopeLoc, pg) {
    const SEL = PICKER_SEL;
    const cn = Math.min(await scopeLoc.locator(SEL).count().catch(() => 0), MAX_WIDGETS);
    for (let i = 0; i < cn; i++) {
      const c = scopeLoc.locator(SEL).nth(i);
      try {
        if (!(await c.isVisible().catch(() => false))) continue;
        await c.click({ timeout: 1500 }); await settle(pg);
        const search = pg.locator('.cdk-overlay-container input, [role="listbox"] input, [role="dialog"] input[placeholder*="search" i], input[placeholder*="find" i]').first();
        if ((await search.count().catch(() => 0)) && (await search.isVisible().catch(() => false))) {
          await search.pressSequentially('a', { timeout: 1500 }).catch(() => {}); await settle(pg);
        }
        // G3 — validation-aware selection: the FIRST option can be poisoned (e.g. a party with an invalid tax id
        // → a blocking toast and an inert submit). After each pick, re-read state; if a blocking error shows, drop
        // it, reopen the widget, and try the NEXT option instead of stopping at the first.
        const OPT = '[role="option"], .mat-option, [role="listbox"] li';
        const on = Math.min(await pg.locator(OPT).count().catch(() => 0), Math.max(MAX_OPTIONS, 1));
        let picked = false;
        for (let j = 0; j < on && !picked; j++) {
          const opt = pg.locator(OPT).nth(j);
          if (!(await opt.isVisible().catch(() => false))) continue;
          await opt.click({ timeout: 1500 }).catch(() => {});
          await settle(pg);
          if (await hasBlockingError(pg, scopeLoc)) { await c.click({ timeout: 1000 }).catch(() => {}); await settle(pg); continue; }
          picked = true;
        }
        if (!picked) await pg.keyboard.press('Escape').catch(() => {});
      } catch { /* widget not interactable — skip */ }
    }
  }

  async function processForm(pg, formIndex) {
    // For a page-level (pseudo-form) create, the form usually lives in a dialog opened by a +add BUTTON — open it
    // first so the fields are in the DOM. (openAddDialogs self-guards: it does nothing when a form-region is
    // already visible, so it never fires a formless region's own submit prematurely.)
    if (armed && formIndex == null) await openAddDialogs(pg);
    // SCOPE all interaction to the open create dialog when there is one — this is the safety-critical part:
    // filling/clicking PAGE-WIDE lets pickSubmit grab a nav/menu button and fillWidgets open filter dropdowns,
    // which derails the crawl on a real app. A <form> scopes itself; otherwise prefer the visible dialog.
    let scopeLoc, isDialog = false;
    if (formIndex != null) scopeLoc = pg.locator('form').nth(formIndex);
    else if (armed && (await pg.locator(DLG).count().catch(() => 0))) { scopeLoc = pg.locator(DLG).last(); isDialog = true; }
    else scopeLoc = pg;
    const scopeEl = async () => (scopeLoc === pg ? null : await scopeLoc.elementHandle().catch(() => null));
    const fields0 = await introspectFields(pg, await scopeEl());
    if (!fields0.length && !(armed && (await scopeLoc.locator(PICKER_SEL).count().catch(() => 0)))) return false;
    const resource = guessResource(pg.url(), fields0);
    const filledFields = [];

    if (!armed) {   // dry-run: preview native fields, submit NOTHING (widget discovery runs read-only elsewhere)
      await fillFields(scopeLoc, fields0, 0, filledFields);
      intents.push({ resource, ui_route: routeOf(pg.url()), owner: a.owner || null, marker: `${MARKER}-${resource}-1`,
        fields: filledFields, planned_values: fields0.map((f, i) => ({ name: f.name, value: synthValue(f, i + 1, 0) })) });
      return true;
    }

    // ARMED — complete the form like a user testing it, WITHIN the dialog scope: fill native fields + drive
    // custom widgets, COMMIT nested sub-entities (each with its own Save), ADVANCE through multi-step, then
    // SUBMIT via the primary action — label-AGNOSTIC but only clicked page-wide where it is safe. Capture the write.
    // HARD OUT-OF-SCOPE GATE — last line of defence before anything is written. The frontier and the route
    // harvester already filter, but an SPA transition, a redirect, or an operator seed can leave us standing on
    // an excluded page; commitSubEntities() below clicks real Saves, so the check must happen BEFORE it, not at
    // the terminal submit. Refuse the whole armed pass for this form rather than write off-target.
    try {
      const here = new URL(pg.url());
      if (!inScope(here.hostname.toLowerCase(), here.pathname)) {
        blocked.push({ resource, ui_route: routeOf(pg.url()), reason: 'out-of-scope (--exclude) — no write attempted' });
        return false;
      }
    } catch { return false; }

    let clickedSubmit = false;
    for (let step = 0; step < MAX_STEPS; step++) {
      const fields = step === 0 ? fields0 : await introspectFields(pg, await scopeEl());   // re-introspect each step
      await fillFields(scopeLoc, fields, step, step === 0 ? filledFields : null);
      await fillWidgets(scopeLoc, pg);   // G2 — drives a picker/typeahead; selecting a valid option may REVEAL more
      let submitLoc = await pickSubmit(scopeLoc, isDialog);
      // G4 — a parent create form can hold sub-entities that each persist via their OWN Save (e.g. a related-party
      // sub-form → its POST, each line-item row → its PUT). Commit them in DOM order BEFORE the parent's terminal
      // action. F3 — run this ONCE per form (step 0 only); re-running it on each validation-retry step (or on a
      // terminal ≥400) re-clicked the sub-Saves → many objects for one form. Enforces the "1 object/form" cap.
      if (step === 0) await commitSubEntities(scopeLoc, pg, submitLoc);
      // G2 — the parent action is often DISABLED until the sub-entities commit (a "Create Invoice" lights
      // up only after the buyer + a line are saved). Re-pick after committing so a now-enabled submit is found.
      if (!submitLoc) submitLoc = await pickSubmit(scopeLoc, isDialog);
      if (!submitLoc) break;
      clickedSubmit = true;
      // COLLECT every mutating in-scope write this submit fires — a submit typically triggers several (telemetry,
      // a preview, THEN the real create). Judging only the FIRST would mis-classify. Gather them all, then choose
      // the best create candidate. (F1 — the persistence oracle is applied to the SET, not the first write.)
      const raw = [];
      const onResp = (resp) => {
        try {
          const rq = resp.request(); if (!/^(POST|PUT|PATCH)$/i.test(rq.method())) return;
          const uu = new URL(rq.url()); if (!inScope(uu.hostname.toLowerCase(), uu.pathname)) return;
          raw.push({ resp, rq, u: uu, status: resp.status(), loc: resp.headers()['location'] || null });
        } catch { /* ignore */ }
      };
      pg.on('response', onResp);
      await Promise.all([
        pg.waitForResponse((r) => { try { const rq = r.request(); const uu = new URL(rq.url()); return /^(POST|PUT|PATCH)$/i.test(rq.method()) && inScope(uu.hostname.toLowerCase(), uu.pathname); } catch { return false; } }, { timeout: Math.min(timeout, 5000) }).catch(() => null),
        submitLoc.click({ timeout: 3000 }).catch(() => {}),
      ]);
      await settle(pg);
      pg.off('response', onResp);

      // resolve each write's persistence signals (body id / Location), then classify.
      const collected = [];
      for (const c of raw) {
        const reqBodyStr = (() => { try { return c.rq.postData() || ''; } catch { return ''; } })();
        let respJson = null; try { respJson = JSON.parse(await c.resp.text()); } catch { /* non-JSON */ }
        const idInfo = findId(respJson, collectEchoValues(reqBodyStr), '') || idFromLocation(c.loc);
        // F1 — a POSITIVE persistence signal (201 / Location / non-echoed response id / a URL change to a detail
        // route) makes it a create and OVERRIDES the non-persistent token; the token (checked on the TERMINAL
        // segment only) is advisory — it just deprioritizes an ambiguous write when a cleaner create exists.
        // bug#1 — restore the URL→detail signal: a SPA create whose ONLY proof is navigating to `/…/{id}` must be
        // a create, not `blocked`.
        const urlId = idFromUrlChange(pg.url(), c.u.pathname);
        collected.push({ ...c, reqBodyStr, idInfo: idInfo || urlId,
          denyTerminal: isNonPersistTerminal(c.u.pathname),
          positive: c.status >= 200 && c.status < 300 && (c.status === 201 || !!c.loc || !!idInfo || !!urlId) });
      }
      const positives = collected.filter((c) => c.positive);
      const createCand = positives.find((c) => !c.denyTerminal) || positives[0];   // positive overrides token; prefer clean path
      if (createCand) {
        const { rq, u, status, loc, idInfo, reqBodyStr } = createCand;
        let body; try { body = reqBodyStr ? JSON.parse(reqBodyStr) : undefined; } catch { body = reqBodyStr || undefined; }
        const created = idInfo || {};
        if (loc && !created.location) created.location = loc;
        if (!created.id) { const uid = idFromUrlChange(pg.url(), u.pathname); if (uid) Object.assign(created, uid); }   // URL→detail id, if the body gave none
        actions.push({ resource, action: 'create', owner: a.owner || null, identity: a.owner || null, marker: `${MARKER}-${resource}-1`, ui_route: routeOf(pg.url()),
          request: { method: rq.method(), host: u.hostname, path: u.pathname, content_type: (rq.headers()['content-type'] || '').split(';')[0] || null, body },
          created: Object.keys(created).length ? created : undefined, response_status: status, fields: filledFields, steps: step + 1 });
        return true;
      }
      // no create: a 4xx is a validation error → retry with fresh values; a 5xx is a server error → stop (the
      // session listener logged it as a finding). Otherwise (only weak 200s / no write) keep completing if controls remain.
      if (collected.some((c) => c.status >= 400 && c.status < 500) && step < MAX_STEPS - 1) continue;
      if (collected.some((c) => c.status >= 500)) break;
      if (!((await scopeLoc.locator('input, select, textarea, ' + PICKER_SEL).count().catch(() => 0)) > 0)) break;
    }
    // G5 — state-delta oracle: we clicked a submit but NO 2xx create landed (a client no-op, an Rp-0/empty total,
    // or a validation block). An enabled button and a 200 are NOT proof — record an intent_blocked with the read
    // toast/reason instead of a phantom `created`, so the missed create surfaces as a signal, never a false positive.
    if (clickedSubmit) blocked.push({ resource, ui_route: routeOf(pg.url()), owner: a.owner || null,
      reason: (await readToast(pg)) || 'submit fired no in-scope 2xx write (client no-op / validation block)' });
    return true;   // did real work (filled a form) even if no write fired
  }

  // G4 — commit nested sub-entities before the parent's terminal action. A sub-entity Save is a create-hint
  // button (NOT the terminal submit, NOT destructive/cancel) in a genuine REPEATED sub-container. F3 — RE-QUERY
  // the handles after EVERY commit: a Vue/React re-render detaches the old elementHandles, and the next line may
  // only appear after the previous one commits (sequential revelation). Dedup by a stable signature so a Save is
  // never clicked twice (no amplification). Bounded passes.
  function subSaveSig(el) {   // stable-ish identity of a sub-save: its repeated container sibling-index + text
    const RE = /\b(card|row|line|item|entry)\b/;
    let c = el;
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      if (n.tagName === 'LI' || n.tagName === 'TR' || RE.test((n.className || '').toLowerCase())) { c = n; break; }
    }
    const p = c.parentElement; const idx = p ? Array.prototype.indexOf.call(p.children, c) : -1;
    return (c.className || c.tagName) + '#' + idx + '|' + (el.textContent || '').trim().slice(0, 24);
  }
  function subSaveOkContainer(el, submitEl) {
    const RE = /\b(card|row|line|item|entry)\b/;
    const repTok = (n) => ((n.getAttribute && n.getAttribute('class')) || '').toLowerCase().split(/\s+/).find((c) => RE.test(c)) || null;
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const liTr = n.tagName === 'LI' || n.tagName === 'TR';
      const tok = repTok(n);
      if (!liTr && !tok) continue;
      if (submitEl && n.contains(submitEl)) return false;
      const sibs = Array.from((n.parentElement && n.parentElement.children) || []).filter((s) => s !== n);
      return liTr ? sibs.some((s) => s.tagName === n.tagName)
                  : sibs.some((s) => ((s.getAttribute('class') || '').toLowerCase().split(/\s+/).includes(tok)));
    }
    return false;
  }
  async function commitSubEntities(scopeLoc, pg, submitLoc) {
    const submitHandle = submitLoc ? await submitLoc.elementHandle().catch(() => null) : null;
    const committed = new Set();
    for (let pass = 0; pass < 12; pass++) {
      let handles = [];
      try { handles = await scopeLoc.locator('button, [role="button"], input[type="button"]').elementHandles(); } catch { break; }
      let did = false;
      for (const h of handles) {
        try {
          if (!(await h.isVisible().catch(() => false)) || !(await h.isEnabled().catch(() => true))) continue;
          const label = (((await h.getAttribute('value').catch(() => '')) || '') + ' ' +
                         ((await h.textContent().catch(() => '')) || '') + ' ' +
                         ((await h.getAttribute('aria-label').catch(() => '')) || '')).trim();
          if (!CREATE_HINT.test(label) || CANCEL_BACK.test(label) || DESTRUCTIVE.test(label)) continue;
          if (submitHandle && (await h.evaluate((el, s) => el === s, submitHandle).catch(() => false))) continue;
          const sig = await h.evaluate(subSaveSig).catch(() => null);
          if (sig && committed.has(sig)) continue;
          if (!(await h.evaluate(subSaveOkContainer, submitHandle).catch(() => false))) continue;
          if (sig) committed.add(sig);
          await Promise.all([
            pg.waitForResponse(writePredicate, { timeout: Math.min(timeout, 4000) }).catch(() => null),
            h.click({ timeout: 2500 }).catch(() => {}),
          ]);
          await settle(pg);
          did = true;
          break;
        } catch { /* sub-save not clickable — skip */ }
      }
      if (!did) break;
    }
  }

  async function labelOf(loc) {
    return (((await loc.getAttribute('value').catch(() => '')) || '') + ' ' +
            ((await loc.textContent().catch(() => '')) || '') + ' ' +
            ((await loc.getAttribute('aria-label').catch(() => '')) || '')).trim();
  }
  async function pickSubmit(scopeLoc, allowLast) {
    // 1) canonical submit — any type=submit that is not a cancel/destructive control.
    const explicit = scopeLoc.locator('button[type="submit"], input[type="submit"]').first();
    if (await explicit.count().catch(() => 0)) {
      const label = await labelOf(explicit);
      if (!CANCEL_BACK.test(label) && !DESTRUCTIVE.test(label)) return explicit;
    }
    // 2) among the scope's buttons (excluding cancel/back/close/destructive), collect the primary-styled one,
    //    the first create-hinted one, and the last one.
    const buttons = scopeLoc.locator('button, [role="button"], input[type="button"]');
    const n = await buttons.count().catch(() => 0);
    let primary = null, hinted = null, last = null;
    for (let i = 0; i < n; i++) {
      const b = buttons.nth(i);
      if (!(await b.isVisible().catch(() => false)) || !(await b.isEnabled().catch(() => true))) continue;
      const label = await labelOf(b);
      if (CANCEL_BACK.test(label) || DESTRUCTIVE.test(label)) continue;
      // G2 — never pick a SUB-ENTITY Save (a create-hint button inside a repeated row/card) as the parent submit:
      // when the parent action is disabled until the rows commit, this used to grab a line's Save instead.
      if (await b.evaluate(subSaveOkContainer, null).catch(() => false)) continue;
      last = b;
      const cls = (await b.getAttribute('class').catch(() => '')) || '';
      if (!primary && /(primary|btn-primary|is-primary|_primary|confirm|submit)/i.test(cls)) primary = b;
      if (!hinted && CREATE_HINT.test(label)) hinted = b;
    }
    // A primary-styled or create-hinted button is safe anywhere. The bare "last non-cancel button" is only safe
    // INSIDE A DIALOG (a footer holds just form actions); page-wide it grabs nav/menu buttons and derails — so
    // it is gated on `allowLast` (true only when scoped to a dialog). Label-agnostic where it is safe to be.
    return primary || hinted || (allowLast ? last : null);
  }

  // ── READ-ONLY widget/typeahead enumeration (param discovery — never submits a form) ──────────────────────
  async function enumerateWidgets(pg) {
    if (!a.widgets) return;
    await openAddDialogs(pg);   // reveal add-dialogs (widgets live inside them), via buttons not just links
    const SEL = PICKER_SEL + ', [class*="select"][class*="trigger"]';
    const wn = Math.min(await pg.locator(SEL).count().catch(() => 0), MAX_WIDGETS);
    for (let i = 0; i < wn; i++) {
      const t = pg.locator(SEL).nth(i);
      try {
        if (!(await t.isVisible().catch(() => false))) continue;
        await t.click({ timeout: 1500 });
        await settle(pg);
        // 1) typeahead: a search input revealed in the open OVERLAY → type a probe (captures ?keyword=…). Scope to
        // the overlay/dialog/listbox/menu (NOT page-wide): an unscoped `input[placeholder*=search]` let `.first()`
        // grab a LIST page's own search box (bug#3) and type into the wrong field, firing nothing.
        const search = pg.locator('.cdk-overlay-container input, .cdk-overlay-pane input, [role="listbox"] input, [role="dialog"] input, .v-menu__content input, .v-overlay__content input').first();
        if ((await search.count().catch(() => 0)) && (await search.isVisible().catch(() => false))) {
          await search.pressSequentially('a', { timeout: 1500 }).catch(() => {});
          await settle(pg);
        }
        // 2) options: selecting one may echo its value into a query param (captures ?name=<option>…)
        const OPT = '[role="option"], [role="listbox"] li, .mat-option, [role="listbox"] [role="option"]';
        const on = Math.min(await pg.locator(OPT).count().catch(() => 0), MAX_OPTIONS);
        for (let j = 0; j < on; j++) {
          try {
            const opt = pg.locator(OPT).nth(j);
            if (!(await opt.isVisible().catch(() => false))) continue;
            await opt.click({ timeout: 1500 });
            await settle(pg);
            await t.click({ timeout: 1000 }).catch(() => {});   // reopen for the next option
            await settle(pg);
          } catch { /* option not clickable */ }
        }
        await pg.keyboard.press('Escape').catch(() => {});   // close overlay so the next widget is reachable
      } catch { /* widget not interactable — skip */ }
    }
  }
  async function openAddDialogs(pg) {
    // If a CREATE form-region is already visible — NON-search fillable fields, or a custom widget (combobox/
    // mat-select) — do NOT click create-hint buttons: one of them is likely the region's OWN submit, and clicking
    // it here would fire a stray/duplicate write. bug#3 — a lone *search* box on a LIST page must NOT count as a
    // form-region (else the "+Add" dialog is never opened and its inner widgets/params go undiscovered), so
    // search-like fields are excluded from the guard.
    const SEARCHISH = /search|find|filter|query|lookup|recherche|cari|cerca|buscar/i;
    const visibleFields = await introspectFields(pg, null);
    if (visibleFields.some((f) => !(SEARCHISH.test(f.name || '') || f.type === 'search'))) return;
    if (await pg.locator(PICKER_SEL_VIS).count().catch(() => 0)) return;
    const btns = pg.locator('button, [role="button"]');
    const n = Math.min(await btns.count().catch(() => 0), 15);
    let opened = 0;
    for (let i = 0; i < n && opened < 2; i++) {
      const b = btns.nth(i);
      const label = ((await b.textContent().catch(() => '')) || (await b.getAttribute('aria-label').catch(() => '')) || '').trim();
      if (!label || !CREATE_HINT.test(label) || DESTRUCTIVE.test(label)) continue;
      // NEVER click a button inside a <form> — that is a form control (likely the submit), not a dialog
      // opener. This keeps the widget pass READ-ONLY (a form's own submit is only ever clicked by processForm).
      if (await b.evaluate((el) => !!el.closest('form')).catch(() => true)) continue;
      try {
        await b.click({ timeout: 1500 });
        await settle(pg);
        if (await pg.locator('[role="dialog"], .cdk-overlay-container, .modal, mat-dialog-container').count().catch(() => 0)) opened++;
      } catch { /* button not clickable */ }
    }
  }
} catch (e) {
  emitOut.ok = false; emitOut.error = String((e && e.message) || e);
} finally {
  // CLOSE THE CONTEXT before the browser — recordHar flushes the HAR on ctx.close(), NOT browser.close().
  if (ctx) await ctx.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
}
emit(emitOut);
process.exit(emitOut.ok ? 0 : 1);

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────
async function settle(page) {
  // bounded-adaptive: return as soon as the network is quiet, but CAP the wait — networkidle can NEVER fire on a
  // chatty SPA (SSE / long-poll / heartbeat), and a flat ~3.4s × ~80 widget settles/page made the crawl look
  // stuck. The short tail still lets a debounced typeahead XHR (~200-500ms) dispatch (the listener records at
  // dispatch, so we don't need to wait for the response).
  await page.waitForLoadState('networkidle', { timeout: 800 }).catch(() => {});
  await page.waitForTimeout(250);
}
async function mountSettle(page) {
  // G1 — SPA/micro-frontend mount is slower than a plain DOM load: the shell bootstraps, then the micro-app
  // fetches and renders its route. Wait for the network to quiet with a LARGER cap than the per-interaction
  // settle (a stub mounts instantly so tests stay fast; a real SPA gets the time it needs), then a paint delay.
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(400);
}
// G3/G5 — read a visible toast/snackbar/alert (the app's own rejection message). Returns its text or null.
async function readToast(page) {
  try {
    return await page.evaluate(() => {
      const SEL = '[role="alert"], .v-snackbar__content, .v-snackbar--active, .snackbar, .toast, [class*="snackbar"], [class*="toast"], [class*="notification"]';
      for (const el of document.querySelectorAll(SEL)) {
        const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
        if (r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none') {
          const t = (el.textContent || '').trim(); if (t) return t.slice(0, 200);
        }
      }
      return null;
    });
  } catch { return null; }
}
// F7/G3 — a blocking error can surface as a toast OR as INLINE validation (aria-invalid, a Vuetify/Material
// error alert, an error helper-text). (BLOCKING_RE/NEG_VALID_RE/isBlockingText live near the top — TDZ safety.)
async function hasBlockingError(page, scopeLoc) {
  const t = await readToast(page);                    // 1) a blocking toast/snackbar/alert
  if (isBlockingText(t)) return true;
  const scope = scopeLoc || page;                     // 2) inline validation within the form scope
  try {
    if (await scope.locator('[aria-invalid="true"]:visible').count().catch(() => 0)) return true;
    const alerts = scope.locator('.v-alert:visible, .v-messages__message:visible, .mat-error:visible, [class*="error"]:visible, [class*="invalid-feedback"]:visible');
    const n = Math.min(await alerts.count().catch(() => 0), 6);
    for (let i = 0; i < n; i++) { const tx = ((await alerts.nth(i).textContent().catch(() => '')) || '').trim(); if (isBlockingText(tx)) return true; }
  } catch { /* ignore */ }
  return false;
}
// G1 — collect ALL navigable in-scope routes from the current page. Harvests BEYOND `a[href]`: SPA/micro-frontend
// nav lives in framework attributes (routerlink, data-href/route/to) and clickable launcher tiles (role=link),
// which an anchor-only BFS never sees — that is why the old crawl stalled at 2 pages. Returns {href (absolute), text}.
async function collectRoutes(page) {
  const baseUrl = page.url();
  let links = [];
  try {
    links = await page.evaluate(() => {
      const ATTRS = ['href', 'data-href', 'data-route', 'data-to', 'to', 'routerlink', 'routerLink'];
      const seen = new Set(); const out = [];
      const push = (href, text) => { if (href && !seen.has(href)) { seen.add(href); out.push({ href, text: (text || '').trim().slice(0, 60) }); } };
      for (const el of document.querySelectorAll('a[href]')) push(el.getAttribute('href'), el.textContent);
      for (const el of document.querySelectorAll('[data-href],[data-route],[data-to],[to],[routerlink],[routerLink],[role="link"]')) {
        for (const attr of ATTRS) { const v = el.getAttribute && el.getAttribute(attr); if (v) { push(v, el.textContent); break; } }
      }
      return out;
    });
  } catch { return []; }
  const out = [];
  for (const l of links) {
    if (!l.href || l.href === '#' || /^(javascript:|mailto:|tel:|data:)/i.test(l.href) || l.href.startsWith('//')) continue;
    if (AVOID_LINK.test(l.href) || AVOID_LINK.test(l.text)) continue;   // never a logout/delete route
    let abs; try { abs = new URL(l.href, baseUrl); } catch { continue; }
    if (!inScope(abs.hostname.toLowerCase(), abs.pathname)) continue;   // scope + exclusions on the RESOLVED URL
    out.push({ href: abs.href, text: l.text });
  }
  return out;
}
async function navigateTo(page, href) {
  // prefer CLICKING the real link (keeps SPA state/auth); fall back to goto for plain MPAs
  try { await page.click(`a[href="${cssAttr(href)}"]`, { timeout: 2500 }); return true; } catch {}
  try { await page.goto(new URL(href, page.url()).toString(), { waitUntil: 'domcontentloaded', timeout }); return true; } catch { return false; }
}
// route identity = pathname + a ROUTE hash (#/… or #!/…) so a hash-router SPA's routes stay distinct; a bare
// anchor (#top, #section) is NOT part of the key (else same-page anchors would each burn a nav-view budget).
function routeKey(u) { try { const x = new URL(u); return x.pathname + (/^#!?\//.test(x.hash) ? x.hash : ''); } catch { return u; } }
function idFromUrlChange(urlAfter, createPath) {
  try {
    const after = new URL(urlAfter).pathname.replace(/\/$/, '');
    const seg = after.split('/').pop();
    if (seg && seg !== createPath.replace(/\/$/, '').split('/').pop() && /[0-9a-f-]{2,}/i.test(seg)) return { id: seg, id_field: 'url' };
  } catch {}
  return null;
}
function guessResource(url, fields) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean).filter((p) => !/^(new|add|create|edit|nouveau|ajouter)$/i.test(p) && !/[0-9]/.test(p));
    if (parts.length) return parts[parts.length - 1].replace(/s$/, '');
  } catch {}
  return (fields[0] && fields[0].name) ? fields[0].name.split(/[.[]/)[0] : 'object';
}
function routeOf(url) { try { return new URL(url).pathname; } catch { return url; } }
