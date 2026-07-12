#!/usr/bin/env node
// marker-propagation — deterministic SECOND-ORDER (write→read) taint primitive.
//
// A form POST stores a value; that value often resurfaces via a DIFFERENT endpoint (a list, a detail page, an
// export, an admin panel). crawl-write.mjs already writes MARKER-tagged, field-compliant values and captures the
// write requests + created ids; this tool closes the loop: it finds WHERE the marker resurfaces, classifies the
// reflection context, and answers "is a sink reachable?" — the stored/second-order dimension the agent path
// could not do reproducibly (it had to GUESS the read endpoint). Generic on purpose: the same write→read map
// serves stored XSS (this file's --render beacon confirms execution), stored SQLi/SSTI (injection-tester), and
// which read exposes a created object (idor-bola-tester).
//
// Two levels of proof, both here:
//   • REACHABILITY (deterministic, no browser needed): search already-captured HAR bodies (and/or live-fetched
//     read endpoints) for the marker. A canary marker carrying metachars (e.g. PENTEST7<'">) also tells us if it
//     came back UN-encoded (injectable) vs HTML-encoded (inert) and in which context (html-text/attribute/js/url).
//   • EXECUTION (--render): render each read endpoint in the stealth browser with the window.__xh beacon exposed
//     (same edge-triggered oracle as domxss-detect). If a value crawl-write stored as a beacon payload EXECUTES
//     on render → STORED XSS CONFIRMED, reproducibly.
//
// AUTHORIZED ENGAGEMENTS ONLY. This tool only READS; the state-changing writes are crawl-write's (already gated).
//
// Usage:
//   # Phase A — reachability from the recon HAR (no traffic, no browser):
//   node marker-propagation.mjs --marker "PENTEST7<'\">" --har outputs/ENGAGEMENT/recon/har/crawl-*.har --scope example.com
//   # Phase A live — fetch specific read endpoints (server-rendered):
//   node marker-propagation.mjs --marker "PENTEST7<'\">" --read-url https://t/thread --read-url https://t/admin/list --cookie "s=…"
//   # Phase B — render read endpoints + confirm a stored beacon payload executes (client-rendered / SPA):
//   node marker-propagation.mjs --marker "__xh" --reads reads.txt --render --state auth.json --out outputs/ENGAGEMENT/activity

import { parseArgs } from 'node:util';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const emit = (o) => process.stdout.write(JSON.stringify(o, null, 2) + '\n');

let a;
try {
  ({ values: a } = parseArgs({ allowNegative: true, options: {
    marker:    { type: 'string' },                        // the marker/canary to hunt (may carry metachars <'"> )
    har:       { type: 'string', multiple: true },        // crawl HAR(s) with embedded bodies (static, no traffic)
    'read-url':{ type: 'string', multiple: true },        // live read endpoint(s) to fetch/render
    reads:     { type: 'string' },                        // a file of read URLs, one per line
    render:    { type: 'boolean', default: false },       // render in the browser (SPA) + arm the __xh beacon
    scope:     { type: 'string' },                        // host suffix(es) to keep from the HAR
    state:     { type: 'string' }, cookie: { type: 'string' }, header: { type: 'string', multiple: true },
    proxy:     { type: 'string' },
    timeout:   { type: 'string', default: '15000' },
    headless:  { type: 'boolean', default: true },
    insecure:  { type: 'boolean', default: true },
    out:       { type: 'string' },
  } }));
} catch (e) { emit({ ok: false, error: `bad args: ${e.message}` }); process.exit(2); }
if (!a.marker) { emit({ ok: false, error: 'missing --marker' }); process.exit(2); }

const liveUrls = [
  ...(a['read-url'] || []),
  ...(a.reads ? (await readFile(a.reads, 'utf8').catch(() => '')).split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : []),
];
if (!a.har?.length && !liveUrls.length) { emit({ ok: false, error: 'need --har and/or --read-url/--reads' }); process.exit(2); }

