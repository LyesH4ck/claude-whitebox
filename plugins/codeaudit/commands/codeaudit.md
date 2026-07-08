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
`target_url`, `depth` (default `"Thorough"`), and `output_formats` (default `[]`). Output:

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
`target_url`, and `classes`. Wait for completion. Confirm it wrote `recon/architecture.md`,
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

1. Read `plan/deployment-plan.json` and present `plan/audit-plan.md` to the operator via AskUserQuestion
   (Approve / Modify / Cancel). On Modify, adjust and re-present. On Cancel, log and stop.
2. On approval, dispatch every auditor in wave 1 **in parallel — all `Task` calls in a single message**,
   `run_in_background=True`, using the real agent names from the plan. Each auditor prompt MUST include:
   - the **scope**: `repo`, assigned directories, `out_of_scope`, `mode`, `target_url`, `tools_available`;
   - the **completeness mandate**: "Trace EVERY source in your assigned scope across your class(es). You
     are done only when every enumerated source→sink path has a verdict and every safe vector is
     recorded — not after the first finding. There is no time budget; completeness is the goal. Apply
     depth: <{depth} guidance>. Report back with a status of `complete` or `incomplete` + what remains.";
   - the reminder to write findings per `plugins/codeaudit/skills/code-audit/reference/REPORT_CONTRACT.md`
     and record safe vectors.
3. Log `phase":"audit","action":"deploy-auditors","count":<N>,"wave":1`.

Depth guidance to inject: **Quick** = high-confidence sinks and primary paths only, stop tracing a path
once a clear verdict is reached; **Standard** = all enumerated sources, primary + obvious secondary
paths; **Thorough** (default) = every source, every path fork, follow helpers/branches and second-order
flows. Depth controls *how far each path is chased*, never *how many paths* — all in-scope sources are
always covered.

### Step 6.5 — Completeness loop

Monitor auditors with non-blocking `TaskOutput`. The audit is complete when every dispatched auditor
reports `complete`. Loop:

1. When an auditor finishes, check its reported status. Log
   `phase":"audit","action":"auditor-done","agent":"<name>","status":"<complete|incomplete>","findings":<N>`.
2. **If an auditor reports `incomplete`** (untraced sources remain, a helper/branch it flagged needs
   deeper analysis, or it discovered new sources/second-order flows), re-dispatch it (or a focused
   follow-up) on the remaining items. Repeat until it reports `complete`. This is convergence on full
   coverage, not budget-spending.
3. **Run every planned wave.** The plan's `waves[]` may contain more than one wave of auditors — the
   planner orders classes by sink density but intends *every* wave to run (see audit-planner: "every
   wave still runs"). Once the current wave's auditors all report `complete`, dispatch the next wave in
   `deployment-plan.json` `waves[]` using the same parallel-`Task` pattern as Step 6.4.2, then resume
   this loop for it. The audit is **not** complete until every wave in the plan has been dispatched and
   its auditors have reported `complete`. Log
   `phase":"audit","action":"deploy-auditors","count":<N>,"wave":<W>` at each wave dispatch.
4. **Follow-up waves** (single parallel `Task` message), drawn from the plan's `escalation_plan`, only
   for genuine coverage/quality gains:
   - re-trace `probable` findings whose helpers/branches were not fully inspected → aim to raise to `high`;
   - **hybrid mode**: corroborate top injection/SSRF/XSS findings with a single benign witness request
     against `target_url`;
   - cover any newly-discovered sources or second-order flows surfaced during tracing.
5. **Stop when scope is exhausted** — every enumerated source traced across every selected class with
   surface across **every planned wave**, all `probable` items either confirmed or noted. This is the
   normal exit. Log
   `phase":"audit","action":"auditors-complete","findings_count":<N>,"result":"scope-exhausted"`.
   Do not manufacture additional work once coverage is complete.

### Step 6.6 — Aggregate + report

1. **Verification + de-duplication pass.** Read every `outputs/{engagement}/findings/finding-*/description.md`,
   then:
   - **De-duplicate** across auditors that touched overlapping code (same vuln-class + file:line +
     source = one finding; merge evidence).
   - **Confidence gate**: a finding may carry `confidence: high` only if it has a complete, re-readable
     source→sink trace (or, in hybrid mode, a live corroboration). Downgrade anything with an
     uninspected helper/branch to `probable`, and anything lacking a complete path to `unconfirmed`
     (list the latter under `coverage_gaps`).
   - Gather each auditor's `_safe-*.md` into `tested_not_vulnerable`.
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
