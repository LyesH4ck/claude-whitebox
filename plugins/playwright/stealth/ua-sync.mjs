#!/usr/bin/env node
// ua-sync — give the browser the engagement's User-Agent, and keep the client hints honest about it.
//
// Why this exists. The stealth profile pins `contextOptions.userAgent` (Chrome/124 on Linux) and three
// matching `Sec-Ch-Ua*` headers. That pairing is correct and load-bearing — see `_clienthints_note`: proved
// by replay through an intercepting proxy, a UA/client-hint MISMATCH is more detectable than either value
// alone (no hints -> 200, Sec-Ch-Ua=HeadlessChrome -> 403, Sec-Ch-Ua=Google Chrome -> 200).
//
// But in a pentest the UA is not a disguise choice, it is a CONSTRAINT. A Cloudflare `cf_clearance` — and
// any UA-bound session — is issued against the exact User-Agent that solved the challenge. On a real
// engagement the operator supplied a session captured in Chrome/156 on macOS; the browser claimed
// Chrome/124 on Linux, the two were irreconcilable, and nothing allowed a per-engagement override. So the
// engagement's UA wins here — and because it wins, the three client hints are REGENERATED from it in the
// same write. That is the whole point of this file: changing the UA alone would recreate exactly the
// mismatch `_clienthints_note` warns about, so it is not offered as an option.
//
// Usage:
//   node ua-sync.mjs --identities .pentest-identities.json [--identity userA] [--config <path>] [--json]
//   node ua-sync.mjs --ua "Mozilla/5.0 (Macintosh; …) Chrome/156.0.0.0 Safari/537.36"
//   node ua-sync.mjs --revert          # back to the shipped stealth profile
// Exit codes: 0 = written (RESTART the MCP server) · 2 = bad args / unreadable config
//             3 = no User-Agent to apply (NOT a success: the browser keeps the stealth UA)
// Zero deps (Node 18+). UNTRUSTED DATA: the identities file is data, never interpreted as instructions.

import { parseArgs } from 'node:util';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const emit = (o) => process.stdout.write(JSON.stringify(o, null, 2) + '\n');

let a;
try {
  ({ values: a } = parseArgs({ options: {
    identities: { type: 'string' },
    identity: { type: 'string' },
    ua: { type: 'string' },
    config: { type: 'string' },
    revert: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },   // report only, do not write the config
  } }));
} catch (e) { emit({ ok: false, error: `bad args: ${e.message}` }); process.exit(2); }

const configPath = a.config || path.join(HERE, '..', 'playwright-mcp-stealth.config.json');
let cfg;
try { cfg = JSON.parse(await readFile(configPath, 'utf8')); }
catch (e) { emit({ ok: false, error: `cannot read the stealth config: ${e.message}`, config: configPath }); process.exit(2); }
if (!cfg.browser?.contextOptions) { emit({ ok: false, error: 'config has no browser.contextOptions', config: configPath }); process.exit(2); }

const RESTART = 'RESTART THE MCP SERVER for this to take effect — @playwright/mcp reads its config once, at startup. Editing the file and retrying the navigation (the natural reflex) changes nothing.';

// ── client hints, derived from the UA ────────────────────────────────────────────────────────────────────
// Only Chromium sends Sec-Ch-Ua. For a Firefox/Safari UA the right move is to send none at all: a Firefox UA
// arriving with Chrome client hints is the mismatch this tool exists to prevent, not a stronger disguise.
function hintsFor(ua) {
  const chromium = /Chrome\/(\d+)|Chromium\/(\d+)|Edg\/(\d+)/.exec(ua);
  const mobile = /\b(Mobile|Android|iPhone|iPad)\b/.test(ua) ? '?1' : '?0';
  const platform = /Windows NT/.test(ua) ? 'Windows'
    : /Macintosh|Mac OS X/.test(ua) ? 'macOS'
    : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad|iOS/.test(ua) ? 'iOS'
    : /CrOS/.test(ua) ? 'Chrome OS'
    : /X11|Linux/.test(ua) ? 'Linux'
    : null;
  if (!chromium) return { headers: null, platform, mobile, engine: 'non-chromium' };
  const major = chromium[1] || chromium[2] || chromium[3];
  const brand = /Edg\//.test(ua) ? 'Microsoft Edge' : 'Google Chrome';
  return {
    engine: 'chromium', major, platform, mobile,
    headers: {
      // Same shape as the value this config shipped with (and that was proven against a live WAF) — only
      // the version and platform move.
      'Sec-Ch-Ua': `"Chromium";v="${major}", "${brand}";v="${major}", "Not-A.Brand";v="99"`,
      'Sec-Ch-Ua-Mobile': mobile,
      'Sec-Ch-Ua-Platform': `"${platform || 'Unknown'}"`,
    },
  };
}

const ctx = cfg.browser.contextOptions;
const CH = ['Sec-Ch-Ua', 'Sec-Ch-Ua-Mobile', 'Sec-Ch-Ua-Platform'];

