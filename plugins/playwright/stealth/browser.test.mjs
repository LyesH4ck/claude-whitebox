// Tests for the stealth browser bootstrap — focused on P0: `--cookie` must be injected as a REAL cookie
// (ctx.addCookies), visible to `document.cookie` AND sent on the wire, not as a dropped `extraHTTPHeaders.Cookie`
// header. The document.cookie check is the CI-safe discriminator: with the old header path it is EMPTY.
// Run:  node --test browser.test.mjs   (launches headless chromium via the stealth deps)

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEPS = existsSync(path.join(HERE, 'node_modules', 'playwright-extra'));

import { parseCookieString, cookieDomainFor } from './browser.mjs';

test('cookieDomainFor: registrable domain → leading-dot; IP/localhost → exact (no leading dot is valid)', () => {
  assert.equal(cookieDomainFor('demo.example.com'), '.demo.example.com');
  assert.equal(cookieDomainFor('.demo.example.com'), '.demo.example.com');   // idempotent on a pre-dotted scope
  assert.equal(cookieDomainFor('127.0.0.1'), '127.0.0.1');                    // an IP cannot take a leading dot
  assert.equal(cookieDomainFor('localhost'), 'localhost');
  assert.equal(cookieDomainFor(''), null);
});

test('parseCookieString: splits pairs, keeps "=" inside a value (JWT), stamps domain/path', () => {
  const c = parseCookieString('BEARER=ab.cd=; sess=1', 'demo.example.com');
  assert.equal(c.length, 2);
  assert.deepEqual(c[0], { name: 'BEARER', value: 'ab.cd=', domain: '.demo.example.com', path: '/', sameSite: 'Lax' });
  assert.equal(c[1].name, 'sess');
  assert.equal(parseCookieString('', 'x.com').length, 0);
  assert.equal(parseCookieString('novalue', 'x.com').length, 0);            // no '=' → skipped, not a crash
});

test('P0: --cookie is a REAL cookie — visible to document.cookie AND sent on the wire (not a dropped header)', { skip: !DEPS && 'stealth deps missing' }, async () => {
  const { launch, newStealthContext } = await import('./browser.mjs');
  let seen = null;
  const server = http.createServer((req, res) => { seen = req.headers.cookie || null; res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><html><body>ok</body></html>'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await launch({ headless: true });
  try {
    const ctx = await newStealthContext(browser, { cookie: 'PROBE=HELLO; s=1', cookieScope: '127.0.0.1' });
    const page = await ctx.newPage();
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    const docCookie = await page.evaluate(() => document.cookie);
    // *** the discriminator *** — with the old `extraHTTPHeaders.Cookie` path this is EMPTY (headers don't populate
    // document.cookie, and the SPA guard reads document.cookie → login redirect).
    assert.match(docCookie, /PROBE=HELLO/, `cookie visible to document.cookie (got "${docCookie}")`);
    assert.ok(seen && /PROBE=HELLO/.test(seen), `cookie sent on the wire (server saw: ${seen})`);
  } finally { await browser.close().catch(() => {}); server.close(); }
});
