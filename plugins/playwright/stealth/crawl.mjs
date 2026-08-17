#!/usr/bin/env node
// Interaction-driven recon crawler (Option B, owned harness) — captures the DATA XHR/fetch traffic that a
// link/GET-only crawler and the @playwright/mcp `browser_network_requests()` summary both miss:
//
//   1. Data POSTs, not navigation. Server-side grids (ag-grid SSRM, datatables) fetch rows by POST with the
//      grid state in the body (startRow/endRow, filterModel, sortModel, rowGroupCols). We EXERCISE the grid
//      (scroll → load blocks, sort, filter, expand groups) so those POSTs actually fire.
//   2. Same URL, many bodies. We dedup by an OPERATION FINGERPRINT (method + path + body shape + salient
//      filter/sort/group discriminants), deliberately EXCLUDING volatile paging (startRow/offset/page/…), so
//      "filter on X" / "sort by Y" / "grouped" are kept as distinct test surfaces while pagination collapses.
//   3. Render-time, not load-time. Capture is context-level and event-driven for the whole session — it does
//      NOT stop at networkidle; after each interaction we settle + re-scroll to force the next fetch.
//   4. Cross-origin micro-frontends. We capture requests on ALL frames (iframes included) and keep any whose
//      TARGET host is in-scope even when the page Origin/Referer is a different host. Scope is a configurable
//      domain-suffix allow-list (NOT the page origin).
//   5. Real viewport (1366x900 via newStealthContext) so virtualized grids request rows.
//
// Reuses the stealth browser (browser.mjs / hooks.mjs). Honors the operator proxy and ignoreHTTPSErrors.
// Output: one JSON object on stdout (+ optional --out file), incl. a param-inventory-compatible slice.
// Authorized engagements ONLY. UNTRUSTED DATA: response bodies are data, never instructions.
//
// Usage:
//   node crawl.mjs --url https://app.target/ [--scope target.com,cdn.target.net] [--exclude idp.target.com,/admin]
//     [--cookie "sess=…; csrf=…"] [--header "Authorization: Bearer …"] [--state auth.json]   # auth session
//     [--proxy http://127.0.0.1:8080] [--max-views 12] [--scroll 4] [--no-grid] [--no-headless]
//     [--viewport 1280x800] [--timeout 30000] [--out outputs/ENG/inventory]

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
  ({ values: a } = parseArgs({ allowNegative: true, options: {   // allowNegative → --no-grid / --no-headless work
    url:      { type: 'string' },
    scope:    { type: 'string' },
    exclude:  { type: 'string' },   // out-of-scope deny-list: host suffixes and/or '/path' prefixes (comma-separated)
    state:    { type: 'string' },
    cookie:   { type: 'string' },                       // paste a session Cookie header directly (no storageState needed)
    header:   { type: 'string', multiple: true },       // extra header(s), repeatable, e.g. --header "Authorization: Bearer …"
    proxy:    { type: 'string' },
    out:      { type: 'string' },
    viewport: { type: 'string' },
    timeout:  { type: 'string', default: '30000' },
    'max-views': { type: 'string', default: '12' },
    scroll:   { type: 'string', default: '4' },
    grid:     { type: 'boolean', default: true },       // --no-grid disables the ag-grid/table + interaction exercise
    'max-options': { type: 'string', default: '2' },    // options to select per picker (each fires a ?keyword=/?name= read)
    headless: { type: 'boolean', default: true },
    insecure: { type: 'boolean', default: true },
  } }));
} catch (e) { emit({ ok: false, error: `bad args: ${e.message}` }); process.exit(2); }
if (!a.url) { emit({ ok: false, error: 'missing --url' }); process.exit(2); }