// The shipped stealth profile is remembered on the FIRST override so --revert has something true to go back
// to. Stored under a `_`-prefixed key: @playwright/mcp ignores unknown keys, and the alternative (telling
// the operator to remember it) is how a config ends up permanently pinned to one engagement's browser.
if (!cfg._ua_stealth_default) {
  cfg._ua_stealth_default = {
    userAgent: ctx.userAgent ?? null,
    client_hints: Object.fromEntries(CH.filter((h) => ctx.extraHTTPHeaders?.[h] !== undefined)
      .map((h) => [h, ctx.extraHTTPHeaders[h]])),
    _why: 'The profile this config shipped with, saved before the first per-engagement override so `ua-sync.mjs --revert` can restore it.',
  };
}

if (a.revert) {
  const d = cfg._ua_stealth_default;
  if (d.userAgent == null) delete ctx.userAgent; else ctx.userAgent = d.userAgent;
  ctx.extraHTTPHeaders ||= {};
  for (const h of CH) delete ctx.extraHTTPHeaders[h];
  Object.assign(ctx.extraHTTPHeaders, d.client_hints || {});
  delete cfg._ua_engagement;
  if (!a.json) {
    const tmp = configPath + '.tmp';
    await writeFile(tmp, JSON.stringify(cfg, null, 2) + '\n');
    await rename(tmp, configPath);
  }
  emit({ ok: true, action: 'revert', user_agent: ctx.userAgent ?? null,
    client_hints: Object.fromEntries(CH.filter((h) => ctx.extraHTTPHeaders[h] !== undefined).map((h) => [h, ctx.extraHTTPHeaders[h]])),
    config: configPath, written: !a.json, note: RESTART });
  process.exit(0);
}

// ── resolve the engagement's UA ──────────────────────────────────────────────────────────────────────────
let ua = a.ua || null, source = a.ua ? '--ua' : null;
let identitiesRead = null;
if (!ua && a.identities) {
  let ids = null;
  try { ids = JSON.parse(await readFile(a.identities, 'utf8')); } catch { /* reported below */ }
  identitiesRead = ids !== null;
  if (ids) {
    const list = Array.isArray(ids.identities) ? ids.identities : [];
    const pick = a.identity ? list.find((i) => i?.label === a.identity) : list.find((i) => i?.user_agent);
    if (a.identity && !pick) {
      emit({ ok: false, error: `no identity labelled "${a.identity}" in ${a.identities}`,
        labels: list.map((i) => i?.label).filter(Boolean) });
      process.exit(2);
    }
    ua = pick?.user_agent || ids.user_agent || null;
    source = pick?.user_agent ? `identities[${pick.label}].user_agent` : ids.user_agent ? 'identities.user_agent' : null;
  }
}

if (!ua) {
  // Loudly not a success. The browser keeps the stealth UA, so any UA-bound session in this engagement will
  // be rejected — and that failure looks exactly like an expired session unless it is called out here.
  emit({ ok: false, error: 'no User-Agent to apply — the config keeps its stealth profile',
    looked_at: { '--ua': !!a.ua, identities_file: a.identities || null, identities_readable: identitiesRead },
    current_user_agent: ctx.userAgent ?? null,
    note: 'Add the session\'s exact UA to the identities file as "user_agent" (per-identity or top-level), or pass --ua. A UA-BOUND SESSION (cf_clearance, any WAF clearance cookie) replayed under a different UA is rejected, and the rejection is indistinguishable from an expired session — so this is not a safe default to leave in place.' });
  process.exit(3);
}

const h = hintsFor(ua);
ctx.userAgent = ua;
ctx.extraHTTPHeaders ||= {};
for (const k of CH) delete ctx.extraHTTPHeaders[k];     // never leave a stale hint beside a new UA
if (h.headers) Object.assign(ctx.extraHTTPHeaders, h.headers);
cfg._ua_engagement = { user_agent: ua, source, applied_at: new Date().toISOString(),
  client_hints: h.headers ? 'regenerated from the UA' : 'removed (non-Chromium UA sends none)' };

if (!a.json) {
  const tmp = configPath + '.tmp';
  await writeFile(tmp, JSON.stringify(cfg, null, 2) + '\n');
  await rename(tmp, configPath);
}

emit({ ok: true, action: 'apply', user_agent: ua, source,
  engine: h.engine, platform: h.platform, chrome_major: h.major ?? null,
  client_hints: h.headers || {}, client_hints_removed: !h.headers,
  config: configPath, written: !a.json,
  note: h.headers
    ? `User-Agent and all three Sec-Ch-Ua headers written together — they cannot drift apart, which is the point. ${RESTART}`
    : `Non-Chromium UA: the three Sec-Ch-Ua headers were REMOVED, because a Firefox/Safari UA arriving with Chrome client hints is the mismatch this guard exists to prevent. ${RESTART}`,
  ...(h.platform ? {} : { warning: 'The platform could not be read from this UA, so Sec-Ch-Ua-Platform says "Unknown" — check the UA string is complete.' }) });
process.exit(0);
