---
name: codeaudit
description: Activate code-audit mode — displays banner, configures session isolation, collects audit scope (repo path, optional live URL, vuln classes, optional depth), then OWNS the audit: code-recon baseline, planning (via the audit-planner), auditor dispatch, a completeness loop that runs until every source→sink path in scope is analyzed, aggregation, and report generation.
disable-model-invocation: true
allowed-tools:
  - AskUserQuestion
  - Read
  - Write
  - Task
  - TaskOutput
  - Bash
  - Glob
  - Grep
---

Output the following banner verbatim:

```
======================================================
|                                                    |
|    ____ ___  ____  _____    _   _   _ ____ ___ _____ |
|   / ___/ _ \|  _ \| ____|  / \ | | | |  _ \_ _|_   _||
|  | |  | | | | | | |  _|   / _ \| | | | | | | |  | |  |
|  | |__| |_| | |_| | |___ / ___ \ |_| | |_| | |  | |  |
|   \____\___/|____/|_____/_/   \_\___/|____/___| |_|  |
|                                                    |
|         W H I T E - B O X   C O D E   A U D I T    |
|                                                    |
======================================================
root@claude:~# [INITIALIZING CODE AUDIT ENVIRONMENT...]
root@claude:~# [READY]
```

## Step 1 — Isolation

Use AskUserQuestion to ask:

"Do you want to isolate this session to the codeaudit plugin only? (Recommended — prevents other plugins interfering with the audit)"

Present exactly these two options:
- "Yes — isolate me (recommended)"
- "No — keep all plugins active"

If "Yes — isolate me (recommended)", output this block verbatim:

```
============================================================
[CODE AUDIT MODE — ISOLATION ACTIVE]

For this session, you MUST operate under these constraints:
- Only invoke agents from the codeaudit plugin (agents/ directory)
- Mount skills from codeaudit; you MAY read the pentest plugin's attack
  reference files (payload/sink knowledge) but invoke no pentest agents
- Ignore agents and skills from all other plugins
- This constraint is active until /codeaudit:codeaudit-exit is run or /clear resets the session
============================================================
```

If "No — keep all plugins active", output:

```
Session running with all plugins active. You can still use /codeaudit:codeaudit-exit to close the audit.
```

## Step 2 — Scope Check

Try to Read `.codeaudit-scope.json`.

**If the file exists and is valid JSON**, extract `repo`, `engagement`, `out_of_scope`, `focus`,
`target_url`, `depth` (default `"Thorough"`), `output_formats` (default `[]`), and `extra_roots` (default
`[]` — sibling first-party repos/dirs to fold into scope, e.g. a separate front-end service). Output:

```
============================================================
PRE-DEFINED AUDIT SCOPE FOUND
============================================================
Repository:   {repo}
Engagement:   {engagement}
Focus paths:  {focus}
Out-of-scope: {out_of_scope}
Live URL:     {target_url or "none (static-only audit)"}
Depth:        {depth}
Deliverables: report.md + codeaudit-report.json{, plus output_formats if any}
============================================================
```

> A code audit is **bounded**, not time-budgeted: it runs until every source→sink path in scope is
> analyzed across the selected classes, then stops. There is no quota to spend. `depth` is an optional
> quality knob (how far to follow indirect/second-order flows), not a budget — it defaults to `Thorough`
> (complete).

Then use AskUserQuestion:

"A pre-defined audit scope was found. How do you want to proceed?"

Options:
- "Use pre-defined scope — proceed with the scope above (Recommended)"
- "Enter new scope — ignore pre-defined scope and collect scope now"

If "Use pre-defined scope": set fields from the file, update `.codeaudit-scope.json` `"status"` to
`"active"`, skip to Step 3.

If "Enter new scope" OR the file does not exist, collect the scope below.

**Free-text fields — ask each as a plain prompt, NOT via AskUserQuestion.** Ask one at a time, in order:

