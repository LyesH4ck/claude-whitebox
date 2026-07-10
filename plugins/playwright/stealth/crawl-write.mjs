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
//     [--scope host.com] [--proxy http://127.0.0.1:8080] [--max-forms 6] [--out outputs/ENG/crud]
//     [--viewport 1366x900] [--timeout 30000] [--no-headless] [--insecure]

import { parseArgs } from 'node:util';
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const emit = (o) => process.stdout.write(JSON.stringify(o, null, 2) + '\n');

try { await access(path.join(here, 'node_modules', 'playwright-extra')); }
catch { emit({ ok: false, error: 'deps_missing', hint: `run once: (cd ${here} && npm install)` }); process.exit(2); }

let a;
try {
  ({ values: a } = parseArgs({ allowNegative: true, options: {
    url:      { type: 'string' },
    marker:   { type: 'string' },
    scope:    { type: 'string' },
    state:    { type: 'string' },
    cookie:   { type: 'string' },
    header:   { type: 'string', multiple: true },
    proxy:    { type: 'string' },
    out:      { type: 'string' },
    viewport: { type: 'string' },
    timeout:  { type: 'string', default: '30000' },
    'max-forms': { type: 'string', default: '6' },
    'max-views': { type: 'string', default: '15' },   // pages to visit while following links looking for forms
    widgets:  { type: 'boolean', default: true },     // read-only: exercise custom dropdowns/typeaheads for param discovery
    'max-widgets': { type: 'string', default: '10' },
    'max-options': { type: 'string', default: '3' },  // option values to select per dropdown (each may echo a param)
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
const inScope = (host) => SCOPE.some((s) => host === s || host.endsWith('.' + s));
const timeout = +a.timeout;
const viewport = a.viewport ? { width: +a.viewport.split('x')[0], height: +a.viewport.split('x')[1] } : undefined;

// NEVER click a submit that looks destructive.
const DESTRUCTIVE = /\b(delete|remove|supprim|effac|drop|purge|reset|clear|cancel|annul|bulk|deactivate|revoke)\b/i;
const CREATE_HINT = /\b(save|submit|create|add|new|nouveau|créer|creer|ajouter|enregistrer|valider|confirm)\b/i;
const cssAttr = (s) => String(s).replace(/["\\]/g, '\\$&');
// Never follow a link that would end the session or mutate state by navigation alone.
const AVOID_LINK = /\b(logout|log-out|signout|sign-out|deconnex|déconnex|disconnect|delete|remove|supprim|drop|revoke)\b/i;
const CREATEISH_LINK = /(create|\/new\b|\/add\b|nouveau|ajouter|créer|creer|register|inscription)/i;

// ── field-compliant, marker-tagged value synthesis ──────────────────────────────────────────────────────
const today = () => new Date().toISOString().slice(0, 10);
function synthValue(f, n, salt = 0) {
  const name = (f.name || '').toLowerCase();
  const t = (f.type || 'text').toLowerCase();
  const tag = f.tag;
  const clip = (s) => (f.maxlength && f.maxlength > 0 ? s.slice(0, f.maxlength) : s);
  const num = () => {
    let v = Number.isFinite(f.min) ? f.min : 1;
    if (Number.isFinite(f.max) && v > f.max) v = f.max;
    return String(v + salt >= (Number.isFinite(f.max) ? f.max : Infinity) ? v : v);
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
// recursive id finder for the create RESPONSE body
function findId(obj, prefix = '') {
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (/^(id|_id|uuid|pk|guid|slug)$/i.test(k) && (typeof v === 'string' || typeof v === 'number') && String(v)) return { id: String(v), id_field: p };
      if (v && typeof v === 'object') { const r = findId(v, p); if (r) return r; }
    }
  }
  return null;
}
function idFromLocation(loc) { if (!loc) return null; const seg = String(loc).split('?')[0].replace(/\/$/, '').split('/').pop(); return seg && /[0-9a-f-]{2,}/i.test(seg) ? { id: seg, id_field: 'Location' } : null; }

// ── DOM introspection: enumerate a form's fillable named fields (runs in the page) ───────────────────────
const INTROSPECT = `(formEl) => {
  const F = formEl || document;
  const out = [];
  for (const el of F.querySelectorAll('input, select, textarea')) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || (tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : 'text')).toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(type)) continue; // skip: tokens kept as-is, files unsafe
    const name = el.getAttribute('name') || el.getAttribute('id') || '';
    if (!name) continue;
    const style = el.offsetParent === null && type !== 'radio' && type !== 'checkbox';
    if (style) continue; // not visible
    const opts = tag === 'select' ? Array.from(el.options).map((o) => o.value).filter((v) => v !== '') : null;
    const min = el.getAttribute('min'), max = el.getAttribute('max'), ml = el.getAttribute('maxlength');
    out.push({ name, tag, type, required: el.hasAttribute('required'),
      pattern: el.getAttribute('pattern') || null, options: opts,
      min: min != null ? Number(min) : null, max: max != null ? Number(max) : null,
      maxlength: ml != null ? Number(ml) : null });
  }
  return out;
}`;

const { launch, newStealthContext } = await import('./browser.mjs');
const emitOut = { ok: true, armed, marker: armed ? MARKER : null, mode: armed ? 'submit' : 'dry-run', start_url: a.url, scope: SCOPE };
const actions = [];
const intents = [];
let browser;
try {
  browser = await launch({ headless: a.headless, proxy: a.proxy || null });
  const extraHeaders = {};
  if (a.cookie) extraHeaders.Cookie = a.cookie;
  for (const h of (a.header || [])) { const i = h.indexOf(':'); if (i > 0) extraHeaders[h.slice(0, i).trim()] = h.slice(i + 1).trim(); }
  const ctx = await newStealthContext(browser, { insecure: a.insecure, viewport, storageState: a.state || undefined, extraHeaders: Object.keys(extraHeaders).length ? extraHeaders : undefined });

  // Read-only data-request capture (for widget/typeahead param discovery): record in-scope XHR/fetch with their
  // query params, deduped. A dropdown search (?keyword=…) or an option selection (?name=…) becomes an
  // inventoried, testable parameter here — the surface a native-<select> scrape and a path-crawl both miss.
  const captured = [];
  const seenReq = new Set();
  ctx.on('request', (req) => {
    try {
      if (!['xhr', 'fetch'].includes(req.resourceType())) return;
      const u = new URL(req.url());
      if (!inScope(u.hostname.toLowerCase())) return;
      const key = req.method() + ' ' + u.host + u.pathname + u.search;
      if (seenReq.has(key)) return; seenReq.add(key);
      captured.push({ method: req.method(), host: u.hostname, path: u.pathname, query: u.search });
    } catch { /* ignore */ }
  });

  const page = await ctx.newPage();
  await page.goto(a.url, { waitUntil: 'domcontentloaded', timeout }).catch(() => {});
  await settle(page);

  // Breadth-first navigation: follow the links we find (create-labelled ones FIRST, then any in-scope
  // internal link) and discover/exercise forms on EVERY page we land on — not just the start page. Bounded
  // by --max-views (pages) and --max-forms (forms). Never follows a logout/delete link (would kill the session).
  const maxForms = +a['max-forms'];
  const maxViews = +a['max-views'];
  const MAX_WIDGETS = +a['max-widgets'];
  const MAX_OPTIONS = +a['max-options'];
  let processedForms = 0;
  const visited = new Set();
  const pagesVisited = [];

  const visitAndExercise = async () => {
    const key = routeKey(page.url());
    if (visited.has(key)) return;
    visited.add(key);
    pagesVisited.push(page.url());
    await processFormsOnPage(page);
    await enumerateWidgets(page);   // read-only: custom dropdowns / typeaheads → option-driven param discovery
  };

  await visitAndExercise();                              // start page
  for (let i = 0; i < maxViews && processedForms < maxForms; i++) {
    const target = await nextNavTarget(page, visited);
    if (!target) break;
    try {
      if (!(await navigateTo(page, target))) continue;
      await settle(page);
      await visitAndExercise();
    } catch { /* stale/blocked link — keep going */ }
  }

  // ── widget/typeahead discovery → param inventory (query params on the captured data endpoints) ──
  const epMap = new Map();
  for (const r of captured) {
    const k = `${r.host} ${r.method} ${r.path}`;
    if (!epMap.has(k)) epMap.set(k, { host: r.host, method: r.method, path: r.path, params: new Set() });
    if (r.query) for (const key of new URLSearchParams(r.query).keys()) epMap.get(k).params.add(key);
  }
  const discovered = [...epMap.values()].map((e) => ({ host: e.host, method: e.method, path: e.path, params: [...e.params] }));
  const paramInv = discovered.filter((e) => e.params.length)
    .map((e) => ({ endpoint: e.path, method: e.method, host: e.host, params: e.params.map((name) => ({ name, in: 'query', sample: null })) }));

  emitOut.totals = { pages_visited: pagesVisited.length, forms_processed: processedForms, created: actions.length,
    dry_run_intents: intents.length, data_endpoints: discovered.length, param_endpoints: paramInv.length };
  emitOut.discovered_endpoints = discovered;
  emitOut.param_inventory = paramInv;
  // discovery output is written even in dry-run (read-only) — it feeds /pentest:sql etc.
  if (a.out && paramInv.length) { await mkdir(a.out, { recursive: true }); await writeFile(path.join(a.out, 'widget-param-inventory.json'), JSON.stringify(paramInv, null, 2)); }

  async function processFormsOnPage(pg) {
    const n = await pg.locator('form').count().catch(() => 0);
    const useN = n > 0 ? n : 1;                          // formless SPA page → treat the page as one pseudo-form
    for (let fi = 0; fi < useN && processedForms < maxForms; fi++) { await processForm(pg, n > 0 ? fi : null); processedForms++; }
  }
  emitOut.actions = actions;
  if (!armed) emitOut.intents = intents;
  if (a.out && armed && actions.length) { await mkdir(a.out, { recursive: true }); await writeFile(path.join(a.out, 'crud-exercise.json'), JSON.stringify(actions, null, 2)); }

  async function processForm(pg, formIndex) {
    const scopeLoc = formIndex == null ? pg : pg.locator('form').nth(formIndex);
    const formEl = formIndex == null ? null : await scopeLoc.elementHandle().catch(() => null);
    const fields = await pg.evaluate(new Function('formEl', `return (${INTROSPECT})(formEl);`), formEl).catch(() => []);
    if (!fields.length) return;
    const resource = guessResource(pg.url(), fields);

    // pick a NON-destructive submit control
    const submitLoc = await pickSubmit(scopeLoc);
    const filledFields = [];

    async function fillAll(salt) {
      let n = 0;
      for (const f of fields) {
        const loc = scopeLoc.locator(`[name="${cssAttr(f.name)}"], [id="${cssAttr(f.name)}"]`).first();
        const val = synthValue(f, ++n, salt);
        try {
          if (f.tag === 'select') { if (f.options && f.options.length) await loc.selectOption(f.options[Math.min(salt, f.options.length - 1)] || f.options[0], { timeout: 1500 }); }
          else if (f.type === 'checkbox' || f.type === 'radio') { if (f.required) await loc.check({ timeout: 1500 }); }
          else { await loc.fill(String(val), { timeout: 1500 }); }
          if (salt === 0) filledFields.push({ name: f.name, type: f.type, required: !!f.required });
        } catch { /* field not interactable — skip, retry/agent handles the odd one */ }
      }
    }

    const intent = { resource, ui_route: routeOf(pg.url()), owner: null, marker: `${MARKER}-${resource}-1`,
      fields: filledFields, planned_values: fields.map((f, i) => ({ name: f.name, value: synthValue(f, i + 1, 0) })) };

    if (!armed) { await fillAll(0); intents.push(intent); return; }   // dry-run: fill for preview, submit NOTHING

    // ARMED: fill → submit → capture write → extract id, with ONE validation retry.
    for (let attempt = 0; attempt < 2; attempt++) {
      await fillAll(attempt);
      if (!submitLoc) return;
      const [resp] = await Promise.all([
        pg.waitForResponse((r) => { try { const rq = r.request(); return rq.method() !== 'GET' && rq.method() !== 'HEAD' && inScope(new URL(rq.url()).hostname.toLowerCase()); } catch { return false; } }, { timeout: Math.min(timeout, 12000) }).catch(() => null),
        submitLoc.click({ timeout: 3000 }).catch(() => {}),
      ]);
      await settle(pg);
      if (!resp) continue;                                 // nothing fired — retry once
      const rq = resp.request();
      const status = resp.status();
      const u = new URL(rq.url());
      const bodyText = await resp.text().catch(() => '');
      let body; try { body = rq.postData() ? JSON.parse(rq.postData()) : undefined; } catch { body = rq.postData() || undefined; }
      if (status >= 400 && attempt === 0) {               // validation/error → read it, retry with fresh values
        continue;
      }
      let respJson; try { respJson = JSON.parse(bodyText); } catch { respJson = null; }
      const created = findId(respJson, '') || idFromLocation(resp.headers()['location']) || idFromUrlChange(pg.url(), u.pathname) || {};
      if (resp.headers()['location'] && !created.location) created.location = resp.headers()['location'];
      actions.push({ resource, action: 'create', owner: null, identity: null, marker: intent.marker, ui_route: intent.ui_route,
        request: { method: rq.method(), host: u.hostname, path: u.pathname, content_type: (rq.headers()['content-type'] || '').split(';')[0] || null, body },
        created: Object.keys(created).length ? created : undefined,
        response_status: status, fields: filledFields });
      return;
    }
  }

  async function pickSubmit(scopeLoc) {
    const explicit = scopeLoc.locator('button[type="submit"], input[type="submit"]').first();
    if (await explicit.count().catch(() => 0)) {
      const label = ((await explicit.getAttribute('value').catch(() => '')) || (await explicit.textContent().catch(() => '')) || '').trim();
      if (!DESTRUCTIVE.test(label)) return explicit;
    }
    // otherwise a button whose label looks like create/save and NOT destructive
    const buttons = scopeLoc.locator('button, [role="button"], input[type="button"]');
    const n = await buttons.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const b = buttons.nth(i);
      const label = ((await b.getAttribute('value').catch(() => '')) || (await b.textContent().catch(() => '')) || '').trim();
      if (label && CREATE_HINT.test(label) && !DESTRUCTIVE.test(label)) return b;
    }
    return null;
  }

  // ── READ-ONLY widget/typeahead enumeration (param discovery — never submits a form) ──────────────────────
  async function enumerateWidgets(pg) {
    if (!a.widgets) return;
    await openAddDialogs(pg);   // reveal add-dialogs (widgets live inside them), via buttons not just links
    const SEL = '[role="combobox"], [aria-haspopup="listbox"], mat-select, [class*="select"][class*="trigger"]';
    const wn = Math.min(await pg.locator(SEL).count().catch(() => 0), MAX_WIDGETS);
    for (let i = 0; i < wn; i++) {
      const t = pg.locator(SEL).nth(i);
      try {
        if (!(await t.isVisible().catch(() => false))) continue;
        await t.click({ timeout: 1500 });
        await settle(pg);
        // 1) typeahead: a search input revealed in the open overlay → type a probe (captures ?keyword=…)
        const search = pg.locator('.cdk-overlay-container input, [role="listbox"] input, [role="dialog"] input[placeholder*="search" i], input[placeholder*="find" i], input[placeholder*="search" i]').first();
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
  if (browser) await browser.close().catch(() => {});
}
emit(emitOut);
process.exit(emitOut.ok ? 0 : 1);

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────
async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(400);
}
async function nextNavTarget(page, visited) {
  const baseUrl = page.url();
  let links = [];
  try {
    links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]'))
      .map((el) => ({ href: el.getAttribute('href'), text: (el.textContent || '').trim().slice(0, 60) }))
      .filter((l) => l.href && l.href.startsWith('/') && !l.href.startsWith('//')));
  } catch { return null; }
  // create-labelled links first, then the rest — so forms are reached quickly but nothing is left unexplored
  links.sort((x, y) => (CREATEISH_LINK.test(y.href + ' ' + y.text) ? 1 : 0) - (CREATEISH_LINK.test(x.href + ' ' + x.text) ? 1 : 0));
  for (const l of links) {
    if (AVOID_LINK.test(l.href) || AVOID_LINK.test(l.text)) continue;
    let abs; try { abs = new URL(l.href, baseUrl); } catch { continue; }
    if (!inScope(abs.hostname.toLowerCase())) continue;
    if (!visited.has(routeKey(abs.href))) return l.href;
  }
  return null;
}
async function navigateTo(page, href) {
  // prefer CLICKING the real link (keeps SPA state/auth); fall back to goto for plain MPAs
  try { await page.click(`a[href="${cssAttr(href)}"]`, { timeout: 2500 }); return true; } catch {}
  try { await page.goto(new URL(href, page.url()).toString(), { waitUntil: 'domcontentloaded', timeout }); return true; } catch { return false; }
}
function routeKey(u) { try { return new URL(u).pathname; } catch { return u; } }
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