const marker = a.marker;
const hasMeta = /[<>"'&]/.test(marker);
const core = marker.replace(/[<>"'&/\\]/g, '');           // metachar-stripped core — survives most encoding/sanitization
const timeout = +a.timeout;
const headers = {}; for (const h of a.header || []) { const i = h.indexOf(':'); if (i > 0) headers[h.slice(0, i).trim()] = h.slice(i + 1).trim(); }
if (a.cookie && !headers.Cookie) headers.Cookie = a.cookie;
const SCOPE = (a.scope ? a.scope.split(',') : []).map((s) => s.trim().toLowerCase()).filter(Boolean);
const inScope = (url) => { if (!SCOPE.length) return true; let h; try { h = new URL(url).hostname.toLowerCase(); } catch { return true; } return SCOPE.some((s) => h === s || h.endsWith('.' + s)); };

const idxAll = (text, needle, cap = 50) => { const o = []; if (!needle) return o; let i = text.indexOf(needle); while (i !== -1 && o.length < cap) { o.push(i); i = text.indexOf(needle, i + needle.length); } return o; };
const PAGE_SINKS = [/\.innerHTML\s*=/i, /\.outerHTML\s*=/i, /document\s*\.\s*write(ln)?\s*\(/i, /insertAdjacentHTML/i, /\beval\s*\(/i, /dangerouslySetInnerHTML/i, /\.html\s*\(/i];
const hasSink = (t) => PAGE_SINKS.some((re) => re.test(t));
const EXEC_CTX = new Set(['js', 'attribute', 'url', 'html-text']);   // a raw metachar here can escalate to execution
function ctxAt(text, idx) {
  const before = text.slice(Math.max(0, idx - 300), idx);
  const low = before.toLowerCase();
  if (low.lastIndexOf('<script') > low.lastIndexOf('</script')) return 'js';
  const lastOpen = before.lastIndexOf('<'), lastClose = before.lastIndexOf('>');
  if (lastOpen > lastClose) {   // inside a tag
    const attr = before.slice(lastOpen);
    if (/\b(href|src|action|formaction|xlink:href)\s*=\s*["']?[^"'>]*$/i.test(attr)) return 'url';
    return 'attribute';
  }
  return 'html-text';
}
function analyze(rec) {
  const text = rec.text || '';
  const rawOcc = hasMeta ? idxAll(text, marker) : [];     // marker verbatim (metachars intact) → dangerous
  const coreOcc = idxAll(text, core);                     // reachability (present even if encoded/sanitized)
  if (!rawOcc.length && !coreOcc.length && !rec.executed) return null;
  const primary = rawOcc.length ? rawOcc[0] : (coreOcc.length ? coreOcc[0] : 0);
  const context = ctxAt(text, primary);
  const metachars_unencoded = rawOcc.length > 0;
  const sink_reachable = !!rec.executed || (metachars_unencoded && EXEC_CTX.has(context));
  return {
    url: rec.url, source: rec.source, occurrences: rawOcc.length || coreOcc.length,
    context, metachars_unencoded, sink_on_page: hasSink(text), executed: !!rec.executed, sink_reachable,
    evidence: rec.executed ? 'stored payload EXECUTED on render (window.__xh fired) → confirmed stored XSS'
      : metachars_unencoded ? `marker reflected UN-encoded in a ${context} context at a read endpoint → injectable (sink reachable)`
      : `marker reflected but encoded/sanitized (inert) in a ${context} context`,
  };
}

// ── gather read records ──────────────────────────────────────────────────────────────────────────────────
const records = [];
for (const harPath of a.har || []) {
  let har;
  try { har = JSON.parse(await readFile(harPath, 'utf8')); }
  catch (e) { emit({ ok: false, error: `cannot read HAR ${harPath}: ${e.message}` }); process.exit(2); }
  for (const e of har?.log?.entries || []) {
    const url = e?.request?.url, c = e?.response?.content;
    if (!url || !c?.text || c.encoding === 'base64' || !inScope(url)) continue;
    if (!/(html|json|javascript|ecmascript|xml|text\/plain)/i.test(c.mimeType || '')) continue;
    records.push({ url, text: c.text, source: 'har' });
  }
}

let browser, ctx;
try {
  if (liveUrls.length && !a.render) {
    for (const url of liveUrls) {
      try { const r = await fetch(url, { headers, redirect: 'manual' }); records.push({ url, text: await r.text(), source: 'fetch' }); }
      catch (e) { records.push({ url, text: '', source: 'fetch', error: String(e.message || e) }); }
    }
  }
  if (liveUrls.length && a.render) {
    let mod;
    try { mod = await import('./browser.mjs'); }
    catch { emit({ ok: false, error: 'deps_missing', hint: `--render needs the stealth deps: (cd ${here} && npm install)` }); process.exit(2); }
    const { launch, newStealthContext } = mod;
    const scope = a.scope || (() => { try { return new URL(liveUrls[0]).hostname; } catch { return null; } })();
    browser = await launch({ headless: a.headless, proxy: a.proxy || null });
    ctx = await newStealthContext(browser, { insecure: a.insecure, storageState: a.state || undefined, cookie: a.cookie, cookieScope: scope, extraHeaders: Object.keys(headers).length ? headers : undefined });
    const fired = new Set();
    await ctx.exposeFunction('__xh', (l) => { fired.add(String(l)); });   // stored-payload execution beacon
    const page = await ctx.newPage();
    page.on('dialog', (d) => { fired.add(`dialog:${d.type()}`); d.dismiss().catch(() => {}); });
    for (const url of liveUrls) {
      fired.clear();
      await page.goto(url, { timeout }).catch(() => {});
      await page.waitForLoadState('load', { timeout: Math.min(timeout, 8000) }).catch(() => {});
      await page.waitForTimeout(200);
      const dom = await page.content().catch(() => '');
      records.push({ url, text: dom, source: 'dom', executed: fired.size > 0 });
    }
  }
} catch (e) {
  emit({ ok: false, error: String((e && e.message) || e) });
  if (ctx) await ctx.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  process.exit(1);
} finally {
  if (ctx) await ctx.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
}

// ── classify + verdict ───────────────────────────────────────────────────────────────────────────────────
const surfaced_at = records.map(analyze).filter(Boolean);
const anyExec = surfaced_at.some((s) => s.executed);
const anyLikely = surfaced_at.some((s) => s.metachars_unencoded && EXEC_CTX.has(s.context));
const verdict = anyExec ? 'STORED XSS CONFIRMED'
  : anyLikely ? 'STORED XSS LIKELY (un-encoded cross-endpoint reflection)'
  : surfaced_at.length ? 'cross-endpoint reflection, encoded/inert'
  : 'marker not observed at any read endpoint';

const out = {
  ok: true, marker, canary_core: core, read_records: records.length,
  surfaced_at, reachable_sink: surfaced_at.some((s) => s.sink_reachable), verdict,
};
if (a.out) { await mkdir(a.out, { recursive: true }).catch(() => {}); await writeFile(path.join(a.out, 'marker-propagation.json'), JSON.stringify(out, null, 2)); }
emit(out);
process.exit(0);