1. **Repository** — "Repository path — absolute path to the source code to audit (e.g., /home/me/src/acme-api)" → `repo`
2. **Engagement name** — "Engagement name — used as the outputs/{name}/ folder (e.g., acme-api-2026-06)" → `engagement`
3. **Focus** — "Focus paths — directories/files to prioritize, or 'all' (e.g., src/api, src/db — or 'all')" → `focus`
4. **Out-of-scope** — "Out-of-scope — paths to exclude from the audit (e.g., tests/, migrations/, vendor/ — or 'none')" → `out_of_scope`
5. **Live URL** — "Live correlation URL — a running instance to optionally corroborate findings against, or 'none' for a static-only audit (e.g., http://localhost:3000)" → `target_url` (store null if 'none')

**Depth is optional.** Do NOT ask for it by default — a code audit runs to completeness, so the default
`depth` is `"Thorough"` (every source, every path fork, helpers/branches, second-order flows). Only if
the operator explicitly asks for a faster/lighter pass, offer these via AskUserQuestion and store as
`depth`:
- "Quick — high-confidence sinks and primary paths only (fast triage)"
- "Standard — all enumerated sources, primary + obvious secondary paths"
- "Thorough — every source, every path fork, helpers/branches, second-order flows (default, complete)"

Then use AskUserQuestion with **multiSelect: true** for deliverable formats:

"Deliverable formats — `report.md` and `codeaudit-report.json` are ALWAYS produced; select any extras."

Options (multi-select):
- "Executive summary — 1-page non-technical summary (exec-summary.md)"
- "Remediation plan — actionable ticket-style fix list (remediation-plan.md)"
- "CSV findings table — findings.csv for tracking"
- "SARIF — codeaudit.sarif for CI / code-scanning ingestion"
- "PDF render — report.pdf (requires pandoc; degrades to markdown with a warning if unavailable)"

Store selected labels as `output_formats`.

After collecting, write `.codeaudit-scope.json` with status `"active"`:

```json
{
  "repo": "{repo}",
  "engagement": "{engagement}",
  "focus": "{focus}",
  "out_of_scope": "{out_of_scope}",
  "target_url": {target_url or null},
  "depth": "{depth or "Thorough"}",
  "output_formats": {output_formats array},
  "extra_roots": {extra_roots array or []},
  "status": "active"
}
```

Then verify the repo: `test -d "{repo}/.git" && echo git || echo no-git`. If `{repo}` does not exist,
abort with an actionable message and stop. Note whether it is a git repo (auditors use git-awareness).

## Step 3 — Class Profile

Try to Read `.codeaudit-classes.json`.

**If the file exists and is valid JSON**, extract `classes`, output:

```
============================================================
AUDIT CLASS PROFILE FOUND
============================================================
Classes: {comma-separated classes}
============================================================
```

Then use AskUserQuestion:

"A class profile was found. How do you want to proceed?"

Options:
- "Use this profile — audit only the listed classes (Recommended)"
- "Run all classes — audit the full set of 10 classes"

If "Use this profile": set `classes` from the file, update its `"status"` to `"active"`.
If "Run all classes": set `classes = ["injection","xss","auth","access-control","ssrf","secrets","crypto","deps","config","logging"]`.

**If the file does not exist**, use AskUserQuestion with **multiSelect: true**:

"Which vulnerability classes should the audit cover? (Select all that apply — default is all ten.)"

Options (multi-select):
- "Injection — SQLi, NoSQLi, command, LFI/RFI, SSTI, XXE, path traversal, deserialization"
- "XSS — reflected, stored, DOM, framework escape hatches"
- "Auth — password storage, sessions, JWT, reset flows, MFA, enumeration"
- "Access control — function-level authz, IDOR, privilege escalation, mass assignment"
- "SSRF — outbound requests, webhooks, URL-import"
- "Secrets — hardcoded credentials, keys, tokens"
- "Crypto — weak algorithms, RNG, TLS verification, password hashing"
- "Dependencies — vulnerable & outdated components (SCA)"
- "Configuration — headers, CORS, cookies, debug mode, defaults"
- "Logging — sensitive data in logs/telemetry/error responses, missing audit logging, log injection (A09)"

