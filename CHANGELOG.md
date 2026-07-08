# Changelog

All notable changes to `claude-whitebox` are documented here.

---

## [2.3.2] — 2026-07-08

### Fixed
- **Made the 2.3.1 SQLi additions actually work and stop crying wolf (code-review driven, verified end-to-end).**
  - `sqli-detect` can now reach **nested / array JSON params**: pass the captured body as a `--body` template
    and target a path with `--param` (`rowGroupCols[0].id`). Previously `buildReq` built a flat single-key
    body, so the marquee ag-grid identifier vector was unreachable.
  - **Baseline subtraction** for the `error-based` and `query-disclosure` signals (same discipline as the
    quote/boolean/numeric signals): a DB error or SQL-looking snippet already present on the baseline is a
    property of the endpoint, not the parameter, and no longer fires — kills false positives on benign HTML
    (`<select>…</select>`, "from … where" prose) and on always-500 endpoints.
  - Tightened ORM error signatures to **error-shaped** patterns (not bare package names), tightened the
    query-disclosure regex to a real statement/Hibernate-alias shape, and bounded regex input.
  - Added a real **`structural-breakout`** differential signal (a breakout payload that changes a stable
    baseline) and a structured **`leaked_query`** output field feeding exploitation.
  - Reconciled the `injection-tester` reporting rule with Phase 4: a DB/ORM-error finding's `poc.py` asserts
    the reproducible error/disclosure (a valid executable PoC), so it is reportable without data extraction.

## [2.3.1] — 2026-07-08

### Changed
- **SQLi detection now catches ORM-wrapped errors and identifier-context injection.** `sqli-detect` gained
  (1) ORM/framework error signatures — Hibernate/JPA `SQLGrammarException` / `could not extract ResultSet`,
  Spring `BadSqlGrammarException`, JDBC, Django, Rails — so a database error wrapped by the ORM is no longer
  missed; (2) **structural / identifier-context breakout** probes (`":<>`, `'":<>`, `"}`, backtick) that
  reach column / `GROUP BY` / `ORDER BY` fields (e.g. ag-grid `rowGroupCols`/`sortModel`) which value-context
  quotes cannot; (3) **query-disclosure** detection — an error body echoing a generated SQL statement
  (Hibernate prints the query) is flagged as a high signal and CWE-209 disclosure.
- **A reachable DB/ORM error is never `tested_not_vulnerable`.** `injection-tester` and `REPORT_CONTRACT`
  now require any recognized DBMS/ORM error or query-disclosure to be reported as at least an
  informational/`probable` finding + coverage gap, even when sqlmap and manual value-context payloads fail —
  automated exploitation failure ≠ not vulnerable, and a leaked query reveals the columns to craft the
  injection.

## [2.3.0] — 2026-07-07

Business-logic detection, out-of-band confirmation, parameter-level recon, and adaptive authorization
testing. Headline: a whole class of logic flaws that endpoint-level testing structurally misses (no
injectable sink, a valid-looking `200` on every request) is now modeled and tested; blind vulnerabilities
are confirmable via a self-hosted OAST collaborator; recon inventories request parameters (not just
endpoints) so injection sinks on known endpoints are no longer missed; and a multi-identity authorization
engine adds first-class IDOR/BOLA/BFLA coverage. Also: a dedicated stealth Playwright MCP plugin, targeted
single-scope launchers, and a full SQLi detection matrix. (Bundled `codeaudit` plugin bumped to **0.1.1** —
auditor dispatch now runs **every planned wave**, not just wave 1.)