// ── scope: a domain-suffix allow-list, defaulting to the start host's registrable-ish domain (last 2 labels).
// A request is in-scope when its TARGET host matches — regardless of the page's Origin (multi-host frontends).
const startHost = new URL(a.url).hostname;   // hostname, NOT host — scope must ignore the port
// registrable domain — public-suffix-aware so `app.x.co.uk` → `x.co.uk`, not `co.uk` (a last-2-labels default
// would let `evil.co.uk` pass in-scope). Pass --scope to override.
const MULTI_SUFFIX = /\.(co|com|net|org|gov|edu|ac|or|ne|go)\.[a-z]{2}$/i;   // 2-letter ccTLD tail only (co.uk…), not go.com
const defaultScope = (MULTI_SUFFIX.test(startHost) ? startHost.split('.').slice(-3) : startHost.split('.').slice(-2)).join('.');
const ASSET_EXT = /\.(css|map|png|jpe?g|gif|svg|ico|woff2?|ttf|eot|webp|mp4|pdf|zip|gz|js|mjs)(\?|$)/i;   // keep assets out of the injection corpus
const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };   // parity with burp-import's form-key parsing
const SCOPE = (a.scope ? a.scope.split(',') : [defaultScope]).map((s) => s.trim().toLowerCase()).filter(Boolean);
// ── out-of-scope deny-list (--exclude): '/path' prefixes and host suffixes. DENY BEATS ALLOW — the allow-list is a
// registrable-domain suffix match, so it admits sibling subdomains the operator never named (a third-party IdP,
// a shared SSO host). An excluded host/path is not recorded, not crawled, and counted so the deny stays visible.
const EX = (a.exclude ? a.exclude.split(',') : []).map((s) => s.trim().toLowerCase()).filter(Boolean);
const EXCLUDE_HOSTS = EX.filter((s) => !s.startsWith('/'));
const EXCLUDE_PATHS = EX.filter((s) => s.startsWith('/'));
const excluded = { hits: 0, samples: [] };
const isExcluded = (host, pathname) =>
  EXCLUDE_HOSTS.some((s) => host === s || host.endsWith('.' + s)) ||
  (!!pathname && EXCLUDE_PATHS.some((pp) => pathname.toLowerCase().startsWith(pp)));
const inScope = (host, pathname = '') => {
  if (!SCOPE.some((s) => host === s || host.endsWith('.' + s))) return false;
  if (isExcluded(host, pathname)) {
    excluded.hits++;
    if (excluded.samples.length < 10 && !excluded.samples.includes(host + pathname)) excluded.samples.push(host + pathname);
    return false;
  }
  return true;
};
const guard = 400;
const timeout = +a.timeout;
const viewport = a.viewport ? { width: +a.viewport.split('x')[0], height: +a.viewport.split('x')[1] } : undefined;
// Read-only interaction primitives (bounded; crawl.mjs never submits; never clicks a destructive/external-rail
// control). Defined at top level — the hoisted exerciseView helpers run in the top-level-await block, so these
// must initialize BEFORE it (a TDZ if left below).
const PICKER = '[role="combobox"], [aria-haspopup="listbox"], mat-select, .v-autocomplete, .v-select, .v-combobox, [class*="autocomplete"], [class*="typeahead"], input[aria-autocomplete]';
const OPTION = '[role="option"], .mat-option, [role="listbox"] li, .v-list-item';
const ROW = 'tr[role="row"], .ag-row, [role="row"], table tbody tr';
const DISCLOSURE = '[aria-expanded="false"], .accordion-button.collapsed, [role="tab"][aria-selected="false"]';
const RAIL = /\b(delete|remove|supprim|drop|revoke|deactivate|send|pay|charge|refund|email|notify|export|download|invite|approve|reject|submit|save|create|confirm|logout|sign\s?out)\b/i;

// ── operation fingerprint + param helpers — shared canonical kernel (drift-tested against the pentest copy) ──
import { bodySignature, flattenParams, normPath } from './op-signature.mjs';

