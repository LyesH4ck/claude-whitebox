#!/usr/bin/env node
// domxss-detect — deterministic DOM-XSS DETECTION for one URL across its DOM sources.
//
// Where sqli-detect.mjs is the deterministic backbone for SQLi, this is the backbone for DOM-XSS: it removes
// the run-to-run flakiness of the agent-only path. That path was non-reproducible for two structural reasons —
//   (1) the confirmation oracle was `browser_console_messages()` after an `alert()` payload, but alert() is a
//       DIALOG, not a console message, so an executing payload was seen in one run and missed the next; and
//   (2) which sources/payloads got tried was an ad-hoc LLM choice, so coverage drifted between scans.
// This tool fixes both: for each source (hash, search, postmessage, name) it injects a FIXED canonical beacon
// payload whose handler calls `window.__xh(<label>)` — a Playwright exposeFunction binding. The binding firing
// is UNAMBIGUOUS PROOF the payload EXECUTED (not merely reflected): no dialog, no console scraping, and NO read
// race (we await the callback edge with a timeout). Dialogs are auto-dismissed AND counted, so an alert()-ish
// sink can never hang the run. Encoded reflection can never fire the binding → zero false positives.
//
// AUTHORIZED ENGAGEMENTS ONLY — these payloads execute in the target page; use a test environment where possible.
//
// Usage:
//   node domxss-detect.mjs --url "https://t/page" --sources hash,search,postmessage,name --param q
//   node domxss-detect.mjs --url "https://t/app" --state auth.json --cookie "s=…" --out outputs/ENGAGEMENT/activity
//   options: --header 'Authorization: Bearer …' (repeatable) --proxy http://127.0.0.1:8080 --insecure
//            --timeout 15000 --no-headless

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
    sources:  { type: 'string' },                        // csv subset of hash,search,postmessage,name
    param:    { type: 'string', default: 'q' },          // query param name for the `search` source
    state:    { type: 'string' },                        // Playwright storageState JSON (authenticated session)
    cookie:   { type: 'string' },                        // session Cookie header, injected as real cookies
    header:   { type: 'string', multiple: true },        // extra header(s), repeatable
    proxy:    { type: 'string' },
    scope:    { type: 'string' },                        // cookie domain scope (defaults to the url host)
    out:      { type: 'string' },
    timeout:  { type: 'string', default: '15000' },
    headless: { type: 'boolean', default: true },
    insecure: { type: 'boolean', default: true },
  } }));
} catch (e) { emit({ ok: false, error: `bad args: ${e.message}` }); process.exit(2); }
if (!a.url) { emit({ ok: false, error: 'missing --url' }); process.exit(2); }

const SRC_ALL = ['hash', 'search', 'postmessage', 'name'];
const sources = (a.sources ? a.sources.split(',') : SRC_ALL).map((s) => s.trim().toLowerCase()).filter((s) => SRC_ALL.includes(s));
if (!sources.length) { emit({ ok: false, error: `no valid --sources (pick from ${SRC_ALL.join(',')})` }); process.exit(2); }
const timeout = +a.timeout;
const headers = {}; for (const h of a.header || []) { const i = h.indexOf(':'); if (i > 0) headers[h.slice(0, i).trim()] = h.slice(i + 1).trim(); }
const extraHeaders = Object.keys(headers).length ? headers : undefined;
const cookieScope = a.scope || (() => { try { return new URL(a.url).hostname; } catch { return null; } })();

// Canonical beacon payloads — FIXED (same set, same order, every run → reproducible). Each handler calls the
// exposeFunction binding with a unique label so a fired binding pinpoints the source+variant that executed.
// `<img onerror>` / `<svg onload>` fire when parsed by innerHTML/document.write (the dominant DOM-XSS sinks);
// `"><img …>` breaks out of an attribute-value context first.
const payloadsFor = (label) => [
  ['img', `<img src=x onerror="window.__xh('${label}:img')">`],
  ['svg', `<svg onload="window.__xh('${label}:svg')">`],
  ['brk', `"><img src=x onerror="window.__xh('${label}:brk')">`],
];

