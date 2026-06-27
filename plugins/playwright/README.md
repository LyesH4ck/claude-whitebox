# playwright (MCP provider)

Provides the **Playwright MCP server** that the `pentest` plugin's client-side agents
(`xss-tester`, `csp-bypass-tester`, `prototype-pollution-tester`, `inventory-javascript-mapper`,
`pentester-executor`) depend on via the `mcp__plugin_playwright_playwright__*` tools.

It runs Microsoft's official [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) with a
**stealth-friendly default config** so browser-driven tests reach bot-protected (WAF) targets instead of
being blocked and silently logged as "couldn't confirm" coverage gaps.

## What the stealth config sets

`playwright-mcp-stealth.config.json` (loaded by `.mcp.json` via `--config`):

- **`launchOptions`** — `channel: "chrome"` (real Google Chrome, not bundled `HeadlessChrome`),
  `headless: false`, `--disable-blink-features=AutomationControlled`
- **`contextOptions`** — realistic `userAgent`, `viewport`, `locale`, `timezoneId`
- **`initScript`** — small `navigator.webdriver` / `window.chrome` patch

This defeats **JS-level** bot detection only — not TLS fingerprinting (JA3/JA4) or IP reputation. For
those, add a residential/proxy egress. **Authorized engagements only.**

## Install

```text
/plugin install playwright@claude-whitebox
```

Then confirm the tools registered with `/mcp` (expect `mcp__plugin_playwright_playwright__*`).

## Prerequisites

- **Google Chrome** installed (for `channel: "chrome"`).
- A **display** for headed mode — on a headless server use `xvfb-run`, or set `"headless": true` in the
  config (still better than bundled Chromium: the real-Chrome channel, UA and args remain).

## Tuning

Edit `playwright-mcp-stealth.config.json`:
- Different platform UA → match `channel`/`userAgent`/`timezoneId` consistently.
- Route through a proxy → add `--proxy-server` to `.mcp.json` args, or `launchOptions.proxy`.
- Disable stealth for debugging → set `"headless": true` and drop the `args`/`initScript`.
