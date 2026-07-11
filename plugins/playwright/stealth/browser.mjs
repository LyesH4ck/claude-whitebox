// Stealth Playwright bootstrap — playwright-extra + puppeteer-extra-plugin-stealth.
// This is the full-coverage stealth (webdriver, chrome.*, permissions, plugins, languages,
// WebGL vendor/renderer, …) that @playwright/mcp (Option A) cannot load. Authorized use only.

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { INIT_SCRIPT } from './hooks.mjs';

chromium.use(StealthPlugin());

const DEFAULT_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export async function launch({ headless = true, proxy = null } = {}) {
  return chromium.launch({
    headless,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
    proxy: proxy ? { server: proxy } : undefined,
  });
}

// P0 — a `--cookie` string must be injected as REAL cookies (ctx.addCookies), NOT as an `extraHTTPHeaders.Cookie`
// header. On HTTPS-through-a-proxy the browser silently DROPS a manual Cookie header on the wire, and it never
// populates `document.cookie` — so a SPA's client-side auth guard reads no cookie and redirects to /login. Real
// cookies are sent on the wire AND visible to JS, so the app authenticates. (Matches the working reference crawler.)
// A leading-dot domain (`.example.com`) authenticates every in-scope subdomain; an IP/localhost can't take one.
export function cookieDomainFor(scope) {
  const s = String(scope || '').trim().toLowerCase().replace(/^\./, '');
  if (!s) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s) || !s.includes('.')) return s;   // IP or single-label host → exact domain
  return '.' + s;                                                        // registrable domain → all subdomains
}
export function parseCookieString(raw, scope) {
  const domain = cookieDomainFor(scope);
  if (!raw || !domain) return [];
  const out = [];
  for (const part of String(raw).split(/;\s*/)) {           // "a=1; b=2" → pairs (split BEFORE the first '=' only:
    const i = part.indexOf('=');                            // a value may itself contain '=', e.g. a base64 JWT)
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    if (!name) continue;
    out.push({ name, value: part.slice(i + 1), domain, path: '/', sameSite: 'Lax' });
  }
  return out;
}

export async function newStealthContext(
  browser,
  { userAgent, insecure = true, extraHeaders, storageState, viewport, cookie, cookieScope } = {}
) {
  const ctx = await browser.newContext({
    userAgent: userAgent || DEFAULT_UA,
    viewport: viewport || { width: 1366, height: 900 },   // a REAL viewport — virtualized grids need one to request rows
    locale: 'en-US',
    timezoneId: 'America/New_York',
    ignoreHTTPSErrors: !!insecure,
    extraHTTPHeaders: extraHeaders || undefined,           // --header ONLY (Authorization Bearer etc. — browser-honored)
    storageState: storageState || undefined,               // carry an authenticated session (Playwright storageState JSON)
  });
  await ctx.addInitScript({ content: INIT_SCRIPT });
  // Inject --cookie as real cookies. Add per-cookie (a name with '@'/'.' that Playwright rejects must not fail the lot).
  if (cookie) {
    for (const c of parseCookieString(cookie, cookieScope)) { try { await ctx.addCookies([c]); } catch { /* skip invalid cookie */ } }
  }
  return ctx;
}
