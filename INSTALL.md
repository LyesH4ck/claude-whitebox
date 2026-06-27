# Installing claude-whitebox

`claude-whitebox` is a Claude Code **plugin marketplace** bundling these plugins:

| Plugin | Command | What it does |
|--------|---------|--------------|
| `codeaudit` | `/codeaudit:codeaudit` | White-box source-code security audit (static source-to-sink, optional live correlation) |
| `pentest`   | `/pentest:pentest`     | Black-box penetration testing framework (63 attack categories, agent-coordinated) |
| `playwright` | _(MCP provider)_ | Playwright MCP server with stealth-friendly defaults; **dependency of `pentest`'s client-side agents** (XSS, CSP, prototype-pollution, JS mapping) |

The `codeaudit` and `pentest` plugins run inside Claude Code as agents, skills, and slash commands — no
separate service to host. The `playwright` plugin contributes an MCP server (browser automation) rather
than commands.

---

## Prerequisites

- **Claude Code** installed and working (`claude` in your shell, or the desktop/IDE app).
  Install: https://docs.claude.com/en/docs/claude-code
- **git** (to add the marketplace from GitHub).
- **Node.js ≥ 18** (for the `playwright` plugin's MCP server and stealth probe).
- Optional, per plugin — see [Optional tooling](#optional-tooling) below, and
  [Browser automation setup](#browser-automation-setup-the-playwright-plugin) for the `playwright` plugin.

---

## Install from GitHub (recommended)

Run these **inside a Claude Code session** (the `/plugin` commands are Claude Code built-ins):

```text
# 1. Register this marketplace
/plugin marketplace add LyesH4ck/claude-whitebox

# 2. Install the plugin(s) you want — name@marketplace
/plugin install codeaudit@claude-whitebox
/plugin install pentest@claude-whitebox
/plugin install playwright@claude-whitebox   # required for pentest's client-side (browser) tests
```

> **`pentest` depends on `playwright`.** The client-side agents (`xss-tester`, `csp-bypass-tester`,
> `prototype-pollution-tester`, `inventory-javascript-mapper`) call `mcp__plugin_playwright_playwright__*`,
> which the `playwright` plugin provides. Without it, server-side testing still works but browser-driven
> tests are unavailable. After install, run `/mcp` to confirm the tools registered.

Plugins install into your project's `.claude/` directory. Once installed, every agent, skill, and slash
command is available in any Claude Code session for that project.

Verify:

```text
/plugin                 # lists installed plugins
/help                   # the /codeaudit:* and /pentest:* commands now appear
```

---

## Install locally (development / offline)

If you have the repository checked out and want to run it without GitHub (e.g. while editing the
skills), point the marketplace at the local path instead of the GitHub slug:

```text
/plugin marketplace add /home/cbailleux/PENTEST-AI/claude-whitebox
/plugin install codeaudit@claude-whitebox
/plugin install pentest@claude-whitebox
/plugin install playwright@claude-whitebox
```

After editing any plugin file, refresh the marketplace so Claude Code picks up the change:

```text
/plugin marketplace update claude-whitebox
```

---

## Browser automation setup (the `playwright` plugin)

The `playwright` plugin runs Microsoft's `@playwright/mcp` (**Option A** — stealth-friendly MCP server)
and ships a standalone full-stealth probe (**Option B** — WAF-bypass fallback). On a **new machine**,
after `/plugin install playwright@claude-whitebox`:

1. **Node.js ≥ 18** (for `npx`/`node`) — usually already present alongside Claude Code.
2. **Chromium for Playwright** — needed by both A and B. Install once:
   ```bash
   npx playwright install chromium
   ```
   The default config uses **bundled Chromium, headless**, so no Google Chrome or display is required.
3. **Option B probe dependencies** — only if you'll use the WAF-bypass fallback. `node_modules` is **not**
   committed, so install per machine, inside the plugin's `stealth/` dir (it lives in Claude Code's plugin
   cache):
   ```bash
   cd ~/.claude/plugins/cache/claude-whitebox/playwright/*/stealth && npm install
   ```
   If skipped, the probe prints `{"ok":false,"error":"deps_missing","hint":"..."}` with the exact path.

Verify the MCP server is live: **`/mcp`** → `plugin:playwright:playwright · ✔ connected`.

> **Max stealth (desktop only).** To use real Google Chrome + headed instead of bundled headless, edit the
> plugin's `playwright-mcp-stealth.config.json` (`"channel": "chrome"`, `"headless": false`). Requires
> Chrome installed and a display (`xvfb-run` on a headless server). **Authorized engagements only.**

---

## Quick start

```text
# White-box audit of the current repository
/codeaudit:codeaudit

# Penetration test (asks for scope + authorization first)
/pentest:pentest
```

> Both plugins are for **authorized** security testing only. `pentest` requires explicit operator
> approval before any active exploitation begins; `codeaudit` is read-only static analysis by default.

---

## Optional tooling

These plugins work out of the box, but some features call external tools when present:

**`codeaudit` — dependency (SCA) auditing** picks up whichever scanner is installed and otherwise falls
back to manual version review:
- `npm audit` (Node), `pip-audit` (Python), `osv-scanner`, `govulncheck` (Go), `trivy`.

**`pentest` — active testing** uses, when available:
- **Playwright MCP** (the `playwright` plugin) — browser-driven evidence capture (XSS, CSP, CSRF PoCs,
  screenshots). See [Browser automation setup](#browser-automation-setup-the-playwright-plugin) for the
  one-time `npx playwright install chromium` (Option A) and `npm install` (Option B) steps.
- **Kali / MKS (Metasploit-Kali Server) MCP** — network and exploitation tooling (nmap, ffuf, sqlmap,
  subfinder, …). See the project README for Kali MCP integration details.

Missing tools degrade gracefully: the affected agent reports a coverage gap instead of failing.

---

## Updating

```text
/plugin marketplace update claude-whitebox     # pull latest marketplace metadata
/plugin install codeaudit@claude-whitebox      # reinstall to get the newest version
```

## Uninstalling

```text
/plugin uninstall codeaudit
/plugin uninstall pentest
/plugin marketplace remove claude-whitebox
```

---

## Attribution & license

MIT-licensed. The `pentest` framework is the original work of
[Stickman230](https://github.com/Stickman230) (`claude-pentest`); this distribution is maintained by
[Christophe Bailleux](https://github.com/LyesH4ck), who authors the `codeaudit` plugin. The upstream
copyright notice is retained in [`LICENSE`](./LICENSE) as MIT requires.