Map selections to the class keys above; if none selected, default to all ten. Store as `classes`.

## Step 4 — Tooling Check (optional scanners)

Probe for optional scanners that auditors will prefer if present (never install anything):
```bash
for t in gitleaks trufflehog osv-scanner pip-audit govulncheck trivy semgrep pandoc; do
  command -v "$t" >/dev/null 2>&1 && echo "$t=available" || echo "$t=missing"
done
```
Output a one-line summary (e.g. `Scanners: gitleaks=available osv-scanner=missing ... pandoc=available`).
Store the available set as `tools_available` and pass it to the relevant auditors. Missing scanners are
not fatal — auditors fall back to pattern/version review and log a coverage note.

## Step 5 — Audit Summary

Output with real values:

```
============================================================
CODE AUDIT SUMMARY
============================================================
Repository:   {repo}
Engagement:   {engagement}
Focus paths:  {focus}
Out-of-scope: {out_of_scope}
Mode:         {hybrid if target_url else static-only}{ + Live URL: {target_url}}
Depth:        {depth}  (runs to completeness — every source→sink path in scope, then stops)
Classes:      {classes}
Scanners:     {tools_available or "none — pattern/version fallback"}
Deliverables: report.md + codeaudit-report.json{, plus output_formats if any}
============================================================
```

## Step 6 — Audit Execution (this command owns orchestration)

> **Why the command runs the audit.** This harness allows only **one level of subagent nesting**. This
> command runs in the main session and CAN spawn agents via `Task`. Any agent it spawns (including the
> planner and `code-recon`) is a subagent and CANNOT spawn further agents. So this command — not the
> planner — dispatches `code-recon`, invokes the planner, dispatches the auditors, runs the completeness
> loop, aggregates, and reports. The `audit-planner` agent is a **planner only**.

> **Completeness, not budget.** A code audit has a finite scope: the set of sources and sinks in the
> code. The audit is **done when every enumerated source→sink path has been analyzed across the selected
> classes** — that is the normal, expected exit, not a quota running out. There is no timer. Do not stop
> early while untraced sources remain; do not invent extra work once the scope is exhausted.

Maintain an activity log at `outputs/{engagement}/activity/codeaudit-orchestrator.log` (NDJSON) —
append a line at every phase boundary and dispatch.

### Step 6.1 — Initialize

```bash
mkdir -p "outputs/{engagement}/activity" "outputs/{engagement}/recon" "outputs/{engagement}/plan" "outputs/{engagement}/findings"
cd "{repo}" && git rev-parse --short HEAD 2>/dev/null   # → COMMIT (or "n/a")
```
Log:
```json
{"timestamp":"<ISO>","agent":"codeaudit-orchestrator","phase":"init","repo":"{repo}","commit":"<COMMIT>","depth":"{depth}","classes":<classes>,"mode":"<static|hybrid>","result":"started"}
```

### Step 6.2 — Code-recon baseline

Dispatch the **code-recon** agent via `Task`. Pass `repo`, `engagement`, `focus`, `out_of_scope`,
`target_url`, `extra_roots`, and `classes`. Wait for completion. Confirm it wrote `recon/architecture.md`,
`recon/attack-surface.md`, and `recon/sink-inventory.json`. If recon fails or finds zero sources/sinks,
warn the operator (possibly wrong repo or unsupported stack) and ask whether to continue. Log
`phase":"recon","action":"baseline-complete","sources":<N>,"sinks":<M>`.

### Step 6.3 — Planning (invoke the planner agent)

Invoke the **audit-planner** via `Task`, pointing it at the baseline. Exact instruction (substitute real
values):

"You are the planner. Scope is confirmed and code-recon is complete — do NOT collect scope, do NOT audit
code for findings, do NOT call Task/AskUserQuestion. Read `outputs/{engagement}/recon/*`, then produce
the deployment plan.

