# Recon capture pipeline — no in-scope request silently dropped (CHANGES)

Fixes the observability gap where interaction-triggered READ XHRs (a picker-select firing
`GET …/inventories?name=<item>`, a row-drill `GET …/{id}`, a tab-open lazy load) traversed the proxy but were
recorded in NO recon inventory — the id/filter-bearing requests most useful for BOLA/injection were structurally
missing. Applied directly to the repo (not a cache copy). Each change maps to the root-cause mechanism it closes.

## Resolved versions targeted
- `plugins/playwright/` (owns `crawl.mjs`, `crawl-write.mjs`, `browser.mjs`, `op-signature.mjs`, the MCP config).
- `plugins/pentest/` (owns the recon command, surface-analyzer/js-mapper agents, `burp-import`; **new** `har-import`).
- `@playwright/mcp`: the fix uses `browser.contextOptions.recordHar` (a standard Playwright context option). If a
  resolved MCP build does not honor it, fall back to `--save-trace` and parse the trace network log (noted in the config).

## Change → phase → root-cause mechanism

| Change | Phase | Closes |
|---|---|---|
| `playwright-mcp-stealth.config.json` → `contextOptions.recordHar` | 1 | RC#3 — MCP agents capture curated + body-less via `browser_network_requests()`. A full HAR persists EVERY MCP-driven request (bodies + WS) with **zero per-agent code**. |
| `browser.mjs::newStealthContext` → `harPath` option (recordHar) | 1 | RC#4 — no complete-traffic backstop. The owned harnesses now also flush a full HAR on `ctx.close()`. |
| `crawl.mjs` → per-session timestamped `harPath` + `raw-traffic.jsonl` + `completeness` block | 1,2 | RC#4 (backstop), RC#5 (map treated as complete). Emits the raw observed list it used to aggregate-then-discard. |
| **new** `har-import.mjs` (+test) | 1 | RC#1/#4 — folds a HAR into the inventory in the SAME `op-signature` shape as `crawl.mjs`/`burp-import.mjs`. Header VALUES are never persisted (secrets). |
| **new** `observed-merge.mjs` (+test) | 1 | RC#5 — unions crawl + HAR + Burp + widgets + raw-traffic into `observed-requests.jsonl`, the ground-truth corpus, deduped by `op-signature`. |
| `crawl.mjs::exerciseView` → picker-select / row-drill / disclosure engine (+test) | 3 | RC#1 — `crawl.mjs`'s interaction repertoire was grid-only, so it never fired the picker/row reads. Ported read-only primitives from `crawl-write` (bounded, per-type caps, external-rail guard, **never submits**). |
| `inventory-surface-analyzer.md` → Phase 2.0 reconciliation + `completeness` in `surface-map.json`/`recon-manifest.json` | 2 | RC#5 — the analyzer now diffs the corpus vs the curated map and promotes **`unmapped_observed`** to first-class surface; declares how partial the map is. |
| `commands/recon.md` → Step 5c HAR ingest + corpus merge; `discovered` = the corpus | 2 | RC#5 — the pipeline folds every HAR and unions to the corpus before synthesis. |
| `.gitignore` → `*.har`, `**/har/`, `observed-requests.jsonl`, `raw-traffic.jsonl` | X-cutting | Secrets — HARs hold Authorization/Cookie + response bodies; the corpus holds real hostnames. Never committed. |

RC#2 (`crawl-write` persists write-only) is closed indirectly: the interaction-triggered reads are now captured by
`crawl.mjs`'s engine (Phase 3) AND by the HAR backstop (Phase 1), so they no longer survive only as the lossy
name-only `widget-param-inventory.json`.

## Acceptance criteria — status
1. **Incident reproduced then fixed** — ✅ `har-import.test.mjs` (a HAR with a picker-select `?name=` read →
   endpoint with `name`) AND `crawl.test.mjs` interaction test (read recon fires+captures `GET /api/items?name=`
   and the row-drill `/{id}`), starting from a run that previously missed them.
2. **Zero per-agent code for MCP agents** — ✅ `recordHar` in the MCP config alone persists any MCP-driven session.
3. **Reconciliation surfaces gaps** — ✅ `observed-merge` corpus + the analyzer's `unmapped_observed`/`completeness`.
4. **Interaction depth in READ recon** — ✅ `crawl.mjs` alone fires+captures picker-select and row-drill, bounded.
5. **No regression** — ✅ existing artifacts unchanged; stealth suite 37/0, har-import+observed-merge 3/0, crud-merge 8/0.
6. **Secrets scrubbed + gitignored; HAR paths unique** — ✅ header values never persisted; per-session timestamped HAR.

## Deferred (documented, optional — Phase 4)
- **mitmproxy superset** (`mitmdump --mode upstream:http://<burp> -s scope_sink.py --listen-port 8081`, browser →
  8081, Burp upstream) with a passive, append-only, scope-filtered addon writing into `observed-requests.jsonl` —
  ALSO captures non-browser tester traffic (sqlmap/idor curl probes). Kept optional (2nd proxy hop + CA trust);
  `observed-merge` already accepts a mitmproxy JSONL via `--extra`. NOT wired here (no `scope_sink.py` shipped).
- **Do NOT** pursue Burp REST for proxy history — stock Burp exposes no such endpoint (needs a Montoya extension + Burp Pro).