const { launch, newStealthContext } = await import('./browser.mjs');
const emitOut = { ok: true, url: a.url, sources, results: [] };
let browser, ctx;
try {
  browser = await launch({ headless: a.headless, proxy: a.proxy || null });
  ctx = await newStealthContext(browser, {
    insecure: a.insecure, storageState: a.state || undefined,
    cookie: a.cookie, cookieScope, extraHeaders,
  });

  // EXECUTION BEACON — the whole point. A payload that runs calls window.__xh(label); the binding records the
  // edge. Reflection (encoded/inert) never calls it. Bound on the CONTEXT so it survives every navigation.
  const fired = new Set();
  await ctx.exposeFunction('__xh', (label) => { fired.add(String(label)); });
  const page = await ctx.newPage();
  // A sink that ends up calling alert()/confirm() would block forever — auto-dismiss (and count it as execution).
  page.on('dialog', (d) => { fired.add(`dialog:${d.type()}`); d.dismiss().catch(() => {}); });

  const waitHit = async (label, ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (fired.has(label)) return true; await new Promise((r) => setTimeout(r, 25)); }
    return fired.has(label);
  };
  const settle = async () => {
    await page.waitForLoadState('load', { timeout: Math.min(timeout, 8000) }).catch(() => {});
    await page.waitForTimeout(150);
  };

  const base = a.url.split('#')[0];
  const inject = {
    // hash — set via location.hash so hashchange listeners fire; reset first so a change event is guaranteed.
    hash: async (payload) => {
      await page.goto(base, { timeout }).catch(() => {});
      await settle();
      await page.evaluate((p) => { location.hash = 'dxreset'; location.hash = p; }, payload).catch(() => {});
      await settle();
    },
    // search — the payload rides a query param through a full navigation.
    search: async (payload) => {
      let u; try { u = new URL(a.url); } catch { u = new URL(base); }
      u.searchParams.set(a.param, payload);
      await page.goto(u.toString(), { timeout }).catch(() => {});
      await settle();
    },
    // postmessage — deliver via window.postMessage after the listener is wired.
    postmessage: async (payload) => {
      await page.goto(base, { timeout }).catch(() => {});
      await settle();
      await page.evaluate((p) => { try { window.postMessage(p, '*'); } catch { /* ignore */ } }, payload).catch(() => {});
      await settle();
    },
    // name — window.name persists across navigation; set it then reload so on-load code reads it.
    name: async (payload) => {
      await page.goto(base, { timeout }).catch(() => {});
      await page.evaluate((p) => { window.name = p; }, payload).catch(() => {});
      await page.goto(base, { timeout }).catch(() => {});
      await settle();
    },
  };

  for (const src of sources) {
    let hit = null;
    for (const [variant, payload] of payloadsFor(src)) {
      const label = `${src}:${variant}`;
      await inject[src](payload);
      if (await waitHit(label, 900)) { hit = { variant, payload }; break; }
    }
    emitOut.results.push(hit
      ? { source: src, executed: true, variant: hit.variant, payload: hit.payload,
          evidence: `window.__xh('${src}:${hit.variant}') fired → payload EXECUTED in the ${src} sink (edge-triggered beacon — proof of execution, not reflection)` }
      : { source: src, executed: false,
          evidence: `no beacon fired across ${payloadsFor(src).length} canonical payloads → no DOM-XSS execution for ${src} (encoded reflection / CSP inline-block / no sink)` });
  }
} catch (e) {
  emitOut.ok = false; emitOut.error = String((e && e.message) || e);
} finally {
  if (ctx) await ctx.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
}

emitOut.confirmed_sources = emitOut.results.filter((r) => r.executed).map((r) => r.source);
emitOut.verdict = emitOut.confirmed_sources.length ? 'DOM-XSS CONFIRMED' : 'no DOM-XSS execution observed';
if (a.out) { await mkdir(a.out, { recursive: true }).catch(() => {}); await writeFile(path.join(a.out, 'domxss-detect.json'), JSON.stringify(emitOut, null, 2)); }
emit(emitOut);
process.exit(emitOut.ok ? 0 : 1);