### Added
- **Dedicated business-logic detection.** Two new agents split modeling from exploitation. `business-modeler`
  is a read-only black-box modeler that explores the app (interaction-driven), extracts the rules it *appears*
  to enforce from observable signals only (client-enforced constraints, the cross-identity differential, the
  app's own rejection messages — never domain knowledge or code), and emits candidate invariants
  (`invariants.json`). `business-logic-tester` reads those invariants and, per-invariant (not per-endpoint),
  generates abuse cases from a domain-generic taxonomy, executes **stateful** multi-step sequences, and
  confirms each finding with a **state-delta oracle** (before/after — a `200` is never proof). Covers
  plan/role gating, workflow skip/replay, numeric/temporal/quota abuse, and idempotency/race hand-off, with a
  Phase 2→3 write gate. `business-modeler` runs after `inventory-surface-analyzer` and before the planner; in
  white-box/hybrid mode it also ingests `codeaudit` `code-recon` output. `business-logic-tester` is deployed by
  the `common-appsec-patterns` coordinator.
- **OAST (out-of-band) blind-vulnerability confirmation.** A new `oast` skill and `/pentest:pentest-oast`
  connect command drive a self-hosted [interactsh](https://github.com/projectdiscovery/interactsh) collaborator
  server. The command runs a live self-test (register → trigger → correlate) and writes `.pentest-oast.json`;
  a single long-lived client registers once, mints a payload pool, and streams decrypted interactions for the
  whole engagement. The `injection`, `xss`, `cve`, and `pentester-executor` agents allocate unique payloads and
  correlate callback hits to deterministically confirm blind SSRF, blind/OOB SQLi, blind OS-command injection,
  stored/blind XSS, XXE OOB, and Log4Shell-class RCE. OAST is optional — if unconfigured, agents skip OOB
  testing and record it as a coverage gap rather than fabricating findings. DNS/HTTP callbacks are preferred;
  HTTPS capture is best-effort.
- **Parameter-level reconnaissance (`param-mine`).** A new `essential-skills/param-mine` tool + wiring inventory
  request *parameters*, not just endpoints, so injection sinks on already-known endpoints aren't missed
  (post-mortem keystone). Paired with param-driven routing — every parameterized endpoint is now treated as an
  injection candidate — and an exhaustive crawl that sweeps HTTP methods, nested params, and interaction depth.
- **Adaptive multi-identity authorization testing.** A new `idor-bola-tester` agent and the deterministic
  `authz-matrix` cross-identity replay engine cover IDOR/BOLA (API1), BFLA (API5), and BOPLA/mass-assignment
  (API3) with an adaptive oracle (0/1/2/N accounts) and a strict `200 ≠ BOLA` verification bar. Adds an
  `access-map` mode for per-identity reach diffing (BFLA/missing-auth triage) and a `/pentest:idor` targeted
  launcher. Operator-authored `.pentest-identities.json` / `.pentest-authz-requests.json` root files supply
  sessions and the request corpus.
- **Targeted single-scope launchers.** `/pentest:xss` and `/pentest:sql` deploy the `xss-tester` /
  `injection-tester` agent directly against one scope (no full engagement), each with a capability-aware recon
  preflight that maps SPA routes so client-only views aren't missed.
- **Full SQLi detection matrix (`sqli-detect`).** Quote-balance, boolean, numeric, error-based, and time-based
  detection with anti-false-positive checks.
- **Dedicated stealth Playwright MCP plugin.** A standalone `playwright` plugin ships the MCP server with
  stealth-friendly defaults (real Chrome channel, headed, realistic UA/viewport, anti-automation flags) plus an
  Option B full-stealth standalone probe for WAF-gated testing. It is a dependency of the pentest plugin's
  client-side agents.
- **Provider-specific cloud references** for AWS, Azure, GCP, Docker, and Kubernetes.

### Changed
- **Quantified-coverage honesty gate in the report.** The report step now mandates quantified coverage and
  fails honesty checks that would let a run claim more surface than it actually tested.
- **Model-tiered agents** — recon agents and the `codeaudit` deps/secrets auditors are tiered to lighter models
  for cost/latency; injection finding IDs aligned across pentest/codeaudit.
- **Phase 2→3 approval gate extended to the dedicated testers** (not just the general executor).

### Fixed
- Engagement directories the pipeline actually uses are now created up front.
- Playwright MCP server start failure (`-32000` — `initScript` must be a file path) resolved; stealth /
  bot-detection guidance corrected and de-siloed.
- Path-traversal / LFI false negatives from shallow depth and split params fixed via an overshoot/depth-sweep
  rule.

---

## [2.2.6] — 2026-06-08

Engagement-driven improvement pass. Headline: a re-architecture so the multi-agent design actually
runs (orchestration could not delegate), a time-budget that is spent rather than merely capped, and a
fixed deliverable contract. Also: pre-flight reachability, coverage-gap escalation, launch-time
deliverable-format selection, inline Kali-server connect, false-positive mitigation, and a scope-
question UX cleanup.

### Fixed
- **Orchestration no longer collapses to a single generalist agent.** This harness allows only one
  level of subagent nesting, so the `pentester-orchestrator` — dispatched as a subagent — could not
  call `Task`/`AskUserQuestion` and silently fell back to one agent improvising the whole engagement
  via raw HTTP, with the specialized executors never running. **Re-architected:** the
  `pentester-orchestrator` is now a **planner** that reads scope + recon and writes
  `plan/deployment-plan.json` + `plan/test-plan.md`, and the `/pentest:pentest` command (running in
  the main session, which genuinely has `Task`) now owns dispatch — it deploys recon agents, invokes
  the planner, presents the plan, deploys the specialized executor agents in parallel, aggregates, and
  reports. The multi-agent design now actually runs.

### Added
- **Time-budget quota loop.** The command captures a start timestamp and parses the timing value into
  a budget treated as a **quota to spend, not a ceiling to stay under**. It checkpoints at ~50% and,
  while budget remains and the surface is not exhausted, dispatches escalation waves (authenticated
  re-test, vulnerability chaining, tool-confirming unconfirmed findings, broader payloads, and
  post-exploitation only when MKS is active + a CVE/RCE finding is confirmed). Finishing early now
  requires a logged `surface-exhausted` justification rather than being the default.
- **Pre-flight reachability check.** Before deploying anything, the command does a liveness +
  fingerprint request and aborts early with an actionable message if the target is down.
- **Coverage-gap escalation.** Suspected-but-unconfirmed findings (e.g. a DOM-XSS the first pass could
  not browser-confirm) are flagged in the plan with a `confirmation_tool` and get a dedicated
  escalation attempt with the right tool (Playwright) when budget remains — they are no longer left as
  footnotes.
- **`docs/reference/REPORT_CONTRACT.md` — a fixed deliverable contract.** Defines the
  `pentest-report.json` schema (engagement metadata, `findings[]` with confidence/status/owasp,
  summary counts, `tested_not_vulnerable`, `coverage_gaps`, `de_scoped_for_time`, `time_budget`), the
  **required** consolidated `report.md` template, a consistent severity rubric, and the OWASP Top-10
  (2021) mapping. Two runs now produce structurally identical deliverable sets; a run is incomplete
  without `report.md`.
- **Thoroughness ↔ time reconciliation.** The planner reconciles requested thoroughness against the
  time quota in the plan (breadth-first when tight) and records `effective_thoroughness` +
  `de_scoped_for_time`, so the report never claims "Full" while delivering "Medium".
- **Launch-time deliverable-format selection.** A multi-select question lets the operator request
  extra artifacts on top of the always-produced `report.md` + `pentest-report.json`: executive
  summary, remediation plan, CSV findings table, and PDF/DOCX renders. Stored as `output_formats` in
  `.pentest-scope.json`; the report step produces exactly those. PDF/DOCX render via pandoc and
  degrade gracefully to markdown with a warning if pandoc is unavailable.
- **Inline Kali-server (MKS) connect.** When no MKS is configured, `/pentest:pentest` now offers to
  connect one inline (URL prompt + `/health` check + writes `.pentest-mks.json`) instead of telling
  the operator to run `/pentest:pentest-kali` and relaunch.
- **False-positive mitigation.** The aggregation step runs a verification + de-duplication pass:
  findings on the same vuln-class/endpoint/parameter are merged, and a finding may only be labelled
  `confirmed` with reproducible evidence (executed PoC or deterministic request/response) — weaker
  signals are downgraded to `probable`/`unconfirmed` and surfaced as coverage gaps.
- **MKS resilience to a broken Kali server.** The plugin no longer trusts the server's `/health`
  verdict (some builds run their internal `which` probe as an argv list, which crashes and
  under-reports every tool as missing even when installed). Tool availability is now re-verified
  through the unaffected `/api/command` string endpoint, and the `mks` skill probes capability once and
  routes tool calls through `/api/command` when the structured `/api/tools/*` endpoints are broken —
  with a documented shell-injection caveat for that path. Connecting an MKS no longer falsely reports
  installed tools as missing, and engagements keep working against an affected server.

### Changed
- **Scope questions.** Target, engagement name, out-of-scope, time budget, and auth are now collected
  as free-text prompts (no canned `localhost`-style options that never fit real targets). Time is a
  single "time budget" quota field; thoroughness and deliverable formats are multiple choice. Applies
  to both `/pentest:pentest` and `/pentest:pentest-scope`. The `.pentest-scope.json` schema uses a
  single `timing` field plus a new `output_formats` array (legacy `window` is read for backward
  compatibility when present).
- `commands/pentest.md` — Step 6 ("Orchestrator Handoff") replaced by Step 6.1–6.7
  (Init → Pre-flight → Recon → Planning → Approval+Dispatch → Quota loop → Aggregate+Report).
  `allowed-tools` gains `TaskOutput`, `Bash`, `Glob`, `Grep` so the command can timestamp, monitor,
  aggregate, and write deliverables.
- `agents/pentester-orchestrator.md` — rewritten from coordinator to planner; `tools` reduced to
  `[Read, Write, Bash, Glob, Grep]` (removed the non-functional `Task`/`TaskOutput`/`AskUserQuestion`);
  added the deployment-plan schema, the thoroughness/time reconciliation rules, and a prominent
  explanation of the nesting constraint.
- `docs/WORKFLOWS.md`, `docs/CLAUDE.md`, `docs/reference/OUTPUT_STRUCTURE.md`, and
  `docs/reference/TEST_PLAN_FORMAT.md` updated to the command-owns-orchestration / orchestrator-as-planner
  model and to point at `REPORT_CONTRACT.md`.
- `skills/mks/SKILL.md` — added a capability probe, a layered fallback (structured → `/api/command` →
  local Bash), per-tool `/api/command` command strings, and `which`-based tool verification.
  `commands/pentest-kali.md` and the inline MKS connect in `commands/pentest.md` re-verify `/health`
  "missing" verdicts via `/api/command`.

### Version
- `plugin.json` and `marketplace.json` bumped to 2.2.6

---

## [2.2.5] — 2026-06-07

Third audit pass — full file-by-file read of every agent, skill, reference doc, and config.

### Fixes
- **Test-plan template** (`TEST_PLAN_FORMAT.md`) — replaced the fictional executor roster ("SQL Injection Executor", "XSS Executor", "Auth Bypass Executor", …) with the real agents (`injection-tester`, `xss-tester`, `csrf-tester`, `csp-bypass-tester`, `prototype-pollution-tester`, and `Pentester Executor` for the rest). This template feeds the plan the orchestrator presents to the operator
- **Reconnaissance output spec** (`RECONNAISSANCE_OUTPUT.md`) — rewritten to document the layout agents actually produce (`inventory/*.json` + `analysis/*.md`) instead of a `reconnaissance/assets/*.json` + `reconnaissance_report.md` layout no agent ever wrote; the main `pentest` skill's Phase 2/3 recon references were updated to match
- **Output-filename collision** — `domain-assessment` now writes `analysis/domain-attack-surface.md` and `analysis/domain-testing-checklist.md`, so it no longer overwrites the `inventory-surface-analyzer` files of the same name in full-scope engagements
- **csrf-tester** read the wrong recon file (`analysis/surface-analysis.md`); corrected to `analysis/attack-surface.md`
- **PATT_STANDARD.md** pointed at a nonexistent build-time path (`docs/superpowers/plans/…`); now points at the `patt-fetcher` agent's URL Map
- **password_generator.py** — type hints corrected from the builtin `any` to `typing.Any`
- **credential_manager.py** — class docstring corrected to state credentials are stored as plaintext JSON (gitignored, chmod 600) for disposable test accounts, rather than implying encrypted "secure storage"
- **pentester-executor.md** — the "Specializations" section no longer lists fictional separate agents ("SQL Injection Executor", "XSS Executor", …); it now describes the real model (one prompt-specialized `Pentester Executor` per attack type, with dedicated testers for common client-side/injection attacks)
- **Phase-6 packaging docs** — removed the stale `reconnaissance_report.md` (a file no agent produces) from `OUTPUT_STRUCTURE.md` and the main `pentest` skill, and aligned the `processed/reconnaissance/inventory/` example filenames to the real agent outputs (`subdomains.json`, `directories.json`, `api-endpoints.json`, …)
- **Stale methodology index** — `essential-skills/methodology/README.md` was a 1,067-line index of the project's old flat structure, with ~36 links to deleted/renamed files (`cross-site-scripting.md`, `network-attacks.md`, `wireless-attacks.md`, every `*-portswigger-labs-complete.md` / `*-resources.md`, etc.). Replaced with a concise, accurate methodology hub pointing to the real `attacks/<category>/` folders
- **Broken cross-references** — repointed 22 dead "see `X-portswigger-labs-complete.md` / `X-resources.md`" links across 14 attack-content files (web-application-attacks, burp-suite, oauth, csrf, cors, clickjacking, web-llm, cache-poisoning, command-injection, host-header) to the real sibling quickstart/cheat-sheet in each folder
- **Final link validation** — a project-wide check of every `[]()` markdown link caught 7 more stale same-directory links in `web-application-attacks.md` (`./sql-injection.md`, `./csrf-quickstart.md`, `./ssrf-*.md`, `./xxe-*.md`) now repointed to the real category folders, plus an agent reference to a non-existent payload file (`injection-tester` → `nosql-injection/payloads/bypass.md`, corrected to `mongodb.md`). **Zero broken markdown links or file references remain anywhere in the plugin** (verified programmatically)

### Version
- `plugin.json` and `marketplace.json` bumped to 2.2.5

---

## [2.2.4] — 2026-06-07

Second audit pass — full re-audit of every command, agent, skill, reference doc, and the README.

### Fixes
- **Install command** — README corrected to `/plugin install pentest@claude-whitebox`. The plugin is named `pentest`, so the previous `claude-whitebox@claude-whitebox` would not resolve and blocked new installs
- **Attack-category counts** standardized to **63 categories across 11 domains** in `plugin.json`, `marketplace.json`, the README, the main `pentest` skill, `ATTACK_INDEX.md`, and the orchestrator. Three figures had disagreed — "100+" (inflated), "9 categories/50+" (undercount that miscounted its own list), and "63". Also fixed the README's offsetting per-domain errors (injection was missing `file-inclusion`; ip-infrastructure wrongly counted the non-attack `reference/` folder)
- **Fictional agent mappings** in `ATTACK_INDEX.md` replaced — "SQL Injection Discovery Agent", "XSS Discovery Agent", "SSRF Discovery Agent", etc. now name the real agents (`injection-tester`, `xss-tester`, `csrf-tester`, `csp-bypass-tester`, `prototype-pollution-tester`, `pentester-executor`, `authenticating` skill)
- **Ghost slash-commands removed** — the `pentest` skill's "Integration" list (`/authenticating`, `/ai-threat-testing`, …) is now a "Related Skills" list of real skill names (no leading slash), with the nonexistent `/ai-threat-testing` noted as web-LLM content under API Security; the `authenticating` skill's "Commands" section and its README's fabricated `require('.claude/skills/authenticating')` programmatic API were replaced with an accurate "this is a skill, not a slash command or library" description
- **Stale branding** — removed "Transilience Community Security Tools" / "Transilience AI" references from the README (ownership is `Stickman230`, MIT)
- **Coordinator output blurbs** — `common-appsec-patterns` and `cve-testing` "Key outputs" listed nonexistent `reports/`, top-level `evidence/`, and `raw/exploits/` folders; aligned to the real live layout (`findings/finding-NNN/` with `evidence/` inside, `activity/` logs, root `pentest-report.json`)
- **Phase-6 report contents** — the main `pentest` skill's "Report folder contents" bullet omitted the primary `.docx` deliverable, contradicting its own diagram; reconciled to docx (+ optional pdf), json, README, appendix
- **Coordinator boilerplate** — removed the false "You only have read permissions on this current directory" line from all four skill coordinators (they delegate via the Task tool)
- **Per-attack file structure** — `ATTACK_INDEX.md` claimed each attack folder has `definition.md`/`methodology.md` (which do not exist); corrected to the actual `*-quickstart.md`, `*-cheat-sheet.md`, and `payloads/`

### Version
- `plugin.json` and `marketplace.json` bumped to 2.2.4

---

## [2.2.3] — 2026-06-06

Corrective pass — fixes broken connections, removes ghost components, and re-syncs documentation with the real architecture.

### Fixed
- `pentester-orchestrator` now declares `AskUserQuestion` in its tools list — its mandatory operator gates (Phase 0 scope, Phase 2 plan approval, Phase 4 findings confirmation) could not fire without it
- `.pentest-attacks.json` now carries a real `status` field: `/pentest:pentest-attacks` writes `status: "pending"` and `/pentest:pentest` sets it to `"active"` on use, mirroring `.pentest-scope.json`. Previously `/pentest:pentest-exit` reset a field that was never written and the README documented a non-existent field
- Broken `/OUTPUT.md` references corrected to `docs/reference/OUTPUT_STRUCTURE.md` in `web-application-mapping`, `domain-assessment`, and `cve-testing` skill coordinators (only `common-appsec-patterns` had been fixed in 2.2.2)
- Dead `/AGENTS.md` reference removed from `common-appsec-patterns`
- `pentest-attacks.md` confirmation text corrected — executors deploy during Phase 3 (Testing), not Phase 4 (Aggregate)
- Skill coordinators no longer point agents at the wrong `.claude/agents` path

### Changed
- `pentester-executor` — removed the ghost "Tools Framework" section and the `tools/{tool}/config.json` rule that referenced a non-existent `tools/` directory; MKS/Kali wiring left untouched
- `pentester-orchestrator` Delegation Pattern and Agent Selection now use real agent names (`injection-tester`, `xss-tester`, `csrf-tester`, `Pentester Executor`) instead of the fictional "SQL Injection Executor" / "XSS Executor" subagent types
- `docs/CLAUDE.md` rewritten to reflect the real architecture — 15 agents, 7 skills, 5 commands (previously claimed "3 agents" and linked a non-existent `PLANNING_WORKFLOW.md`)
- `docs/WORKFLOWS.md` rewritten to the current 0–6 engagement lifecycle (scope, MKS check, recon, plan + approval, testing, aggregate, conditional post-exploitation, report) with timing/thoroughness/attack-profile inputs and real agent names
- Both `OUTPUT_STRUCTURE.md` files now cross-reference each other with scope notes clarifying they describe sequential stages (live working layout → Phase 6 deliverable packaging), not competing schemas
- Removed non-existent OWASP ZAP integration references from `web-application-mapping`; documented only the tools actually used (ffuf, gobuster, nikto, dirsearch, feroxbuster)
- Dropped residual "bug bounty hunting" framing from the marketplace description and the `pentest` / `pentester-orchestrator` trigger lines

### Version
- `plugin.json` and `marketplace.json` aligned to 2.2.3 (were stale at 2.0.0)

---

## [2.2.2] — 2026-06-06

### Added
- `/pentest:pentest` now checks for a configured Kali server (`.pentest-mks.json`) before launching (new Step 4 — Kali Server Check)
  - If MKS is active: displays server URL and tool availability (nmap, gobuster, dirb, nikto, sqlmap, hydra, john, metasploit); asks "Use MKS tools / Skip MKS"
  - If MKS is not configured: prints a hint to run `/pentest:pentest-kali` and continues without it
  - `mks_active` and `mks_url` are propagated to the orchestrator handoff; orchestrator is instructed to skip Phase 0b (no redundant re-read)
  - When MKS is inactive, orchestrator is explicitly told not to activate Phase 5 post-exploitation
  - Engagement summary now shows `Kali Server:` row
  - Step numbering updated: Summary is now Step 5, Orchestrator Handoff is Step 6

### Changed
- `/pentest:pentest-exit` Step 6 (formerly "Scope Reset") is now "Scope and Attacks Reset" — also resets `.pentest-attacks.json` to `status: "pending"` on session close, mirroring the existing scope reset behaviour

### Fixed
- Broken reference `/OUTPUT.md` in `skills/common-appsec-patterns/SKILL.md` corrected to `docs/reference/OUTPUT_STRUCTURE.md`
- `reports/` output entry in `skills/common-appsec-patterns/SKILL.md` corrected — removed "bug bounty submissions" (non-existent output type); kept "Executive, technical reports"

### Removed
- HackerOne Hunter section from `docs/WORKFLOWS.md` — documented a `hackerone.md` agent that does not exist; orphaned ghost feature
- Bug Bounty visual workflow diagram from `docs/WORKFLOWS.md`
- `hackerone.md` dead reference from `docs/WORKFLOWS.md` Reference footer
- Empty `agents/reference/` directory — unreferenced scaffolding

### Documentation
- `README.md` brought up to date with the current architecture
  - Slash Commands section rewritten to document all five commands (`/pentest:pentest`, `/pentest:pentest-scope`, `/pentest:pentest-attacks`, `/pentest:pentest-kali`, `/pentest:pentest-exit`) — previously only two were documented
  - `/pentest:pentest` flow updated to reflect the current 7-step sequence including scope check, attack profile check, Kali server check, 7 scope fields, and correct step numbering
  - `/pentest:pentest-exit` flow updated to include the scope and attacks reset step
  - Added **Session State Files** section documenting `.pentest-scope.json`, `.pentest-attacks.json`, and `.pentest-mks.json`
  - Engagement Lifecycle diagram updated: added Phase 0b (MKS check) and Phase 5 (post-exploitation, conditional on MKS + RCE); added explanatory prose for conditional phases
  - Repository structure updated: added `docs/CLAUDE.md`, `docs/WORKFLOWS.md`, and `skills/mks/`; removed stale version annotation from `plugin.json` entry
  - Quick Start section updated to recommend `/pentest:pentest` as the entry point

---

## [2.2.1] — 2026-06-06

### Added
- **Timing field** on scope — max execution time for the pentest itself (not including report generation). Collected as Q6 in both `/pentest:pentest-scope` and `/pentest:pentest` new-scope flow.
  - Free-text input (e.g., `2h`, `8h`, `unlimited`)
  - Persisted to `.pentest-scope.json` as `"timing"`
  - Displayed in all scope/summary blocks and passed to orchestrator
  - Orchestrator instruction: stop active testing when the limit is reached and move directly to report
- **Thoroughness field** on scope — depth of testing. Collected as Q7 in both commands via a 4-option select.
  - **Light** — automated scans only, minimal payload set (top 5-10 per attack type), stop at first confirmed finding per category
  - **Medium** — standard coverage, common payloads + manual probing on interesting endpoints, one follow-up round (default/recommended)
  - **Deep** — extended payload sets, edge cases, multi-step attack chains, vulnerability escalation and chaining
  - **Full** — exhaustive testing, all payloads and techniques, all attack chains, informational findings documented, maximum coverage up to the time limit
  - Persisted to `.pentest-scope.json` as `"thoroughness"`
  - Displayed in all scope/summary blocks
  - Thoroughness guidance injected into the orchestrator handoff instruction so every deployed executor respects the selected depth

### Changed
- `pentest-scope.md` Step 1 now extracts `existing_timing` and `existing_thoroughness`; Step 2 displays both in the EXISTING SCOPE FOUND block; Step 3 collects Q6 (timing text) and Q7 (thoroughness select) after Q5; Step 5 JSON includes both fields; Step 6 confirmation block shows both fields
- `pentest.md` Step 2 extracts `timing` and `thoroughness` from pre-defined scope; PRE-DEFINED SCOPE FOUND block shows both; "Use pre-defined scope" path sets `Q6_answer` and `Q7_answer`; new-scope path adds Q6 and Q7 questions; JSON write includes both fields; Step 4 ENGAGEMENT SUMMARY shows Timing and Thoroughness rows; Step 5 orchestrator instruction includes max execution time and per-level thoroughness guidance

---

## [2.2.0] — 2026-06-05

### Added
- `/pentest:pentest-attacks` slash command — define which attack categories and skills the orchestrator should use for an engagement. Saves to `.pentest-attacks.json`. Does not launch a pentest.
  - **Mode selection**: Full suite / Web application profile / API & cloud profile / Custom
  - **Web app preset**: injection, client-side, server-side, authentication, API security, business logic
  - **API & cloud preset**: API security, cloud & containers, IP infrastructure, CVE testing, domain recon
  - **Custom mode**: 3 multi-select questions covering all 12 attack categories; each selection maps to the correct skill and executor(s)
  - If an existing profile is found, offers update or keep
  - Full skill/executor mapping embedded for consistent JSON output

### Changed
- `/pentest:pentest` now checks for `.pentest-attacks.json` after scope collection (new Step 3)
  - If a profile exists: shows it and asks "Use this profile / Run full suite"
  - If no profile exists: asks inline mode selection (Full / Web app / API & cloud / Custom)
  - If "Custom" is chosen inline: stops the launch and instructs the user to run `/pentest:pentest-attacks` first (scope is already saved, so re-launching picks it up)
  - Attack mode is injected into the orchestrator handoff instruction — the orchestrator restricts executor deployment to the listed categories
  - Engagement summary now shows the `Attacks:` field
  - Step numbering updated: Summary is now Step 4, Orchestrator Handoff is Step 5

---

## [2.1.0] — 2026-06-05

### Added
- `/pentest:pentest-scope` slash command — define or update engagement scope without launching a pentest. Saves scope to `.pentest-scope.json`. Can be run before or during an active engagement.
  - If run with no existing scope: collects 5 scope fields and saves with `status: pending`
  - If run with an existing scope: shows current scope and offers update or cancel
  - If run during an active engagement with a target change: detects drastic vs minor changes
    - **Drastic change** (different domain or IP subnet): warns operator, offers update-anyway / save-as-pending / cancel
    - **Minor change** (same target, different restrictions/window/auth): updates scope silently with confirmation

### Changed
- `/pentest:pentest` now checks for a pre-defined scope file (`.pentest-scope.json`) before collecting scope
  - If pre-defined scope exists: displays it and asks "Use pre-defined scope / Enter new scope"
  - If pre-defined scope is used: skips all 5 scope questions and marks scope status as `active`
  - If no pre-defined scope or user opts for new scope: runs full 5-question collection as before, and saves the collected scope to `.pentest-scope.json` with `status: active`
  - `Read` added to allowed-tools in `pentest.md`

---

## [2.0.0] — 2026-03-16

### Added
- `/pentest:pentest` slash command — guided scope collection, session isolation, automatic orchestrator handoff at Phase 1
- `/pentest:pentest-exit` slash command — dual-schema findings probe (Schema A + B), severity-bucketed summary, isolation lift instruction
- Slash Commands section added to README
- Target-Type Routing table in `pentester-orchestrator` — routes web apps, APIs, cloud, network, and full-scope engagements to the correct skill coordinator
- Engagement Lifecycle flowchart in `pentester-orchestrator`
- Mandatory approval gate between Phase 2 (Experiment) and Phase 3 (Test) in `pentester-executor`
- Phase 0 mount-skill block in `pentester-executor`
- AV-safe reverse shell payload cheatsheet using component notation for PHP entries
- AV-safe file-inclusion payload files (wrappers, RFI, LFI) using component notation
- `CONTRIBUTING.md` and `SECURITY.md`

### Changed
- PHP literal code blocks in `file-upload-quickstart.md` and `file-upload-cheat-sheet.md` replaced with component notation to avoid Microsoft Defender signatures
- `pentester-executor` Critical Rules tightened — phases boundaries, approval gate enforced
- Phase headings standardised to H2 across all 12 executor/inventory agents
- Activity log paths corrected in `domain-assessment` agent
- `domain-assessment` tool declaration fixed
- Reduced token cost: removed repeated boilerplate `## When to Use` sections and duplicate Critical Rules bullets from 11 agents
- `inventory-surface-analyzer` When to Use section trimmed; orchestrator duplicate bullet removed; executor Phase 0 prose shortened
- Plugin install commands corrected in README

### Removed
- 53 dead-weight reference files from `skills/pentest/attacks/` (PortSwigger lab indexes, generic resource lists) — no actionable attack content, significant token cost

### Fixed
- `Task` tool added to `pentest.md` allowed-tools so orchestrator handoff executes correctly (CMD-03)
- `pentest-exit.md` now probes both output schemas before reading findings (CMD-04)
- `marketplace.json` name, schema URL, and owner fields corrected
- Invalid `agents` and `skills` declarations removed from `plugin.json`

---

## [1.0.0] — 2026-03-15

### Added
- `pentester-orchestrator` — coordinates full engagements: recon → plan → user approval → executor deployment → aggregation → report
- `pentester-executor` — general executor with 30+ attack specialisations following a 4-phase workflow
- `xss-tester` — reflected, stored, DOM-based XSS; framework sinks (React/Vue/Angular); WAF evasion; Playwright evidence capture
- `csrf-tester` — missing tokens, SameSite bypass, token reuse, method override; browser-loadable PoC HTML output
- `injection-tester` — SQLi, NoSQLi, OS command injection; sqlmap automation + manual curl probing
- `csp-bypass-tester` — CSP header analysis; unsafe-inline, wildcard sources, JSONP, Angular sandbox, open-redirect bypass vectors
- `prototype-pollution-tester` — URL params, hash fragments, JSON body; `Object.prototype` pollution verified in browser DOM
- `cve-tester` — tech stack fingerprinting, NVD/Exploit-DB/GitHub CVE research, PoC adaptation, live exploitability validation
- `domain-assessment` — subdomain discovery (subfinder, amass, crt.sh), port scanning (nmap, masscan), service enumeration
- `inventory-software-catalog` — SBOM generation with CVE flagging
- `inventory-directory-scanner` — active brute-forcing with ffuf, gobuster, feroxbuster, nikto, dirsearch
- `inventory-api-discovery` — REST, GraphQL, WebSocket, Swagger/OpenAPI/Postman discovery
- `inventory-javascript-mapper` — SPA route extraction via headless Playwright; React Router, Vue Router, Angular routes
- `inventory-surface-analyzer` — synthesises all 4 inventory agent outputs into a unified risk-tiered attack surface report
- `patt-fetcher` — on-demand PATT payload fetching (Haiku model for token efficiency)
- `common-appsec-patterns` skill coordinator — routes to xss-tester, csrf-tester, injection-tester, csp-bypass-tester, prototype-pollution-tester
- `web-application-mapping` skill coordinator — routes to all 5 inventory agents
- `cve-testing` skill coordinator
- `domain-assessment` skill coordinator
- `authenticating` skill coordinator — signup/login automation, 2FA/OTP bypass, CAPTCHA evasion, credential management tools
- `pentest` main skill — attack index covering 11 domains, 63 sub-categories; methodology frameworks (PTES, OWASP WSTG, MITRE ATT&CK)
- Attack knowledge base: injection (8), client-side (6), server-side (6), authentication (4), API security (4), web applications (9), cloud/containers (5), system/post-exploitation (8), IP infrastructure (9), physical/social engineering (1), essential skills (3)
- Curated PATT payload files per attack category (`payloads/` subdirectories, <200 lines each)
- `OUTPUT_STRUCTURE.md` and `TEST_PLAN_FORMAT.md` reference docs
- `WORKFLOWS.md` — complete planning & approval workflow with visual diagrams
- `CLAUDE.md` — agent architecture overview for the docs directory
- Structured engagement output layout: `outputs/{engagement}/activity/`, `findings/`, `inventory/`, `analysis/`, `pentest-report.json`
- `.gitignore` excluding `.claude/` and generated `outputs/`
- `marketplace.json` — Transilience Community Security Tools marketplace listing
- `plugin.json` — plugin metadata (MIT, author Stickman230)
- README with architecture diagram, engagement lifecycle, agent tables, attack coverage, and install instructions

---

## [0.1.0] — 2026-03-14

- Initial commit — empty repository scaffold
