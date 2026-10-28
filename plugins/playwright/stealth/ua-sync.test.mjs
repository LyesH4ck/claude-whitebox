// Proof for ua-sync.mjs — the per-engagement User-Agent override, and the guard that keeps it honest.
//
// Two requirements pull against each other and both must hold. (1) A UA-bound session (cf_clearance) is only
// replayable under the exact UA that earned it, so the engagement's UA must beat the stealth profile.
// (2) Per `_clienthints_note`, a UA/client-hint mismatch is MORE detectable than either value alone — so the
// override must never ship a new UA beside stale Sec-Ch-Ua headers. The write is therefore atomic in intent:
// UA and all three hints, or nothing.
// Zero deps, zero network.
//
// Run:  node --test ua-sync.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, 'ua-sync.mjs');

const STEALTH_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

function run(args) {
  return new Promise((resolve) => {
    execFile('node', [TOOL, ...args], { timeout: 20000 }, (err, stdout) => {
      let json = null;
      try { json = JSON.parse(String(stdout).trim()); } catch { /* leave null */ }
      resolve({ code: err ? (err.code ?? 1) : 0, json });
    });
  });
}

async function scaffold({ identities } = {}) {
  const d = await mkdtemp(path.join(os.tmpdir(), 'uasync-'));
  const cfg = path.join(d, 'config.json');
  await writeFile(cfg, JSON.stringify({
    browser: { launchOptions: {}, contextOptions: {
      userAgent: STEALTH_UA,
      extraHTTPHeaders: {
        'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Linux"',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    } },
  }, null, 2));
  const idf = path.join(d, '.pentest-identities.json');
  if (identities) await writeFile(idf, JSON.stringify(identities));
  return { d, cfg, idf };
}
const readCfg = async (p) => JSON.parse(await readFile(p, 'utf8'));

test('the engagement UA wins, and all three client hints are regenerated WITH it', async () => {
  const { d, cfg } = await scaffold();
  try {
    const r = await run(['--config', cfg, '--ua', MAC_UA]);
    assert.equal(r.code, 0);
    const c = (await readCfg(cfg)).browser.contextOptions;
    assert.equal(c.userAgent, MAC_UA, 'the session constraint beats the stealth preference');
    assert.match(c.extraHTTPHeaders['Sec-Ch-Ua'], /"Google Chrome";v="156"/, 'version follows the UA');
    assert.ok(!c.extraHTTPHeaders['Sec-Ch-Ua'].includes('124'), 'and the old version is gone');
    assert.equal(c.extraHTTPHeaders['Sec-Ch-Ua-Platform'], '"macOS"', 'platform follows the UA');
    assert.equal(c.extraHTTPHeaders['Sec-Ch-Ua-Mobile'], '?0');
    assert.equal(c.extraHTTPHeaders['Accept-Language'], 'en-US,en;q=0.9', 'unrelated headers untouched');
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('no stale hint can survive beside a new UA — the mismatch guard', async () => {
  const { d, cfg } = await scaffold();
  try {
    await run(['--config', cfg, '--ua', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36']);
    const h = (await readCfg(cfg)).browser.contextOptions.extraHTTPHeaders;
    assert.equal(h['Sec-Ch-Ua-Platform'], '"Windows"');
    assert.match(h['Sec-Ch-Ua'], /v="140"/);
    // every hint present in the file agrees with the UA now in the file
    assert.ok(!JSON.stringify(h).includes('Linux'));
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('a non-Chromium UA REMOVES the hints instead of lying with them', async () => {
  const { d, cfg } = await scaffold();
  try {
    const ff = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0';
    const r = await run(['--config', cfg, '--ua', ff]);
    assert.equal(r.code, 0);
    assert.equal(r.json.client_hints_removed, true);
    const h = (await readCfg(cfg)).browser.contextOptions.extraHTTPHeaders;
    assert.equal(h['Sec-Ch-Ua'], undefined, 'Firefox sends none — sending Chrome hints would be the mismatch');
    assert.equal(h['Sec-Ch-Ua-Platform'], undefined);
    assert.equal(h['Accept-Language'], 'en-US,en;q=0.9');
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('the UA is read from .pentest-identities.json — per identity, or top level', async () => {
  const { d, cfg, idf } = await scaffold({ identities: {
    identities: [{ label: 'unauth' }, { label: 'userA', user_agent: MAC_UA }],
  } });
  try {
    const r = await run(['--config', cfg, '--identities', idf]);
    assert.equal(r.code, 0);
    assert.match(r.json.source, /identities\[userA\]\.user_agent/);
    assert.equal((await readCfg(cfg)).browser.contextOptions.userAgent, MAC_UA);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('--identity picks a specific principal, and an unknown label is refused', async () => {
  const { d, cfg, idf } = await scaffold({ identities: {
    identities: [{ label: 'userA', user_agent: MAC_UA }, { label: 'userB', user_agent: STEALTH_UA }],
  } });
  try {
    const b = await run(['--config', cfg, '--identities', idf, '--identity', 'userB']);
    assert.equal(b.code, 0);
    assert.equal((await readCfg(cfg)).browser.contextOptions.userAgent, STEALTH_UA);
    const bad = await run(['--config', cfg, '--identities', idf, '--identity', 'userZ']);
    assert.equal(bad.code, 2);
    assert.deepEqual(bad.json.labels, ['userA', 'userB']);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('NO UA to apply is exit 3 and says why that is dangerous, not "nothing to do"', async () => {
  const { d, cfg, idf } = await scaffold({ identities: { identities: [{ label: 'userA', headers: {} }] } });
  try {
    const r = await run(['--config', cfg, '--identities', idf]);
    assert.equal(r.code, 3);
    assert.equal(r.json.ok, false);
    assert.match(r.json.note, /indistinguishable from an expired session/);
    assert.equal((await readCfg(cfg)).browser.contextOptions.userAgent, STEALTH_UA, 'and nothing was written');
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('--revert restores the shipped stealth profile exactly', async () => {
  const { d, cfg } = await scaffold();
  try {
    await run(['--config', cfg, '--ua', MAC_UA]);
    const r = await run(['--config', cfg, '--revert']);
    assert.equal(r.code, 0);
    const c = (await readCfg(cfg)).browser.contextOptions;
    assert.equal(c.userAgent, STEALTH_UA);
    assert.equal(c.extraHTTPHeaders['Sec-Ch-Ua-Platform'], '"Linux"');
    assert.match(c.extraHTTPHeaders['Sec-Ch-Ua'], /v="124"/);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('--json reports without writing (safe to inspect before committing to it)', async () => {
  const { d, cfg } = await scaffold();
  try {
    const r = await run(['--config', cfg, '--ua', MAC_UA, '--json']);
    assert.equal(r.code, 0);
    assert.equal(r.json.written, false);
    assert.equal((await readCfg(cfg)).browser.contextOptions.userAgent, STEALTH_UA);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('every path states the restart requirement — editing the config is not enough', async () => {
  const { d, cfg } = await scaffold();
  try {
    const applied = await run(['--config', cfg, '--ua', MAC_UA]);
    const reverted = await run(['--config', cfg, '--revert']);
    for (const r of [applied, reverted]) assert.match(r.json.note, /RESTART THE MCP SERVER/);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('a mobile UA sets Sec-Ch-Ua-Mobile correctly', async () => {
  const { d, cfg } = await scaffold();
  try {
    const r = await run(['--config', cfg, '--json',
      '--ua', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36']);
    assert.equal(r.json.client_hints['Sec-Ch-Ua-Mobile'], '?1');
    assert.equal(r.json.client_hints['Sec-Ch-Ua-Platform'], '"Android"');
  } finally { await rm(d, { recursive: true, force: true }); }
});
