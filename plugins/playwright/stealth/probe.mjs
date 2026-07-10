#!/usr/bin/env node
// Standalone stealth Playwright probe — Option B fallback for WAF-gated client-side testing.
// Runs full puppeteer-extra-stealth (more than the @playwright/mcp config can). A pentest agent
// calls this via Bash when the MCP browser is blocked. Authorized engagements ONLY.
//
// Output: exactly one JSON object on stdout. Evidence files (screenshots) under --out.
//
// Usage:
//   node probe.mjs --url <url> [--action navigate|evaluate|screenshot|capture-net|xss-probe]
//                  [--expr <js>] [--marker <str>] [--proxy http://host:port]
//                  [--out <dir>] [--no-headless] [--human] [--timeout 30000]
//
// xss-probe convention: build the request URL so the payload either pops a dialog
//   (e.g. ...?q=<script>alert(1)</script>) — caught via page.on('dialog') — or sets the
//   sentinel global, e.g. ...?q=<img src=x onerror="window.__probe_xss__=1"> — read back here.

import { parseArgs } from 'node:util';
import { mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const emit = (o) => { process.stdout.write(JSON.stringify(o) + '\n'); };

// Dependency guard — node_modules is not committed; first run needs an install.
try {
  await access(path.join(here, 'node_modules', 'playwright-extra'));
} catch {
  emit({ ok: false, error: 'deps_missing', hint: `run once: (cd ${here} && npm install)` });
  process.exit(2);
}

const { launch, newStealthContext } = await import('./browser.mjs');

let parsed;
try {
  parsed = parseArgs({
    allowNegative: true,   // so the documented --no-headless works (boolean negation)
    options: {
      url:      { type: 'string' },
      action:   { type: 'string', default: 'navigate' },
      expr:     { type: 'string' },
      marker:   { type: 'string' },
      payload:  { type: 'string' },
      proxy:    { type: 'string' },
      out:      { type: 'string', default: '.' },
      headless: { type: 'boolean', default: true },
      human:    { type: 'boolean', default: false },
      timeout:  { type: 'string', default: '30000' },
      insecure: { type: 'boolean', default: true },
    },
  });
} catch (e) {
  emit({ ok: false, error: `bad args: ${e.message}` });
  process.exit(2);
}
const a = parsed.values;
if (!a.url) { emit({ ok: false, error: 'missing --url' }); process.exit(2); }

const WAF = [
  /just a moment/i, /attention required/i, /cf-chl/i, /cf-browser-verification/i, /cloudflare/i,
  /captcha-delivery/i, /datadome/i, /access denied/i, /_incapsula_/i, /imperva/i,
  /request unsuccessful/i, /are you (a )?human/i, /verifying you are human/i, /perimeterx|px-captcha/i,
];

function detectBlock(status, html, title) {
  if ([401, 403, 429, 503].includes(status)) return { blocked: true, reason: `status ${status}` };
  const hay = `${title}\n${html.slice(0, 6000)}`;
  for (const r of WAF) if (r.test(hay)) return { blocked: true, reason: `marker ${r.source}` };
  return { blocked: false };
}

async function maybeHuman(page) {
  if (!a.human) return;
  try {
    for (let i = 0; i < 3; i++) {
      await page.mouse.move(200 + Math.random() * 600, 150 + Math.random() * 400, { steps: 15 });
      await page.waitForTimeout(120 + Math.random() * 300);
    }
    await page.mouse.wheel(0, 300 + Math.random() * 500);
    await page.waitForTimeout(200 + Math.random() * 400);
  } catch {}
}

const out = { ok: true, action: a.action, requestedUrl: a.url };
let browser;
try {
  browser = await launch({ headless: a.headless, proxy: a.proxy || null });
  const ctx = await newStealthContext(browser, { insecure: a.insecure });
  const page = await ctx.newPage();

  const dialogs = [];
  page.on('dialog', async (d) => {
    dialogs.push({ type: d.type(), message: d.message() });
    try { await d.dismiss(); } catch {}
  });

  const resp = await page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: +a.timeout });
  await maybeHuman(page);

  const status = resp ? resp.status() : 0;
  const html = await page.content();
  const title = await page.title().catch(() => '');
  Object.assign(out, { status, finalUrl: page.url(), title, htmlLen: html.length },
    detectBlock(status, html, title));

  if (a.action === 'navigate') {
    // baseline already captured above
  } else if (a.action === 'evaluate') {
    out.result = await page.evaluate(a.expr || '1');
  } else if (a.action === 'screenshot') {
    await mkdir(a.out, { recursive: true });
    const f = path.join(a.out, `stealth-${Date.now()}.png`);
    await page.screenshot({ path: f, fullPage: true });
    out.screenshot = f;
  } else if (a.action === 'capture-net') {
    out.network = await page.evaluate(() => (window.__probe_net__ || []).slice(0, 500));
  } else if (a.action === 'xss-probe') {
    const sentinel = await page.evaluate(() => (window.__probe_xss__ ?? null));
    out.executed = dialogs.length > 0 || sentinel != null;
    out.dialogs = dialogs;
    out.sentinel = sentinel;
    if (a.marker) {
      out.reflectedRaw = html.includes(a.marker);
      out.reflectedEncoded = html.includes(
        a.marker.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      );
      out.markerHasSpecials = /[<>"'`]/.test(a.marker);
    }
  } else {
    out.ok = false;
    out.error = `unknown action: ${a.action}`;
  }
} catch (e) {
  out.ok = false;
  out.error = String((e && e.message) || e);
} finally {
  if (browser) await browser.close().catch(() => {});
}

emit(out);
process.exit(out.ok ? 0 : 1);
