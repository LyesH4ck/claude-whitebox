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

## Tuning

Edit `playwright-mcp-stealth.config.json`:
- Max stealth on desktop → `launchOptions.channel: "chrome"`, `headless: false`.
- Different platform → keep `userAgent` / `timezoneId` consistent with each other.
- Route through a proxy → add `--proxy-server` to `.mcp.json` args, or `launchOptions.proxy`.
- Disable stealth for debugging → drop the `args` and `initScript`.
- `initScript` entries are **file paths** relative to the config, not inline JS.
