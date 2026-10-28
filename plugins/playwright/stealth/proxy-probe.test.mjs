// Proof for proxy-probe.mjs — the startup check for the config's one hard dependency.
//
// The config declares `launchOptions.proxy` and nothing ever verified it, so a dead proxy surfaced as
// `net::ERR_PROXY_CONNECTION_FAILED` inside an agent's work, three times on one engagement. What is under
// test: a listening proxy passes, a dead address fails with a non-zero exit, no proxy configured is not a
// failure, the environment override is honoured the way @playwright/mcp honours it, and a container-only
// hostname gets named as such.
// Zero deps, zero network beyond a loopback server this test starts itself.
//
// Run:  node --test proxy-probe.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, 'proxy-probe.mjs');

function run(args, env = {}) {
  return new Promise((resolve) => {
    execFile('node', [TOOL, ...args], { timeout: 20000, env: { ...process.env, ...env } }, (err, stdout) => {
      let json = null;
      try { json = JSON.parse(String(stdout).trim()); } catch { /* leave null */ }
      resolve({ code: err ? (err.code ?? 1) : 0, json });
    });
  });
}

async function cfgWith(proxy) {
  const d = await mkdtemp(path.join(os.tmpdir(), 'probe-'));
  const p = path.join(d, 'config.json');
  await writeFile(p, JSON.stringify({
    browser: { launchOptions: proxy ? { proxy: { server: proxy } } : {}, contextOptions: {} },
  }));
  return { d, p };
}

// A listener that accepts and immediately drops: enough to answer the TCP handshake, which is all the probe
// asks. An idle Burp, a CONNECT-only proxy and an authenticating proxy all behave this way.
function listen() {
  return new Promise((resolve) => {
    const srv = net.createServer((s) => s.destroy());
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

test('a listening proxy passes', async () => {
  const { srv, port } = await listen();
  const { d, p } = await cfgWith(`http://127.0.0.1:${port}`);
  try {
    const r = await run(['--config', p]);
    assert.equal(r.code, 0);
    assert.equal(r.json.listening, true);
    assert.equal(r.json.port, port);
  } finally { srv.close(); await rm(d, { recursive: true, force: true }); }
});

test('a dead address FAILS with exit 4 and names the error the agent would otherwise see', async () => {
  // port 1 on loopback: nothing listens there, and the connect is refused immediately
  const { d, p } = await cfgWith('http://127.0.0.1:1');
  try {
    const r = await run(['--config', p, '--timeout', '1500']);
    assert.equal(r.code, 4, 'the dependency is unsatisfied — that must not be a zero exit');
    assert.equal(r.json.listening, false);
    assert.match(r.json.note, /ERR_PROXY_CONNECTION_FAILED/);
    assert.match(r.json.note, /RESTART THE MCP SERVER/, 'and the part everyone forgets');
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('no proxy configured is not a failure — there is no dependency to satisfy', async () => {
  const { d, p } = await cfgWith(null);
  try {
    const r = await run(['--config', p]);
    assert.equal(r.code, 0);
    assert.equal(r.json.listening, null);
    assert.match(r.json.note, /will NOT be captured/, 'but the loss of capture is still stated');
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('PLAYWRIGHT_MCP_PROXY_SERVER wins, exactly as @playwright/mcp merges it', async () => {
  const { srv, port } = await listen();
  const { d, p } = await cfgWith('http://127.0.0.1:1');       // the config points at a dead address
  try {
    const r = await run(['--config', p], { PLAYWRIGHT_MCP_PROXY_SERVER: `http://127.0.0.1:${port}` });
    assert.equal(r.code, 0, 'the environment override is what Chromium will use, so it is what we probe');
    assert.equal(r.json.source, 'PLAYWRIGHT_MCP_PROXY_SERVER');
    assert.equal(r.json.overriding, 'http://127.0.0.1:1', 'and the shadowed config value is reported');
  } finally { srv.close(); await rm(d, { recursive: true, force: true }); }
});

test('a container-only hostname is diagnosed, not just reported as down', async () => {
  // Port 1, so the outcome does not depend on whether this machine happens to resolve host.internal (an
  // OrbStack Linux VM does; a macOS or CI host does not) or on what is listening on 8080.
  const { d, p } = await cfgWith('http://host.internal:1');
  try {
    const r = await run(['--config', p, '--timeout', '1500']);
    assert.equal(r.code, 4);
    assert.match(r.json.note, /only resolves from INSIDE an OrbStack\/Docker container/);
    assert.match(r.json.note, /use 127\.0\.0\.1/);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('a bare host:port and a socks5 URL both parse', async () => {
  const { srv, port } = await listen();
  const bare = await cfgWith(`127.0.0.1:${port}`);
  const socks = await cfgWith(`socks5://127.0.0.1:${port}`);
  try {
    assert.equal((await run(['--config', bare.p])).code, 0);
    assert.equal((await run(['--config', socks.p])).code, 0);
  } finally {
    srv.close();
    await rm(bare.d, { recursive: true, force: true });
    await rm(socks.d, { recursive: true, force: true });
  }
});

test('an unreadable config is exit 2 — a measurement failure, not a verdict about the proxy', async () => {
  const r = await run(['--config', path.join(os.tmpdir(), 'does-not-exist-probe.json')]);
  assert.equal(r.code, 2);
  assert.equal(r.json.ok, false);
});

test('the SHIPPED config points at a native-launch address, not a container-only name', async () => {
  // Regression guard for the real defect: .mcp.json launches @playwright/mcp natively, so a default of
  // host.internal cannot resolve on macOS or Linux and every navigation fails on a stock install.
  const shipped = JSON.parse(await (await import('node:fs/promises')).readFile(
    path.join(HERE, '..', 'playwright-mcp-stealth.config.json'), 'utf8'));
  const server = shipped.browser.launchOptions.proxy.server;
  assert.match(server, /^http:\/\/127\.0\.0\.1:\d+$/, `shipped proxy default must be loopback, got ${server}`);
  assert.match(shipped._proxy_note, /PLAYWRIGHT_MCP_PROXY_SERVER/, 'and the override must be documented');
  assert.match(shipped._proxy_note, /RESTART/i, 'as must the restart requirement');
});