Brief:
- Repo: {repo} | Engagement: {engagement} | Focus: {focus} | Out-of-scope: {out_of_scope}
- Mode: {static|hybrid} | Live URL: {target_url}
- Depth: {depth}
- Classes: {classes}
- Scanners available: {tools_available}

Map classes to auditor agents, scope each to where its sinks live (from sink-inventory.json), skip any
class with no surface (record under `skipped`), and write `plan/deployment-plan.json` +
`plan/audit-plan.md`. The plan covers the FULL scope — there is no time budget to ration; every selected
class with surface gets an auditor. Follow your agent definition's schema."

### Step 6.4 — Present the plan, then dispatch auditors

1. **Validate the plan first (mirror the recon guard in 6.2).** Confirm `plan/deployment-plan.json`
   exists and parses as JSON, and that `waves[]` is present and non-empty. The planner is Task-blind and
   can fail silently, so do not consume its output on trust. If the file is missing, unparseable, or
   `waves[]` is empty **while any selected class still has surface in `sink-inventory.json`**, the planner
   failed — log `phase":"plan","result":"invalid-or-empty"`, warn the operator, and re-invoke the planner
   once; if it fails again, abort with an actionable message. An empty plan is valid **only** when every
   selected class was recorded under `skipped` with a reason (genuinely nothing to audit); "zero auditors
   dispatched while surface remains" is an error state, **never** scope-exhausted.
2. Present `plan/audit-plan.md` to the operator via AskUserQuestion (Approve / Modify / Cancel). On
   **Modify**, follow up with a plain free-text prompt — "What should change? (e.g. add xss, drop deps,
   rescope injection to src/db)" — apply the edit to the plan yourself, then re-present. (AskUserQuestion
   returns only a label; the *what* needs a free-text channel, per the convention in Step 2.) On Cancel,
   log and stop.
3. On approval, dispatch every auditor in wave 1 **in parallel — all `Task` calls in a single message**,
   `run_in_background=True`, using the real agent names from the plan. **A sharded class appears as several
   deployments with the same `agent` and distinct `shard` tags (large-codebase injection) — dispatch each
   shard as its own parallel `Task` (pass its `shard` + `scope`), and track each as a separate auditor in
   the completeness loop.** Each auditor prompt MUST include:
   - the **scope**: `repo`, assigned directories, `out_of_scope`, `mode`, `target_url`, `tools_available`,
     and the `shard` tag if the class was sharded;
   - the **completeness mandate**: "Trace EVERY source in your assigned scope across your class(es). You
     are done only when every enumerated source→sink path has a verdict and every safe vector is
     recorded — not after the first finding. There is no time budget; completeness is the goal. Apply
     depth: <{depth} guidance>. Report back with a status of `complete` or `incomplete` + what remains.";
   - the reminder to write findings per `plugins/codeaudit/skills/code-audit/reference/REPORT_CONTRACT.md`
     and record safe vectors.
4. Log `phase":"audit","action":"deploy-auditors","count":<N>,"wave":1`.

Depth guidance to inject: **Quick** = high-confidence sinks and primary paths only, stop tracing a path
once a clear verdict is reached; **Standard** = all enumerated sources, primary + obvious secondary
paths; **Thorough** (default) = every source, every path fork, follow helpers/branches and second-order
flows. Depth controls *how far each path is chased*, never *how many paths* — all in-scope sources are
always covered.

### Step 6.5 — Completeness loop

Monitor auditors with non-blocking `TaskOutput`. The audit is complete only when every dispatched auditor
has **terminated** and each terminated auditor is either `complete` or has had its unfinished scope
recorded as a coverage gap — a still-running or silently-dead auditor is never "complete". Loop:

