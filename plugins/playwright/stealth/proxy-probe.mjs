#!/usr/bin/env node
// proxy-probe — is the proxy this plugin's config DEPENDS ON actually listening?
//
// Why this exists. `playwright-mcp-stealth.config.json` sets `launchOptions.proxy`, which is a hard
// dependency: with nothing listening at that address, EVERY navigation fails with
// `net::ERR_PROXY_CONNECTION_FAILED` — and that is the only thing the agent sees. On a real engagement three
// executors each hit the wall independently, mid-task, hours in, and each spent time theorising about the
// target before suspecting their own transport. The dependency was declared and never checked.
//
// A TCP connect is one line of code and turns an opaque browser error discovered at depth into a sentence
// read before any work is dispatched.
//
// It resolves the address the way @playwright/mcp does — config file < PLAYWRIGHT_MCP_PROXY_SERVER — so what
// it probes is what Chromium will use. It does NOT send an HTTP request: a CONNECT-only proxy, an
// authenticating proxy and an idle Burp all answer a TCP handshake, and anything beyond that would start
// judging the proxy's behaviour rather than its presence.
//
// Usage:
//   node proxy-probe.mjs [--config <path>] [--timeout 2000] [--json]
// Exit codes: 0 = listening (or: no proxy configured, so nothing to satisfy) · 2 = bad args / unreadable
//             config · 4 = a proxy IS configured and nothing is listening there
// Zero deps (Node 18+).

import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const emit = (o) => process.stdout.write(JSON.stringify(o, null, 2) + '\n');

let a;
try {
  ({ values: a } = parseArgs({ options: {
    config: { type: 'string' },
    timeout: { type: 'string' },
    json: { type: 'boolean', default: false },
  } }));
} catch (e) { emit({ ok: false, error: `bad args: ${e.message}` }); process.exit(2); }

const configPath = a.config || path.join(HERE, '..', 'playwright-mcp-stealth.config.json');
const timeout = a.timeout ? Number(a.timeout) : 2000;

let cfg = null;
try { cfg = JSON.parse(await readFile(configPath, 'utf8')); }
catch (e) {
  emit({ ok: false, error: `cannot read the stealth config: ${e.message}`, config: configPath });
  process.exit(2);
}

// Same precedence as @playwright/mcp's own resolution: config file, then the environment. (A --proxy-server
// on the MCP command line would win over both; it is reported here so the discrepancy is at least visible.)
const fromConfig = cfg?.browser?.launchOptions?.proxy?.server || null;
const fromEnv = process.env.PLAYWRIGHT_MCP_PROXY_SERVER || null;
const server = fromEnv || fromConfig;

if (!server) {
  emit({ ok: true, listening: null, proxy: null, source: 'none',
    note: 'No proxy configured, so there is no dependency to satisfy. Chromium will connect to targets directly and the traffic will NOT be captured.' });
  process.exit(0);
}

// `http://host:port`, `socks5://host:port`, or a bare `host:port`.
let host, port;
try {
  const u = new URL(/^\w+:\/\//.test(server) ? server : `http://${server}`);
  host = u.hostname;
  port = Number(u.port || (u.protocol === 'https:' ? 443 : 8080));
} catch {
  emit({ ok: false, error: `cannot parse the proxy address "${server}"`, config: configPath });
  process.exit(2);
}

const result = await new Promise((resolve) => {
  const s = new net.Socket();
  const done = (listening, error) => { s.destroy(); resolve({ listening, error }); };
  s.setTimeout(timeout);
  s.once('connect', () => done(true, null));
  s.once('timeout', () => done(false, `no response within ${timeout}ms`));
  s.once('error', (e) => done(false, e.code || e.message));
  s.connect(port, host);
});

const containerName = /^host\.(docker\.)?internal$/i.test(host);
const report = {
  ok: true, listening: result.listening, proxy: server, host, port,
  source: fromEnv ? 'PLAYWRIGHT_MCP_PROXY_SERVER' : 'config file', config: configPath,
  ...(fromEnv && fromConfig && fromEnv !== fromConfig ? { overriding: fromConfig } : {}),
  ...(result.error ? { error: result.error } : {}),
  note: result.listening
    ? 'A proxy is listening. Chromium can reach it, so a navigation failure after this is about the target or the config, not the transport.'
    : `NOTHING IS LISTENING at ${host}:${port}. Every browser navigation will fail with net::ERR_PROXY_CONNECTION_FAILED, which is the error the AGENT sees — it says nothing about the proxy. Start the proxy, or point the config/PLAYWRIGHT_MCP_PROXY_SERVER somewhere that is up. THEN RESTART THE MCP SERVER: the config is read once at startup, so editing it and retrying the navigation changes nothing.`
    + (containerName
      ? ` "${host}" only resolves from INSIDE an OrbStack/Docker container. This plugin's .mcp.json launches @playwright/mcp natively, so the browser is a host process and that name cannot resolve — use 127.0.0.1.`
      : ''),
};
emit(report);
process.exit(result.listening ? 0 : 4);
