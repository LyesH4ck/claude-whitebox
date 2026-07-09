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

export async function newStealthContext(
  browser,
  { userAgent, insecure = true, extraHeaders, storageState, viewport } = {}
) {
  const ctx = await browser.newContext({
    userAgent: userAgent || DEFAULT_UA,
    viewport: viewport || { width: 1366, height: 900 },   // a REAL viewport — virtualized grids need one to request rows
    locale: 'en-US',
    timezoneId: 'America/New_York',
    ignoreHTTPSErrors: !!insecure,
    extraHTTPHeaders: extraHeaders || undefined,
    storageState: storageState || undefined,               // carry an authenticated session (Playwright storageState JSON)
  });
  await ctx.addInitScript({ content: INIT_SCRIPT });
  return ctx;
}