1. When an auditor's `Task` **terminates**, read its reported status. Every terminated auditor is in one of
   three states — do not conflate them:
   - **`complete`** — proceed.
   - **`incomplete`** — handle per point 2.
   - **terminated with no parseable `complete`/`incomplete` status** (it errored, OOM'd, timed out, was
     killed, or returned prose with no status line) — this is **not** "complete". Log `"status":"errored"`,
     re-dispatch it once on its full assigned scope; if the second run also returns no parseable status,
     record its entire assigned scope under `coverage_gaps` (reason: "auditor did not complete — class
     partially or never traced") and continue. **Never** treat a silent/dead auditor as done — that is how
     an entire OWASP class silently drops out of a report that still prints "all in-scope sources traced".
   A `Task` still running is not terminated: keep polling with non-blocking `TaskOutput` and evaluate
   status only once it has actually finished. Log
   `phase":"audit","action":"auditor-done","agent":"<name>","status":"<complete|incomplete|errored>","findings":<N>`.
2. **If an auditor reports `incomplete`** (untraced sources remain, a helper/branch it flagged needs
   deeper analysis, or it discovered new sources/second-order flows), re-dispatch it (or a focused
   follow-up) on the remaining items. Repeat until it reports `complete`. This is convergence on full
   coverage, not budget-spending.
3. **Run every planned wave.** The plan's `waves[]` may contain more than one wave of auditors — the
   planner orders classes by sink density but intends *every* wave to run (see audit-planner: "every
   wave still runs"). Once the current wave's auditors all report `complete`, dispatch the next wave in
   `deployment-plan.json` `waves[]` using the same parallel-`Task` pattern as Step 6.4.3, then resume
   this loop for it. The audit is **not** complete until every wave in the plan has been dispatched and
   its auditors have reported `complete`. Log
   `phase":"audit","action":"deploy-auditors","count":<N>,"wave":<W>` at each wave dispatch.
4. **Follow-up waves** (single parallel `Task` message), drawn from the plan's `escalation_plan`, only
   for genuine coverage/quality gains:
   - re-trace `probable` findings whose helpers/branches were not fully inspected → aim to raise to `high`;
   - **hybrid mode**: corroborate top injection/SSRF/XSS findings with a single benign witness request
     against `target_url`;
   - cover any newly-discovered sources or second-order flows surfaced during tracing.
5. **Stop when scope is exhausted — and prove it mechanically, do not accept it on trust.** An auditor's
   self-reported `complete` is a claim, not proof. Before declaring the audit done, reconcile *enumerated*
   sources against *verdicted* sources: take the `file:line` sources from `recon/sink-inventory.json`
   (`entry_points[].sources[]`) and `recon/attack-surface.md`, and diff them against the union of sources
   that appear in the findings (`finding-*/description.md`) and the per-class `_safe-*.md` files. Every
   enumerated in-scope source must land on one side — a real finding, a `tested_not_vulnerable` entry, or
   an explicit `coverage_gaps` item. Any source with **no verdict** means a `complete` was premature:
   re-dispatch that class on the missing sources (per point 2); do not exit while unverdicted in-scope
   sources remain. Only when every enumerated source has a verdict across **every planned wave**, and all
   `probable` items are confirmed or noted, is scope exhausted — the normal exit. Log
   `phase":"audit","action":"auditors-complete","findings_count":<N>,"sources_enumerated":<E>,"sources_verdicted":<V>,"result":"scope-exhausted"`
   (with `E == V`, or every shortfall listed in `coverage_gaps`).
   Do not manufacture additional work once coverage is complete.
6. **Semgrep Pro taint pass on the LARGE files (only if `semgrep` ∈ `tools_available`).**
   The auditors' free exploration reliably covers normal files, but no single LLM pass reaches deep into a
   giant multi-purpose file (10k–20k lines) — exactly where taint sinks hide (the missed SSRF sat at
   `spicemodels/views.py:11386` and `api/views.py:9601`). Semgrep **Pro**'s interprocedural dataflow does
   reach them (it followed `read_data_from_url(url) → urlopen(url)` across functions where both the OSS
   engine **and** the LLM found nothing). So run it **targeted at the big files only** — bounded cost: a
   handful of files, ~2–4 min each — with the registry packs **plus this plugin's custom rules** that close
   registry gaps (notably urllib `build_opener().open()`, which the registry SSRF rules miss).

   > **Why Pro, why big-files-only, why custom rules.** OSS semgrep found **0** on these files; only `--pro`
   > (interprocedural) works — but it is ~2–4 min per 19k-line file, so whole-tree Pro is hours. Target only
   > the few giant files where the LLM struggles; the auditors already cover the normal ones well. And even
   > Pro's registry misses `build_opener().open()` → the custom ruleset covers it.

   1. List in-scope source files over ~3000 lines (respect `out_of_scope`; take the ~10 largest):
      ```bash
      cd {repo}; for f in $(git ls-files '*.py' '*.js' '*.ts' '*.php' '*.rb' '*.java'); do
        n=$(wc -l < "$f"); [ "$n" -gt 3000 ] && echo "$n $f"; done | sort -rn | head -10 | awk '{print $2}'
      ```
   2. Run semgrep **Pro** on exactly those files, registry packs + this plugin's custom rules:
      ```bash
      semgrep scan --pro --metrics=off --timeout 120 --json \
        --config p/security-audit --config p/django \
        --config plugins/codeaudit/skills/code-audit/semgrep-rules/ \
        -o outputs/{engagement}/recon/semgrep-bigfiles.json <big-file-list> 2>/dev/null || true
      ```
      (If `--pro` is unavailable — engine not installed / not licensed — this step adds little here, since
      OSS finds ~nothing on these files; let it fail and move on.)
   3. Treat each result as an **additive candidate**, never an accepted finding. Map its `check_id`/`class`
      metadata to a class (`ssrf` / `xss` / `injection` / `redirect`→access-control / `deserial` / …); if its
      `path:line` is **not already verdicted** for that class, **dispatch that class's auditor once** to
      confirm-or-dismiss with a source→sink read. Semgrep has false positives → the auditor's verdict is
      authoritative, and semgrep **never** constrains the auditors' own exploration.
   Log `phase":"audit","action":"semgrep-bigfiles","files":<N>,"results":<M>,"dispatched":<K>`.

   **If `semgrep` is not in `tools_available`, skip this step** — the audit runs on the auditors' free
   exploration + their built-in rules alone, which independently cover the sinks semgrep's rules miss
   (`build_opener`/`file://`, DOM-in-`<script>`, content-type mismatch).

### Step 6.6 — Aggregate + report

1. **Verification + de-duplication pass.** Read every `outputs/{engagement}/findings/finding-*/description.md`,
   then:
   - **De-duplicate** across auditors that touched overlapping code — key on `(vuln_class, sink file:line,
     source file:line, slot_type)` using the **parsed** `file:line` (not the free-text expr, so
     `req.query.sort` and `req.query['sort']` collapse to one). Same key = one finding; merge evidence.
     A **different `slot_type` at the same line** (e.g. SQL-value vs SQL-identifier) is a distinct finding —
     do not merge those.
   - **Confidence gate**: a finding may carry `confidence: high` only if it has a complete, re-readable
     source→sink trace (or, in hybrid mode, a live corroboration). Downgrade anything with an
     uninspected helper/branch to `probable`, and anything lacking a complete path to `unconfirmed`
     (list the latter under `coverage_gaps`).
   - Gather each auditor's `_safe-*.md` into `tested_not_vulnerable`.
   - **Resolve ids & evidence**: keep each finding's on-disk class-prefixed dir name as its `id`
     (`finding-{prefix}-{NNN}`) — never renumber to a flat `finding-001`; set `evidence` to that dir's
     `description.md` and confirm the path resolves before writing the report (drop or flag any finding
     whose dir is missing). Keep `unconfirmed` items **out** of `findings[]` — they belong in
     `coverage_gaps` — so `summary.total` counts only `confidence ∈ {high, probable}`.
   - **Union sharded classes.** When **any** class ran as several shards (same agent, distinct `shard` tags
     — injection/xss/access-control/ssrf on a large codebase), gather every `_safe-{class}-{shard}.md` and
     all `finding-{prefix}-{shard}-*` dirs, and dedup findings across shards (they own disjoint sinks, so
     real overlap is limited to second-order cross-region paths). For **injection**, also union the
     per-sub-class coverage registers: a sub-class is **covered** only if **every** shard reports it `traced`
     or a seed-backed `no-surface`; sum the traced counts. If any shard reports `incomplete`/`errored` for
     its scope, the class is **not** complete — re-dispatch that shard (Step 6.5).
1b. **Resolve each finding's live endpoint (hybrid handoff, voie A).** Read
   `outputs/{engagement}/recon/sink-inventory.json` `entry_points`. For every **request-reachable** finding,
   take the param **name** and the **source `file:line`** from the finding's `source` string (strip the
   surrounding parens; use the *source* location embedded in `source`, **not** the finding's top-level
   `location`, which is the *sink*). Match that `(name, source file:line)` against an entry point's
   `sources[] {name, at}` (`at` is the bare `file:line`). On a unique match, set
   `endpoint { method, path, param, in }` — `method`/`path`/`in` from the matched entry point, `param` = the
   source name; `in` uses the fixed enum `query|path|header|cookie|json|form`. **Omit `endpoint`** when: no
   entry point matches, the route is dynamic (entry point has no `path`), or the param name matches **more
   than one** entry point and the source `file:line` can't disambiguate — never guess a path. (Non-request
   classes — secrets/crypto/deps/config/logging — get no endpoint.) When absent, the pentest handoff falls
   back to param correlation. To make this resolvable, findings **must** record the source with its
   `file:line` (see REPORT_CONTRACT `source` rule).
