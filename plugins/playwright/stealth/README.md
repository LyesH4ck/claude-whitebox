# stealth/ — standalone stealth probe (Option B)

Full-coverage stealth browser, **independent of the MCP server**. Use this when the Option-A MCP browser
gets **blocked by a WAF / bot-detection** (Cloudflare challenge, DataDome, Akamai, PerimeterX…). It runs
`playwright-extra` + `puppeteer-extra-plugin-stealth`, which patches far more automation tells
(`navigator.plugins`/`languages`, `window.chrome.*`, WebGL vendor/renderer, permissions consistency, …)
than the `@playwright/mcp` config can.

**Authorized engagements only.** Evading bot-detection is in scope only when the assessment authorizes it.

## Setup (once)

```bash
cd "$CLAUDE_PLUGIN_ROOT/stealth"   # or the plugin's installed path
npm install
# Chromium for Playwright: npx playwright install chromium   (if not already present)
```

`node_modules/` is not committed — first run needs the install. `probe.mjs` emits
`{"ok":false,"error":"deps_missing","hint":"..."}` if you skip it.

## Usage

```bash
node probe.mjs --url <URL> [--action <action>] [options]
```

Output: exactly **one JSON object on stdout** (parse it). Evidence (screenshots) under `--out`.

| Action | What it returns |
|--------|-----------------|
| `navigate` (default) | `status`, `finalUrl`, `title`, `htmlLen`, and **`blocked` + `reason`** (WAF heuristic) |
| `evaluate` | `result` of `--expr` (a JS expression) — e.g. read a reflected marker |
| `screenshot` | path of a full-page PNG saved under `--out` |
| `capture-net` | `network[]` — fetch/XHR/WS URLs + bodies (endpoint discovery) |
| `xss-probe` | `executed` (dialog fired or sentinel set), `dialogs[]`, `sentinel`, and reflection flags |

Common options: `--proxy http://host:port` (residential egress for IP reputation / TLS), `--no-headless`
(headed, needs a display), `--human` (mouse/scroll jitter for behavioral WAFs), `--timeout <ms>`,
`--out <dir>`, `--marker <str>` (for xss-probe reflection check).

### Examples

```bash
# Did stealth get us past the WAF?
node probe.mjs --url "https://target/app" --action navigate
# -> {"blocked":false,"status":200,...}  vs  {"blocked":true,"reason":"marker cloudflare",...}

# Confirm a reflected/DOM XSS (dialog-based payload)
node probe.mjs --url "https://target/s?q=<script>alert(1)</script>" --action xss-probe --marker "<script>alert(1)</script>"
# -> {"executed":true,"dialogs":[{"type":"alert","message":"1"}],"reflectedRaw":true,...}

# Sentinel payload (no dialog): build the URL so it sets window.__probe_xss__
node probe.mjs --url "https://target/s?q=<img src=x onerror=window.__probe_xss__=1>" --action xss-probe
# -> {"executed":true,"sentinel":1,...}

# Evidence + endpoint capture through a proxy
node probe.mjs --url "https://target/app" --action screenshot --proxy http://127.0.0.1:8080 --out ./evidence
node probe.mjs --url "https://target/app" --action capture-net
```

## xss-probe convention

`executed: true` means the payload ran. Two ways to trigger it, both detected:
- **Dialog**: `alert(1)`/`confirm()`/`prompt()` — caught via Playwright `page.on('dialog')`.
- **Sentinel**: have the payload assign `window.__probe_xss__` (e.g. `onerror=window.__probe_xss__=1`) —
  read back after load. Use this when the sink doesn't allow a dialog.

`reflectedRaw: true` with `markerHasSpecials: true` flags an **unencoded reflection** (likely sink) even
when execution didn't fire.

## Files

- `browser.mjs` — stealth bootstrap (playwright-extra + stealth plugin, realistic context).
- `hooks.mjs` — init script that captures fetch/XHR/WS for `capture-net`.
- `probe.mjs` — CLI entry (actions above).

## Limits

Stealth here is **JS + browser-level**. It does **not** by itself fix TLS fingerprint (JA3/JA4) or
datacenter IP reputation — pair with `--proxy` (residential) for those.
