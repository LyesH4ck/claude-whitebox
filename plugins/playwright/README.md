# playwright (MCP provider)

Provides the **Playwright MCP server** that the `pentest` plugin's client-side agents
(`xss-tester`, `csp-bypass-tester`, `prototype-pollution-tester`, `inventory-javascript-mapper`,
`pentester-executor`) depend on via the `mcp__plugin_playwright_playwright__*` tools.

It runs Microsoft's official [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) with a
**stealth-friendly default config** so browser-driven tests reach bot-protected (WAF) targets instead of
being blocked and silently logged as "couldn't confirm" coverage gaps.

## What the stealth config sets

`playwright-mcp-stealth.config.json` (loaded by `.mcp.json` via `--config`):

- **`launchOptions`** — `headless: true` with **bundled Chromium** (portable; runs on headless servers),
  plus `--disable-blink-features=AutomationControlled`
- **`contextOptions`** — realistic `userAgent`, `viewport`, `locale`, `timezoneId`
- **`initScript`** — `stealth-init.js`, a small `navigator.webdriver` / `window.chrome` patch
  (a **file path**, not inline JS — inline strings crash `@playwright/mcp` with "Init script file does not exist")

This portable default applies the **JS-level** stealth that works headless. It does **not** defeat TLS
fingerprinting (JA3/JA4), IP reputation, or the headless rendering tell. For maximum stealth on a
**desktop** (real Chrome + a display), edit `launchOptions`: set `"channel": "chrome"` and
`"headless": false` (see the `_maxstealth_hint` in the config). For TLS/IP, add a residential/proxy
egress. **Authorized engagements only.**

## Install

```text
/plugin install playwright@claude-whitebox
```

Then confirm the tools registered with `/mcp` (expect `mcp__plugin_playwright_playwright__*`).

## Prerequisites

- **Chromium for Playwright** installed once: `npx playwright install chromium`. The default config uses
  bundled Chromium so it runs anywhere (including headless servers) — no Google Chrome or display needed.
- For the **desktop max-stealth override** (`channel: "chrome"` + `headless: false`): real Google Chrome
  installed and a display (use `xvfb-run` on a server).

## The proxy is a hard dependency — check it first

`launchOptions.proxy` routes **Chromium** through the operator's intercepting proxy (capture is the default
posture here). It is not a stealth measure, and it is not the address of the MCP server. While it is set,
something must be listening there or **every** navigation dies with `net::ERR_PROXY_CONNECTION_FAILED` —
which is the only thing a driving agent sees, and it says nothing about the proxy.

```bash
node stealth/proxy-probe.mjs        # exit 0 = listening · 4 = configured but dead · 0 + listening:null = none configured
```

**Default is `http://127.0.0.1:8080`, matching this plugin's own launch.** `.mcp.json` starts
`npx @playwright/mcp` **natively**, so the server and the Chromium it drives are host processes and the proxy
is on loopback — macOS, Linux and WSL alike. Use `host.internal` / `host.docker.internal` **only** when the
MCP server itself runs inside an OrbStack/Docker container: those names resolve from inside a container and
nowhere else, so as a default they fail on a stock install.

| Where the MCP server runs | Proxy address |
|---|---|
| Natively on the host (this plugin's default) | `http://127.0.0.1:8080` |
| Inside an OrbStack/Docker container, proxy on the host | `http://host.internal:8080` |

Override without editing the file:

```bash
export PLAYWRIGHT_MCP_PROXY_SERVER=http://host.internal:8080   # then restart Claude Code
```

`@playwright/mcp` merges **config file < environment < CLI**, so the variable wins over the config (and
`--proxy-server` in `.mcp.json` would win over both). **A restart is required either way** — the config is
read once, at startup, so editing it and retrying the navigation changes nothing.

## Per-engagement User-Agent (`stealth/ua-sync.mjs`)

The shipped `userAgent` + `Sec-Ch-Ua*` headers are a stealth profile, and they lose to the engagement. A
Cloudflare `cf_clearance` — any UA-bound session — is issued against the exact User-Agent that solved the
challenge, so a session captured in Chrome 156 on macOS cannot be replayed by a browser claiming Chrome 124
on Linux.

```bash
# put the session's exact UA in .pentest-identities.json as "user_agent" (per identity, or top level)
node stealth/ua-sync.mjs --identities .pentest-identities.json     # then restart the MCP server
node stealth/ua-sync.mjs --revert                                  # back to the stealth profile
```

It writes the UA **and regenerates all three `Sec-Ch-Ua` headers from it** in the same pass, and it will not
do one without the other: per the config's `_clienthints_note` (established by replay through an intercepting
proxy) a UA/client-hint **mismatch** is more detectable than either value alone, so a hand-edited `userAgent`
is worse than the stock profile. A non-Chromium UA removes the three headers instead, because that is what
Firefox and Safari actually send.

## Tuning

Edit `playwright-mcp-stealth.config.json`:
- Max stealth on desktop → `launchOptions.channel: "chrome"`, `headless: false`.
- Different platform → keep `userAgent` / `timezoneId` consistent with each other, and regenerate the client
  hints with `stealth/ua-sync.mjs` rather than editing `Sec-Ch-Ua` by hand.
- Route through a different proxy → `PLAYWRIGHT_MCP_PROXY_SERVER` (above), or `launchOptions.proxy`.
- Disable stealth for debugging → drop the `args` and `initScript`.
- `initScript` entries are **file paths** relative to the config, not inline JS.
- **Every config change needs an MCP restart.** Nothing here is re-read while the server is running.

## Option B — full-stealth fallback (`stealth/`)

The MCP server (above) runs **vanilla** Playwright, so it can't load `puppeteer-extra-plugin-stealth`. When
a target's WAF still blocks the MCP browser, escalate to the standalone probe in **[`stealth/`](./stealth/)**:
it runs `playwright-extra` + the stealth plugin (full automation-tell coverage) and is driven via Bash,
returning JSON. See [`stealth/README.md`](./stealth/README.md). First use: `cd stealth && npm install`.

```bash
# Did stealth get past the WAF? then confirm an XSS, capture endpoints, grab evidence
node stealth/probe.mjs --url "https://target/app" --action navigate          # {"blocked":false,...}
node stealth/probe.mjs --url "https://target/s?q=<script>alert(1)</script>" --action xss-probe
```