2. Present a findings summary to the operator via AskUserQuestion before writing the final report (total;
   critical/high/medium/low/info counts; confidence breakdown; top 3; coverage gaps). Confirm: "Write the
   final report now?"
3. On confirmation, produce the deliverables **exactly per** `plugins/codeaudit/skills/code-audit/reference/REPORT_CONTRACT.md`:
   - `outputs/{engagement}/codeaudit-report.json` — fixed schema (engagement/repo/commit/target_url
     metadata, findings[] with file:line/source/sink/slot/confidence/owasp **and `endpoint` when resolved
     in step 1b**, summary counts, tested_not_vulnerable, coverage_gaps, and the audit `depth`).
     `coverage_gaps` lists anything left
     unconfirmed (e.g. a class with no scanner installed) — there is no time-based de-scoping.
   - `outputs/{engagement}/report.md` — REQUIRED consolidated human report from the fixed template.
   - Keep per-finding markdown under `findings/finding-*/` as the depth layer.
4. **Operator-selected extra formats** (from `output_formats`) — produce each ON TOP of the required pair:
   - "Executive summary" → `exec-summary.md` (1-page, non-technical).
   - "Remediation plan" → `remediation-plan.md` (ticket-style, grouped by fix).
   - "CSV findings table" → `findings.csv`.
   - "SARIF" → `codeaudit.sarif` (SARIF 2.1.0: one result per finding, `physicalLocation` = file + line,
     `level` from severity, `ruleId` = `{vuln_class}/{cwe}`). This enables CI / code-scanning ingestion.
   - "PDF render" → render `report.md` via pandoc if available:
     ```bash
     command -v pandoc >/dev/null 2>&1 && pandoc "outputs/{engagement}/report.md" -o "outputs/{engagement}/report.pdf"
     ```
     If pandoc is missing, skip and warn (`PDF requested but pandoc is not available — delivered report.md
     instead.`) — graceful degradation, never fail the run.
5. Log `phase":"report","action":"report-written","path":"outputs/{engagement}/codeaudit-report.json","formats":<output_formats>,"result":"complete"` and tell the operator where the deliverables are.

Do not ask for additional confirmation before Step 6.1 — the audit summary is the launch confirmation.
The operator gates remain at Step 6.4 (plan approval) and Step 6.6 (pre-report).