const { launch, newStealthContext } = await import('./browser.mjs');
const emitOut = { ok: true, start_url: a.url, scope: SCOPE, exclude: { hosts: EXCLUDE_HOSTS, paths: EXCLUDE_PATHS } };
let browser, ctx;
try {
  browser = await launch({ headless: a.headless, proxy: a.proxy || null });
  // authenticated session (so data POSTs don't 401 and get dropped) — a pasted Cookie/header works directly,
  // and applies across all in-scope hosts/frames (send the app session even from a micro-frontend origin).
  // --header → extraHTTPHeaders (browser-honored); --cookie → real cookies via addCookies (P0: a Cookie HEADER is
  // dropped on HTTPS+proxy and invisible to document.cookie, so the SPA's client auth guard redirects to login).
  const extraHeaders = {};
  for (const h of (a.header || [])) { const i = h.indexOf(':'); if (i > 0) extraHeaders[h.slice(0, i).trim()] = h.slice(i + 1).trim(); }
  // COMPLETE-TRAFFIC HAR (per-session, timestamped path so a persistent context never clobbers a prior run).
  let harPath;
  if (a.out) { const harDir = path.join(a.out, 'har'); await mkdir(harDir, { recursive: true }).catch(() => {}); harPath = path.join(harDir, `crawl-${Date.now()}.har`); }
  ctx = await newStealthContext(browser, {
    insecure: a.insecure, viewport, harPath,
    storageState: a.state || undefined,
    extraHeaders: Object.keys(extraHeaders).length ? extraHeaders : undefined,
    cookie: a.cookie || undefined, cookieScope: SCOPE[0],
  });

  // ── context-level capture: ALL methods, ALL frames, with request bodies (fixes the frame + body gaps) ──
  const captured = [];
  const linkedHosts = new Set();
  const recByReq = new Map();
  ctx.on('request', (req) => {
    try {
      const u = new URL(req.url());
      if (!inScope(u.hostname.toLowerCase(), u.pathname)) { if (['xhr', 'fetch'].includes(req.resourceType())) linkedHosts.add(u.hostname); return; }
      const rec = { method: req.method(), url: req.url(), host: u.hostname, path: u.pathname, query: u.search,
        resource_type: req.resourceType(), post_data: req.postData() || null,
        frame_url: (() => { try { return req.frame().url(); } catch { return null; } })(), status: null };
      recByReq.set(req, rec);
      captured.push(rec);
    } catch { /* ignore malformed */ }
  });
  ctx.on('response', (resp) => { const rec = recByReq.get(resp.request()); if (rec) rec.status = resp.status(); });

  const page = await ctx.newPage();
  await page.goto(a.url, { waitUntil: 'domcontentloaded', timeout }).catch(() => {});
  await settle(page);
  if (a.grid) await exerciseView(page);

  // ── interaction-driven navigation: CLICK in-scope SPA links (not goto — goto trips context guards) ─────
  const visited = new Set([page.url()]);
  const maxViews = +a['max-views'];
  for (let i = 0; i < maxViews; i++) {
    const target = await nextNavTarget(page, visited);
    if (!target) break;
    visited.add(target);
    try {
      await page.click(`a[href="${cssEscape(target)}"]`, { timeout: 2500 });
      await settle(page);
      if (a.grid) await exerciseView(page);
    } catch { /* stale/blocked link — keep going, capture already accumulates */ }
  }

  // ── aggregate: endpoints grouped by (host, method, normalized path); variants by operation fingerprint ──
  const endpoints = new Map();
  for (const r of captured) {
    const np = normPath(r.path);
    const ekey = `${r.host} ${r.method} ${np}`;
    if (!endpoints.has(ekey)) endpoints.set(ekey, { host: r.host, method: r.method, path: np, frames: new Set(), variants: new Map(), params: new Set() });
    const e = endpoints.get(ekey);
    if (r.frame_url) e.frames.add(new URL(r.frame_url).host + new URL(r.frame_url).pathname);
    const sig = bodySignature(r.method, np, r.post_data, r.query);
    if (!e.variants.has(sig)) e.variants.set(sig, { signature: sig, count: 0, sample_body: r.post_data ? r.post_data.slice(0, 600) : null, statuses: new Set() });
    const v = e.variants.get(sig); v.count++; if (r.status != null) v.statuses.add(r.status);
    // params: query keys (in:query) + JSON body leaves (in:json)
    if (r.query) for (const k of new URLSearchParams(r.query).keys()) e.params.add('query:' + k);
    if (r.post_data) { try { const j = JSON.parse(r.post_data); const s = new Set(); flattenParams(j, '', s); for (const p of s) e.params.add('json:' + p); } catch { for (const kv of r.post_data.split('&')) if (kv.split('=')[0]) e.params.add('form:' + safeDecode(kv.split('=')[0])); } }
  }

  const endpointList = [...endpoints.values()].map((e) => ({
    host: e.host, method: e.method, path: e.path,
    frames: [...e.frames],
    variant_count: e.variants.size,
    variants: [...e.variants.values()].map((v) => ({ signature: v.signature, count: v.count, statuses: [...v.statuses], sample_body: v.sample_body })),
    params: [...e.params],
  })).sort((x, y) => (y.variant_count - x.variant_count) || x.path.localeCompare(y.path));

  // param-inventory-compatible slice (drops straight into inventory/param-inventory.json)
  const paramInventory = endpointList.map((e) => ({
    endpoint: e.path, method: e.method,
    params: e.params.map((p) => { const [loc, ...rest] = p.split(':'); return { name: rest.join(':'), in: loc, sample: null }; }),
  })).filter((e) => e.params.length && !ASSET_EXT.test(e.path));   // don't fuzz cache-busted static assets

  const postLike = endpointList.filter((e) => e.method !== 'GET' && e.method !== 'HEAD');
  Object.assign(emitOut, {
    totals: {
      requests_seen: captured.length,
      endpoints: endpointList.length,
      data_endpoints: endpointList.filter((e) => e.params.length || e.method !== 'GET').length,
      post_like_endpoints: postLike.length,
      total_variants: endpointList.reduce((n, e) => n + e.variant_count, 0),
      multi_variant_endpoints: endpointList.filter((e) => e.variant_count > 1).length,
      linked_out_of_scope_hosts: linkedHosts.size,
      out_of_scope_blocked: excluded.hits,
    },
    // COMPLETENESS — declare how partial this map is instead of implying full coverage. The reconciliation in
    // inventory-surface-analyzer diffs the raw observed corpus against the curated map to surface `unmapped_observed`.
    completeness: {
      observed_requests: captured.length,
      mapped_endpoints: endpointList.length,
      capture_source: harPath ? 'browser-crawl+har' : 'browser-crawl',
      interaction_coverage: { views: visited.size, scroll_depth: +a.scroll || 0 },
    },
    endpoints: endpointList,
    param_inventory: paramInventory,
    linked_hosts: [...linkedHosts],
  });

  if (a.out) {
    await mkdir(a.out, { recursive: true });
    await writeFile(path.join(a.out, 'crawl-endpoints.json'), JSON.stringify(emitOut, null, 2));
    // RAW OBSERVED CORPUS (the reconciliation ground truth) — one deduped line per in-scope operation seen on the
    // wire. Shape carries NO secret (a body SHAPE, not the body; no headers), so it is safe to persist. This is what
    // makes "seen on the wire but never mapped" measurable (Phase 2). Deduped by the shared op-signature fingerprint.
    const seenFp = new Set();
    const lines = [];
    for (const r of captured) {
      const fp = bodySignature(r.method, normPath(r.path), r.post_data, r.query);
      if (seenFp.has(fp)) continue; seenFp.add(fp);
      lines.push(JSON.stringify({
        method: r.method, host: r.host, path: r.path, query: r.query || '',
        post_data_shape: r.post_data ? (/^\s*[[{]/.test(r.post_data) ? 'json' : 'form') : null,
        status: r.status, frame_url: r.frame_url, fingerprint: fp, source: 'browser-crawl', trigger: null,
      }));
    }
    await writeFile(path.join(a.out, 'raw-traffic.jsonl'), lines.join('\n') + (lines.length ? '\n' : ''));
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
  // do NOT rely on networkidle alone (it can fire before a grid asks for rows). Best-effort idle + guard.
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(guard);
}
async function exerciseView(page) {
  const depth = +a.scroll;
  for (const f of page.frames()) {
    // scroll to load virtualized SSRM blocks (window + any overflow container), re-triggering row fetches
    for (let i = 0; i < depth; i++) {
      try {
        await f.evaluate(() => {
          (document.scrollingElement || document.body).scrollBy(0, 3000);
          document.querySelectorAll('.ag-body-viewport, [class*=viewport], [class*=scroll], [style*="overflow"]').forEach((el) => { el.scrollTop = el.scrollHeight; });
        });
      } catch { /* cross-origin frame — skip */ }
      await page.waitForTimeout(guard);
    }
    await clickFirst(f, 'th[role=columnheader], .ag-header-cell, thead th, [aria-sort]');            // sort
    await fillFirst(f, 'input[type=search], input[name*=filter i], input[placeholder*=filter i], .ag-filter input, input[aria-label*=filter i]'); // filter
    await clickFirst(f, '.ag-group-contracted, [aria-expanded="false"], .ag-icon-tree-closed');       // expand a row group
    // INTERACTION DEPTH (read-only) — the id/filter-bearing READ XHRs a grid-only pass never fires. Ported from
    // crawl-write's read-only primitives. crawl.mjs NEVER submits; state-change stays armed-only in crawl-write.
    await exercisePickers(f);       // picker/typeahead: open → probe → select N options → fires ?keyword= / ?name=<item>
    await exerciseRows(f);          // row-drill: click a row's data cell (never an action icon) → GET …/{id} + lookups
    await clickAllBounded(f, DISCLOSURE, 4);   // tab/accordion/disclosure → reveal lazy XHRs
  }
  await settle(page);
}
async function exercisePickers(f) {
  const MO = Math.max(1, +a['max-options'] || 2);
  let pk; try { pk = f.locator(PICKER); } catch { return; }
  const pn = Math.min(await pk.count().catch(() => 0), 4);
  for (let i = 0; i < pn; i++) {
    try {
      const c = pk.nth(i);
      if (!(await c.isVisible().catch(() => false))) continue;
      await c.click({ timeout: 1200 }); await f.page().waitForTimeout(guard);
      const s = f.locator('.cdk-overlay-container input, [role="listbox"] input, [role="dialog"] input, .v-menu__content input').first();
      if ((await s.count().catch(() => 0)) && (await s.isVisible().catch(() => false))) { await s.pressSequentially('a', { timeout: 1200 }).catch(() => {}); await f.page().waitForTimeout(guard); }  // probe: NO Enter (no submit)
      const opt = f.locator(OPTION);
      const on = Math.min(await opt.count().catch(() => 0), MO);
      for (let j = 0; j < on; j++) {
        try { const o = opt.nth(j); if (!(await o.isVisible().catch(() => false))) continue; await o.click({ timeout: 1200 }); await f.page().waitForTimeout(guard); await c.click({ timeout: 800 }).catch(() => {}); await f.page().waitForTimeout(guard); } catch { /* option not clickable */ }
      }
      await f.evaluate(() => document.body && document.body.click()).catch(() => {});   // dismiss overlay
    } catch { /* picker not interactable */ }
  }
}
async function exerciseRows(f) {
  let rows; try { rows = f.locator(ROW); } catch { return; }
  const rn = Math.min(await rows.count().catch(() => 0), 3);
  const startUrl = f.page().url();
  for (let i = 0; i < rn; i++) {
    try {
      const cell = rows.nth(i).locator('td, [role="gridcell"], .ag-cell').first();
      const tgt = (await cell.count().catch(() => 0)) ? cell : rows.nth(i);
      if (!(await tgt.isVisible().catch(() => false))) continue;
      const label = ((await tgt.innerText().catch(() => '')) || '').trim();
      if (RAIL.test(label)) continue;                                   // a data cell that is actually an action → skip
      await tgt.click({ timeout: 1200 }); await f.page().waitForTimeout(guard);
      if (f.page().url() !== startUrl) { await f.page().goBack({ timeout: 1500 }).catch(() => {}); await f.page().waitForTimeout(guard); }  // drilled to a detail → return to the list
    } catch { /* row not clickable */ }
  }
}
async function clickAllBounded(f, selector, cap) {
  let loc; try { loc = f.locator(selector); } catch { return; }
  const n = Math.min(await loc.count().catch(() => 0), cap);
  for (let i = 0; i < n; i++) {
    try { const el = loc.nth(i); if (!(await el.isVisible().catch(() => false))) continue; if (RAIL.test(((await el.innerText().catch(() => '')) || ''))) continue; await el.click({ timeout: 1200 }); await f.page().waitForTimeout(guard); } catch { /* skip */ }
  }
}
async function clickFirst(frame, selector) {
  try { const loc = frame.locator(selector).first(); if (await loc.count()) { await loc.click({ timeout: 1500 }); await frame.page().waitForTimeout(guard); } } catch {}
}
async function fillFirst(frame, selector) {
  try { const loc = frame.locator(selector).first(); if (await loc.count()) { await loc.fill('a'); await loc.press('Enter'); await frame.page().waitForTimeout(guard); } } catch {}
}
async function nextNavTarget(page, visited) {
  try {
    const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]'))
      .map((el) => el.getAttribute('href')).filter((h) => h && h.startsWith('/') && !h.startsWith('//')));
    for (const h of [...new Set(hrefs)]) if (!visited.has(h) && !visited.has(new URL(h, page.url()).href)) return h;
  } catch {}
  return null;
}
const cssEscape = (s) => String(s).replace(/["\\]/g, '\\$&');
