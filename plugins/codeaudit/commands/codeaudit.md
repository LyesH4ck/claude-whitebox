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
`target_url`, `depth` (default `"Thorough"`), `output_formats` (default `[]`), `extra_roots` (default
`[]` — sibling first-party repos/dirs to fold into scope, e.g. a separate front-end service), and
`previous_report` (default `null` — an older `codeaudit-report.json` of the same repo to diff this run
against). Output:

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
  "previous_report": {previous_report or null},
  "status": "active"
}
```

Then verify the repo: `git -C "{repo}" rev-parse --is-inside-work-tree 2>/dev/null | grep -q true && echo git
|| echo no-git` — not a test for a `.git` directory, which a subdirectory of a larger checkout does not have
and is still fully tracked. If `{repo}` does not exist, abort with an actionable message and stop. Note
whether it is tracked (auditors use git-awareness).

**Resolve the three cross-run inputs now, so the scope echo states them.** All are optional; the first two
feed the Step 6.6 aggregator, the third reaches every agent's brief.
- **`context_file`** — `{repo}/.codeaudit-context.md` when it exists (`reference/PROJECT_CONTEXT.md`): the
  operator's standing statement of what the system is and what has already been decided. Validate it
  mechanically — `python3 -I "$CA/tools/context.py" check "{repo}/.codeaudit-context.md"` — and show the
  operator any problem it prints (a missing heading, an over-budget file, a leftover seed placeholder) before
  continuing; a malformed context file is carried as-is, never silently dropped. When absent, note
  `context_file: null` and tell the threat-modeler to **seed** it in Step 6.2b.
- **`previous_report`** — if the scope file names one, use it. Otherwise look for an older report of the same
  repository: `ls outputs/*/codeaudit-report.json` from the launch directory, keep those whose `repo` field
  equals `{repo}` and whose `engagement` is not this one, and take the most recent by `date`. If one is found
  and the scope file did not name it, ask via AskUserQuestion: "Diff this run against `{path}` ({date})?" with
  Yes / No. Store the result as `previous_report` (or `null`).
- **`accepted_file`** — `{repo}/.codeaudit-accepted.json` when it exists (format in `REPORT_CONTRACT.md` →
  *The accepted-risk file*), else `null`. Never create it yourself; it is operator-owned.
Echo all three as `Context file: {path or "none — will be seeded"}`, `Previous report: {path or "none — first
run or not requested"}` and `Accepted risks: {path or "none"}` in the summaries below.

**Always append `outputs/` to `out_of_scope`.** The deliverables are written to `outputs/{engagement}/`
relative to the launch directory, and the supported way to run this is **from inside the repository being
audited** — so without the exclusion, recon inventories the audit's own findings, the auditors trace the
report's own example payloads, and the second run of an engagement audits the first one's output. Add it
even when the operator supplied an `out_of_scope`, and say so in the scope echo.

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
- "Run all classes — audit the full set of 17 classes (core 10 + extended 7)"

If "Use this profile": set `classes` from the file, update its `"status"` to `"active"`.
If "Run all classes": set `classes = ["injection","xss","auth","access-control","ssrf","secrets","crypto","deps","config","logging","business-logic","feature-abuse","data-lifecycle","client-side","http-protocol","ai-llm","resource-exhaustion"]`
(the core ten + the extended seven; the planner skips any class with no surface in the baseline, so
non-applicable extended classes — e.g. `ai-llm` on a non-AI app — cost nothing).

**If the file does not exist**, use AskUserQuestion with **multiSelect: true**:

"Which vulnerability classes should the audit cover? (Select all that apply — default is all seventeen.)"

Options (multi-select) — **core ten**:
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

…and the **extended seven** (design/logic & modern surfaces):
- "Business logic — state-machine skip/replay, business races, numeric/temporal abuse, insecure fallback (A04)"
- "Feature abuse — export=exfil, import=injection, search/enumeration oracle, preview/webhook leakage (A04/A01)"
- "Data lifecycle — multi-tenant isolation, cache/index ACL drift, soft-delete bypass, stale authz, export scope (A01)"
- "Client-side — DOM XSS, DOM clobbering, prototype pollution, postMessage/CORS, service-worker, XS-Leaks, clickjacking"
- "HTTP protocol — request smuggling/desync, cache poisoning/deception, host-header trust, response splitting (A05)"
- "AI/LLM — indirect prompt injection, tool-arg→sink, confused-deputy agency, MCP identity, insecure output"
- "Resource exhaustion — ReDoS/superlinear parsing, decompression bombs, query amplification, unbounded buffering, descriptor leaks, retry/poison-record storms (A04)"

Map selections to these class keys — core: `injection`, `xss`, `auth`, `access-control`, `ssrf`, `secrets`,
`crypto`, `deps`, `config`, `logging`; extended: `business-logic`, `feature-abuse`, `data-lifecycle`,
`client-side`, `http-protocol`, `ai-llm`, `resource-exhaustion`. If none selected, default to all
seventeen. Store as `classes`.

## Step 4 — Tooling Check (optional scanners)

Probe for optional scanners that auditors will prefer if present (never install anything):
```bash
for t in gitleaks trufflehog osv-scanner pip-audit govulncheck trivy pandoc; do
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
Context file:    {context_file or "none — will be seeded by the threat-modeler"}
Previous report: {previous_report or "none — first run or not requested"}
Accepted risks:  {accepted_file or "none"}
Deliverables: report.md + codeaudit-report.json{, plus output_formats if any}
============================================================
```

## Step 6 — Audit Execution (this command owns orchestration)

> **Why the command runs the audit.** This harness allows only **one level of subagent nesting**. This
> command runs in the main session and CAN spawn agents via `Task`. Any agent it spawns (including the
> planner, `code-recon` and the `threat-modeler`) is a subagent and CANNOT spawn further agents. So this
> command — not the planner — dispatches `code-recon` and the `threat-modeler`, invokes the planner,
> dispatches the auditors, runs the completeness loop, dispatches the `adversarial-sweep` agents, aggregates,
> and reports. The `audit-planner` agent is a **planner only**.

> **Completeness, not budget.** A code audit has a finite scope: the set of sources and sinks in the
> code. The audit is **done when every enumerated source→sink path has been analyzed across the selected
> classes** — that is the normal, expected exit, not a quota running out. There is no timer. Do not stop
> early while untraced sources remain; do not invent extra work once the scope is exhausted.

Maintain an activity log at `outputs/{engagement}/activity/codeaudit-orchestrator.log` (NDJSON) —
append a line at every phase boundary and dispatch.

### Step 6.0 — Preflight (cheap, deterministic, before anything is spent)

Run it before the first agent is dispatched. Resolve the plugin root first — **you may be running from
inside the repository being audited**, where nothing of codeaudit's is relative:

```bash
CA="${CLAUDE_PLUGIN_ROOT:-}"
[ -f "$CA/preflight.mjs" ] || CA="$(ls -d ~/.claude/plugins/cache/*/codeaudit/*/ 2>/dev/null | sort -V | tail -1)"
CA="${CA%/}"; [ -f "$CA/preflight.mjs" ] || CA="plugins/codeaudit"
test -f "$CA/preflight.mjs" || { echo "CODEAUDIT-ROOT-NOT-FOUND"; }
node "$CA/preflight.mjs" --repo "{repo}"
```

Keep `$CA` for the rest of the run: every path below that starts with `$CA/` means "inside the installed
plugin", never "inside the audited repository".

It costs no model tokens and checks the two things that fail **silently** at run time:

- **The plugin's own integrity** — every agent's `Read plugins/...` mount path resolves *from this launch
  directory*, every dispatched agent exists, the disposition / privilege / ecosystem-key enums agree across
  files, the four `_safe` headings the aggregator splits on are identical everywhere, and every
  `outputs/{engagement}/…` artifact has a producer.
- **Whether the target is auditable** — git-tracked or not, and which ecosystems have a resolvable lockfile.

Act on the exit code:

| Exit | Meaning | Do |
|---|---|---|
| `0` | clean | proceed |
| `1` | warnings only | proceed, and **carry each warning into the final report's `coverage_gaps`** — they describe where this audit is weaker (no lockfile → version-gated rows become gaps; no `.git` → the tracking rule demotes findings) |
| `2` | blocking | **stop.** Report the problem to the operator and do not dispatch |

> **Why an exit-2 must stop the run.** The dominant blocking case is a mount path that does not resolve from
> the launch directory. When that happens the auditors do not fail — they proceed with **no** methodology,
> **no** report contract and **no** ecosystem files, and still write a confident, well-formatted report. The
> run looks successful and is worthless, and nothing downstream can tell the difference. Launching from the
> marketplace checkout is what makes those paths resolve.

Log `phase":"preflight","exit":<0|1|2>,"blocking":<N>,"warnings":<M>`.

### Step 6.1 — Initialize

```bash
mkdir -p "outputs/{engagement}/activity" "outputs/{engagement}/recon" "outputs/{engagement}/plan" "outputs/{engagement}/findings"
cd "{repo}" && git rev-parse --short HEAD 2>/dev/null   # → COMMIT (or "n/a")
```
If `outputs/` sits on a network or virtual-machine mount (a macOS directory seen from a Linux VM, an SMB or
NFS share), shell-level file creation from agents can hang in uninterruptible I/O with no error and no
status — which the completeness loop must not mistake for a finished auditor. In that situation tell every
agent, in its brief, to create files with the **Write tool only** (it creates parent directories), to wrap
any Bash that touches the mount in `timeout 20`, and to enumerate with `git ls-files` instead of `find`/`rg`.
A `mkdir -p` from the orchestrator here, once, is fine; a hundred from agents is how an engagement stalls.
Log:
```json
{"timestamp":"<ISO>","agent":"codeaudit-orchestrator","phase":"init","repo":"{repo}","commit":"<COMMIT>","depth":"{depth}","classes":<classes>,"mode":"<static|hybrid>","result":"started"}
```

### Step 6.2 — Code-recon baseline

Dispatch the **code-recon** agent via `Task`. Pass `repo`, `engagement`, `focus`, `out_of_scope`,
`target_url`, `extra_roots`, `classes`, and `context_file` (or `null`). Wait for completion. Confirm it wrote `recon/architecture.md`,
`recon/attack-surface.md`, and `recon/sink-inventory.json` — and that `sink-inventory.json` carries a
non-empty **`ecosystems[]`** (the per-stack reference routing + version pins every auditor consumes in Step
6.4). If `ecosystems` is missing or empty while the repo clearly has a manifest, re-dispatch recon once for
that field alone; if it is still empty, continue but note in the audit log and the final report's
`coverage_gaps` that version-gated checks ran without resolved pins. If recon fails or finds zero sources/sinks,
warn the operator (possibly wrong repo or unsupported stack) and ask whether to continue. Log
`phase":"recon","action":"baseline-complete","sources":<N>,"sinks":<M>`.

**Then gate the baseline mechanically before anything consumes it.** Recon's `complete` is a claim about the
files it read; the threat model, the planner and every auditor inherit whatever it did not. Run:
```bash
python3 -I "$CA/tools/recon-coverage.py" "outputs/{engagement}" --repo "{repo}" --out-of-scope "{out_of_scope}"
```
It lists every tracked source file that carries a route-shaped marker for its language (a route
registration, an HTTP-method export, a controller, a server action, a queue consumer, a cron or webhook
handler) and checks each against the handler files in `entry_points[]` / `exported_surface[]`. It writes
`recon/_coverage.json` and prints the uncovered files grouped by directory. Exit `1` is a failed gate: a
directory of three or more route-shaped files with none in the inventory, or fewer than half of all
route-shaped files covered.
- On a failed gate, **re-dispatch code-recon once** with the residue — the uncovered directories, verbatim
  from the tool's output — as `focus`, telling it to extend `entry_points[]`/`exported_surface[]` (never
  rewrite) and to say explicitly, for any residue file that is **not** an entry point, what it is. Re-run the
  tool after it lands.
- A still-failing gate does not stop the audit, but it changes what the report may claim: log
  `phase":"recon","action":"coverage-gate","result":"failed","uncovered":<n>` and carry every remaining
  uncovered file into the final report's `coverage_gaps` ("route-shaped file never inventoried by recon").
- A passing gate with a short residue is normal: a marker hit on a file that is not an entry point (a test
  helper, a matcher's own example strings, a docs snippet) is noise, and you record it nowhere. Read the
  list before deciding — on a real engagement the residue is where the missed family lives.
Log `phase":"recon","action":"coverage-gate","result":"<passed|failed>","route_shaped":<R>,"covered":<C>,"uncovered":<U>`.

### Step 6.2b — Threat model (the audit's security contract)

Dispatch the **threat-modeler** agent via `Task`, pointing it at the baseline. Pass `repo`, `engagement`,
`focus`, `out_of_scope`, `target_url`, `classes`, the `ecosystems[]` array from `sink-inventory.json`, and
`context_file` with one of two instructions: **"read it first; its statements are `documented` provenance"**
when it exists, or **"seed it after writing the model, per `reference/PROJECT_CONTEXT.md`"** when it does not.
Wait for completion. If it seeded the file, tell the operator in one line that `{repo}/.codeaudit-context.md`
now exists, is agent-written, and should be reviewed and committed — it is theirs from here on.

This runs **after** recon and **before** the planner because both the plan and every auditor consume it:
recon says what exists, the threat model says what is supposed to be true, and a rule-out that cites the
model is auditable where "looks fine" is not.

Validate `recon/threat-model.json` the way you validate the plan — the agent is Task-blind and can fail
quietly. It must parse as JSON and carry a non-empty `entry_points[]` and a `dispositions[]` array. If it is
missing or unparseable, re-dispatch once; if it fails again, **continue without it** and log
`phase":"threat-model","result":"unavailable"`. The audit still works unmodelled: auditors fall back to
free-text rule-out reasons and the three `out_of_model_*` dispositions simply become unavailable. Note the
absence in the final report's `coverage_gaps` — an unmodelled audit is a weaker claim, and the report should
say so rather than look identical to a modelled one.

Log `phase":"threat-model","action":"model-complete","entry_point_rows":<R>,"documented":<N>,"inferred":<M>,"open_questions":<Q>`.

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
- Threat model: `outputs/{engagement}/recon/threat-model.json` (absent if Step 6.2b failed)

Read the threat model when present. Use `components[]` and `trust_boundaries[]` to scope auditors to the
component families they actually apply to, and `entry_points[]` attacker-controllability to order waves —
a class whose only sinks sit behind parameters the model marks `attacker_controllable: "no"` is a lower
priority than one reachable from an unauthenticated row, though **neither is a reason to skip a class**:
the model is a hypothesis the auditors may overturn, not a filter. Record in `skipped` only classes with
genuinely **no surface** in the sink inventory.

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
   - the **context file** (when it exists): the path `{repo}/.codeaudit-context.md`, with the instruction
     "read it before tracing; its *Known non-findings* are hypotheses with provenance — cite one as
     `by_design` only after confirming the current code still matches it" (`SKILL.md` → *The project context
     file*);
   - the **threat model** (when Step 6.2b produced one): the path `outputs/{engagement}/recon/threat-model.json`,
     with the instruction "read it before tracing; look each sink's entry point and parameter up in
     `entry_points[]` and carry the row's `condition` into your severity and `privilege_required`; when you
     rule a sink out, open the `[disposition]` with the model field that backs it (`entry_points[i]`,
     `adversaries.out_of_scope`, `out_of_scope[i]`, `build_variants[i]`, `known_non_findings[i]`). Treat
     `provenance: "inferred"` rows as hypotheses you may overturn from code — a rule-out resting **only** on
     an inferred claim is `model_gap`, not a clearance. A sink whose entry point is absent from the table is
     also `model_gap`: the model is incomplete, which is a signal to revisit, not a reason to drop the sink."
     When no model exists, say so in the prompt and have the auditor use free-text rule-out reasons with the
     base six dispositions;
   - the **ecosystem routing**: the `ecosystems[]` array verbatim from `recon/sink-inventory.json` (keys +
     runtime + pinned versions), with the instruction "load
     `$CA/skills/code-audit/reference/ecosystems/<key>.md` for every key listed, and compare
     every version-sensitive claim against the pins given — do not re-derive them". Recon resolved these once;
     an auditor that re-greps the lockfile is wasting turns and may disagree with its siblings. If
     `ecosystems` is absent or empty (recon could not resolve a stack), say so in the prompt and have the
     auditor record the affected version-gated checks under `coverage_gaps` rather than guessing;
   - the **completeness mandate**: "Trace EVERY source in your assigned scope across your class(es). You
     are done only when every enumerated source→sink path has a verdict and every safe vector is
     recorded — not after the first finding. There is no time budget; completeness is the goal. Apply
     depth: <{depth} guidance>. Report back with a status of `complete` or `incomplete` + what remains.";
   - the reminder to write findings per `$CA/skills/code-audit/reference/REPORT_CONTRACT.md`
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
   `phase":"audit","action":"auditor-done","agent":"<name>","status":"<complete|incomplete|errored>","findings":<N>,"skipped":<n|"unanswered">`.

   **Read the skipped register off the same status.** Every auditor must end with `SKIPPED: none` or
   `SKIPPED: <n>` (`SKILL.md` → *The skipped register*), the `<n>` paths listed as `- [skipped] path — why`
   lines under `## coverage_gaps` of its `_safe-` file. Three cases:
   - `SKIPPED: none` — nothing more to do.
   - `SKIPPED: <n>` — the auditor's `complete` does **not** cover those paths. Treat them exactly like the
     uncited residue of point 5: dispatch one focused follow-up on the skipped paths (a different auditor of
     the same class if the reason was a refusal — the same agent will refuse the same file again), and keep
     the `[skipped]` lines in place until the follow-up has verdicted them; the aggregator lists whatever
     remains under `skipped_paths`, and that is the correct report when a file genuinely cannot be analysed.
   - **no `SKIPPED:` line at all** — the register was not answered. Log `"skipped":"unanswered"` and
     message the agent once, tool-free, asking only for the register; if it still does not answer, record the
     auditor's whole scope under `coverage_gaps` with the reason "skipped register unanswered" — an unanswered
     register is indistinguishable from a silent refusal, and both read as "all traced" if you let them.
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
   sources against *verdicted* sources with the shipped tool — never by eye, the lists run to hundreds:
   ```bash
   python3 -I "$CA/tools/reconcile.py" "outputs/{engagement}"
   ```
   It takes every `file:line` source from `recon/sink-inventory.json` (`entry_points[].sources[].at`), diffs
   it against every `finding-*/*.md` and `_safe-*.md`, expands path aliases an auditor declared at the top
   of its evidence file (``` `H/` = `routes/route-handlers/` ```), writes `recon/_reconciliation.json` and
   prints the **uncited** residue grouped by file. Every enumerated in-scope source must land on one side —
   a real finding, a `tested_not_vulnerable` entry, or an explicit `coverage_gaps` item. Any source with
   **no verdict** means a `complete` was premature: write the residue as a hand-off brief
   (`plan/_handoffs-residue-f{N}.md`: one block per file listing its sources, the guard to cite, the classes
   to verdict, the settled items to cite rather than re-derive) and dispatch **one focused follow-up** on
   those files (per point 2) — on a real engagement that residue follow-up filed the audit's highest
   server-side finding in handler files three waves had never cited. Re-run the tool after it lands; do not
   exit while unverdicted in-scope sources remain. Only when every enumerated source has a verdict across **every planned wave**, and all
   `probable` items are confirmed or noted, is scope exhausted — the normal exit. Log
   `phase":"audit","action":"auditors-complete","findings_count":<N>,"sources_enumerated":<E>,"sources_verdicted":<V>,"result":"scope-exhausted"`
   (with `E == V`, or every shortfall listed in `coverage_gaps`).
   Do not manufacture additional work once coverage is complete.

> The auditors' own free exploration + their built-in rules are the engine — they independently reach the
> deep sinks in large files (a real 1,133-sink Django audit found every critical, incl. an SSRF at line
> 11 384, with ~6 focused shards and no external scanner). There is **no semgrep/external-taint step**: it
> proved redundant (the LLM caught sinks semgrep missed, e.g. `build_opener().open()`), unreliable (skipped),
> and slow. Keep the `build_opener`/`file://`, DOM-in-`<script>` and content-type-mismatch rules in the
> auditors — that is what does the work.

### Step 6.5b — Adversarial sweep (the check on the plan itself)

Scope exhaustion in 6.5 means *every source the plan enumerated* has a verdict. It says nothing about what
the plan never enumerated — and recon, the threat model and the planner can all be wrong in the same
direction at once. A class that was never allocated is not reported as missing; it is simply absent. This
step is the check on that, and it is cheap: **two agents, run once, in parallel.**

Dispatch both **adversarial-sweep** agents in a single parallel `Task` message:

1. **`mode: blind-dig`** — pick **one directory containing first-party source that no auditor was scoped to**.
   Start from the planner's `unplanned_components[]` (it was asked to name exactly these, with a reason each —
   a `REVIEW:` reason is the first candidate), then diff the plan's assigned directories against the source
   tree to catch what the planner did not list. Exclude the operator's `out_of_scope`,
   vendored/generated trees (`node_modules/`, `vendor/`, `dist/`, `build/`), and test/fixture/example
   directories. Choose **deterministically** so a re-run of the same engagement picks the same target: sort
   the candidate paths lexicographically and take index `(sum of the engagement name's character codes) mod
   count` — a rule you can actually execute, not an abstract "stable hash".

   > **"No uncovered directory" almost never means full coverage.** The planner routinely scopes auditors to
   > the repo root or to broad globs, which makes the strict set-difference empty on a perfectly ordinary
   > audit — and the sweep that exists to find what the plan missed would then never run on any default
   > audit. So fall back, in order: (1) directories no auditor was scoped to; (2) if none, directories that
   > appear in **no** `finding-*` and **no** `_safe-*.md` — code the audit touched but never reported on
   > either side; (3) if none, the source directory with the lowest ratio of verdicted sources to files.
   > Only when the repo has a single source directory is the sweep genuinely inapplicable; log that as
   > `"blind-dig":"skipped — single source directory"`. Never log a skip as evidence of coverage: it is the
   > absence of a check, not the result of one.

   > **Context isolation is this sweep's whole method — you enforce it, not the agent.** Its prompt gets the
   > repo path, the one directory, and the scope boundaries. It gets **no** threat model, **no** recon
   > baseline or sink inventory, **no** plan, **no** existing findings, and **no** `.codeaudit-context.md`
   > path (its *Known non-findings* are prior decisions), and you must not summarise any of them into the
   > prompt either. Every one of those encodes a prior decision about where the bugs are;
   > passing one reproduces the blind spot the sweep exists to find. If you catch yourself writing "recon
   > found X here" into this prompt, delete it.

2. **`mode: challenge-exclusion`** — pick **one exclusion the audit itself made**: a `skipped` entry from
   `plan/deployment-plan.json`, a `components[].in_scope: false` or `out_of_scope[]` entry from the threat
   model. Same deterministic selection. Pass the exclusion **and its stated reason**, plus the threat model
   (it is the thing under test). Do **not** pass the findings or the plan. Prefer an exclusion whose
   provenance is `inferred` over one that is `documented` — an inferred exclusion is the audit's own guess
   and is the likelier mistake. If the audit made no exclusions at all, skip and log it.

   > The operator's `out_of_scope` from the scope file is **not** eligible. That is a boundary, not an
   > exclusion to challenge — never dispatch a sweep into code the operator excluded.

**Namespace each sweep by mode.** The two run in parallel, so they must not share an id space: pass each one
its `finding-sweep-{mode}-{NNN}` prefix (`finding-sweep-blind-001`, `finding-sweep-excl-001`) and its own
`_safe-sweep-{mode}.md`. Both starting at `finding-sweep-001` means whichever writes second silently clobbers
the first — in the one bucket holding what no auditor was scoped to find.

Both sweeps write findings in the normal shape, so Step 6.6 de-duplicates, caps and aggregates them with
everything else — a sweep finding that duplicates a wave finding collapses normally. Treat a sweep exactly
like an auditor in the status handling of 6.5 (`complete` / `incomplete` / terminated-without-status), with
one difference: **a sweep returning zero findings is a normal, expected result**, not a signal to re-dispatch.
Do not re-run a sweep to try to make it find something.

Log `phase":"sweep","action":"sweeps-complete","blind_dig_target":"<dir|skipped>","exclusion_challenged":"<item|skipped>","exclusion_held":<true|false|null>,"findings":<N>`.

### Step 6.5c — Independent verification (the second opinion on every serious claim)

Every finding so far was written by the agent that found it, and an auditor that has just traced a path is
the least adversarial reader of that path. This step gives each serious finding a **second agent that tries
to refute it** from source — rebuilding the trace from the sink instead of trusting the filed one, hunting
the guard the filer missed, checking git history for a fix — and writes a cited verdict next to the claim.
On a static audit this pass is where most false positives die, and it is cheap: one read-only agent per
batch, after all the tracing is done.

1. **Select.** Run the aggregator read-only to see the filed set after caps:
   ```bash
   python3 -I "$CA/tools/aggregate.py" "outputs/{engagement}" --dry-run
   ```
   Select every finding whose **final** severity (after caps) is `high` or `critical`. When the whole filed
   set is small (twelve findings or fewer), select all of them — the pass costs less than the arguing it
   prevents. Skip nothing in the selected band: a finding that "obviously holds" is exactly the kind a
   second reader is for. Log `phase":"verify","action":"select","selected":<N>,"of":<M>`.
2. **Batch and dispatch.** Split the selection into batches of at most six finding directories, grouped by
   class where possible, tagged `v1`, `v2`, …. Dispatch the **finding-verifier** agent via `Task` once per
   batch, **all in a single parallel message**, `run_in_background=True`. Each brief carries: `repo`,
   `engagement`, the `batch` tag, the `finding_dirs[]` (full paths), `out_of_scope`, the `ecosystems[]`
   array verbatim from `recon/sink-inventory.json`, and the threat-model path when Step 6.2b produced one.
   Pass `context_file` too when it exists — it is the operator's statement, not an auditor's reasoning.
   **Pass nothing else**: no `_safe-*.md`, no recon narrative, no plan, no previous report, and no summary
   of what the filing auditor concluded — the verifier's independence is the whole value of the step, and
   it is yours to protect, not the agent's. Log
   `phase":"verify","action":"dispatch","batches":<B>`.
3. **Collect.** Treat each verifier like an auditor in the status handling of 6.5 (`complete` /
   `incomplete` / terminated-without-status) **and read its skipped register**: a directory in its batch
   with no `verification.md` and no `[skipped]` entry means the batch did not complete. Re-dispatch once on
   the missing directories; what still lacks a verdict afterwards stays unverified and the aggregator records
   it under `coverage_gaps` (point 4). Log
   `phase":"verify","action":"batch-done","batch":"<tag>","confirmed":<c>,"refuted":<r>,"uncertain":<u>,"skipped":<n|"unanswered">`.
4. **What the verdicts do — and what you may do about them.** The aggregator (Step 6.6) applies them
   mechanically, so you do not edit a finding by hand:
   - `confirmed` → the finding stays, carrying `revalidation`; an `Adjusted severity` becomes a recorded
     `severity_revision` by the verifier (caps still apply afterwards); an `Adjusted confidence` replaces the
     filer's.
   - `uncertain` → the finding stays; a `high` confidence drops to `probable` with the verifier's blocker
     noted.
   - `refuted` **with a disposition and a cited `file:line`** → the finding leaves `findings[]`, lands under
     `tested_not_vulnerable` with that disposition and citation, and is listed under the report's `refuted[]`
     so the removal is visible. A refutation **without** a citation is downgraded to `uncertain` with a
     contract violation — an uncited opinion never removes a finding.
   - **Spot-check every refutation of a `critical` or `high` finding yourself**: open the cited line. If the
     citation does not discharge the finding (the guard is on a sibling variable, the "enum" is user-fed
     upstream, the version row does not match the pin), reinstate it by writing a
     `verification_overrides` entry in `plan/_relations.json` — `{ "id", "reason", "by", "evidence" }` —
     which turns the verdict into `uncertain` and records who overrode it and why. Never delete a
     `verification.md`, and never override a refutation you merely dislike: the override needs the line
     that shows the citation wrong.
   - Pass `--verified-min high` to the aggregator in Step 6.6 so a `high`/`critical` finding that still has
     no verdict after the re-dispatch is a visible `coverage_gaps` entry, not a quiet omission.
   Log `phase":"verify","action":"verify-complete","verified":<N>,"confirmed":<c>,"refuted":<r>,"uncertain":<u>,"unverified":<k>`.

### Step 6.6 — Aggregate + report

The mechanical half of this step is a shipped tool; run it, read its violations, then do the judgement half:
```bash
python3 -I "$CA/tools/aggregate.py" "outputs/{engagement}" --dry-run          # parse everything, write nothing
python3 -I "$CA/tools/aggregate.py" "outputs/{engagement}" --write \
        --relations outputs/{engagement}/plan/_relations.json --meta outputs/{engagement}/plan/_meta.json \
        {--previous "{previous_report}" when set} {--accepted "{accepted_file}" when set} \
        --verified-min high
```
`--dry-run` prints every contract deviation it found (a `Severity` outside the enum, a `tested_not_vulnerable`
line without a `[disposition]`, a `source` with no `file:line`) and the per-finding table
(`reported -> final` severity, confidence, privilege, fingerprint, change, resolved endpoint). Fix what is
yours to fix (a malformed file is re-dispatched to its auditor, never hand-edited), write
`plan/_relations.json` (point 1, "Relate what you did not merge") and `plan/_meta.json`
(engagement/repo/commit/scope/depth/ecosystems block of the contract), then `--write`.

Pass the two cross-run inputs resolved in Step 2 whenever they exist. With `--previous` every finding gets
`change: new | persisting` by **fingerprint** (a line-number-free identity, `REPORT_CONTRACT.md` →
`fingerprint`) and the report gains `run_diff`, whose `not_refound[]` is **a list to verify, never a list of
fixes** — a finding vanishes just as easily because recon missed its file this time. With `--accepted`,
findings whose fingerprint the operator's `.codeaudit-accepted.json` names become `status: accepted-risk`,
stay listed, and leave the tally. Never write that file yourself, and never carry an acceptance forward on
your own authority: the aggregator flags a finding that was accepted last run and is not covered now. The tool is lenient where auditors are legitimately verbose — a
`**Confidence**: probable (platform fact outside the repo)` keeps its leading token and stores the rest as
`confidence_note`; same for `privilege_required` — and strict where leniency would hide a defect: an
`unconfirmed` or missing confidence is a `coverage_gaps` entry, a missing `privilege_required` is `unknown`
with no cap and a logged violation, a disposition outside the enum is `model_gap` with a logged violation.
The rules it implements are the ones below — read them so you know what you are checking.

1. **Verification + de-duplication pass.** Read every `outputs/{engagement}/findings/finding-*/description.md`,
   then:
   - **De-duplicate** across auditors that touched overlapping code — key on `(vuln_class, sink file:line,
     source file:line, slot_type)` using the **parsed** `file:line` (not the free-text expr, so
     `req.query.sort` and `req.query['sort']` collapse to one). Same key = one finding; merge evidence.
     A **different `slot_type` at the same line** (e.g. SQL-value vs SQL-identifier) is a distinct finding —
     do not merge those.
   - **Relate what you did not merge.** Exact-key de-duplication only catches the easy case. After it, read
     the surviving findings against each other and classify every related pair into exactly one of three
     relations, recorded in a top-level **`finding_relations`** object. A pair that is none of these is
     unrelated — do not record it.
     - **`duplicates`** — same root cause, same vulnerable path, same impact, but the keys differed (two
       auditors described the same bug at different hops, or one filed the write half and the other the read
       half of one stored-taint path). Merge into a canonical id and list the rest. Sharing a CWE, a sink
       type, a file or a helper is **not** enough: different attacker-controlled inputs or different impacts
       mean two findings.
     - **`subsumed`** — different bugs, but the child is reachable **only** through the parent, so any
       correct fix for the parent closes it. *"Unauthenticated users reach the admin router" (parent) and
       "admin route X lacks input validation" (child)*: the child is real on its own terms, but gating the
       router closes its only untrusted path. **Not** applicable when the child has an independent path the
       parent's fix leaves open — that is two findings. Both stay open with their own severities; the
       relation is what tells the reader which to fix first.
     - **`chains`** — two or more findings that compose into a **higher-severity** attack than any of them
       alone. *A low-severity traversal that reads files under the app root, plus a medium-severity secret
       written to a predictable path under that root, is credential disclosure.* This is the relation most
       worth the effort: it is exactly what a per-class auditor cannot see, because each member lives in a
       different auditor's scope and each is correctly rated low on its own.
     Each entry carries a one-sentence `reason` naming the shared root cause (duplicates), the closing fix
     (subsumed), or the composed effect and the exploit order (chains).
     **Relations never change `summary` counts or member severities** — members keep their own ratings so the
     tally stays reproducible. A chain's composed severity is stated in its `reason` and in the report
     narrative, not applied to its members. Use `"finding_relations": {"duplicates":[],"subsumed":[],"chains":[]}`
     when there are none; an absent object reads as "not considered".
   - **Orchestrator adjustments — the two edits that *are* allowed, and only with evidence.** The same
     `plan/_relations.json` may carry an `orchestrator_adjustments` object (schema in `REPORT_CONTRACT.md`):
     - `severity_overrides[]` — when the **class owner** reassessed a finding another shard filed in its
       class (the auth shard files a resource-exhaustion item; the resource-exhaustion auditor is told to
       take ownership and writes an addendum in the finding's directory). The override names the finding,
       the new severity, who decided and the addendum path. Caps still apply after it; the report shows
       `severity_revision {from, to, by, reason, evidence}` so the reader sees both ratings.
     - `additional_locations[]` — when a follow-up found **more sites of the same root cause** for an
       existing finding (same fix, same impact) instead of filing a sibling. They land in the finding's
       `locations[]` and in SARIF `relatedLocations`.
     Nothing else is adjustable here: a severity you merely disagree with stays as filed, and a different
     root cause is a different finding.
   - **Confidence gate**: a finding may carry `confidence: high` only if it has a complete, re-readable
     source→sink trace (or, in hybrid mode, a live corroboration). Downgrade anything with an
     uninspected helper/branch to `probable`, and anything lacking a complete path to `unconfirmed`
     (list the latter under `coverage_gaps`).
   - **Split each auditor's `_safe-*.md` into the four evidence arrays**, on its four headings (format in
     `reference/OUTPUT_STRUCTURE.md`): `tested_not_vulnerable` · `design_properties` ·
     `unverified_assumptions` · `coverage_gaps`. Do **not** collapse them into one list — the whole point is
     that "we checked and it holds", "this is deliberate", "we could not tell from source" and "we did not
     get to it" are different claims. Parse each `tested_not_vulnerable` line's leading `[disposition]` into
     the entry's `disposition` field; a line with no bracket, or a disposition outside the closed enum, is a
     contract violation — keep the entry, set `disposition: "model_gap"`, and note the auditor in the audit
     log so the drift is visible rather than silently normalised.
     An auditor that wrote **no** `_safe-*.md` at all has not proven coverage: log it and record its scope
     under `coverage_gaps`, exactly as for an auditor that terminated without a parseable status (Step 6.5).
     The `[skipped]` lines (the skipped registers) come out as `coverage_gaps` entries with `kind: "skipped"`
     **and** as the top-level `skipped_paths[]`; `render.py` prints them as their own section. Anything still
     listed there after the Step 6.5 follow-ups is a path the audit did not analyse, and the executive summary
     must say so in one sentence — never let "all in-scope sources traced" stand over a non-empty register.
   - **Resolve ids & evidence**: keep each finding's on-disk class-prefixed dir name as its `id`
     (`finding-{prefix}-{NNN}`) — never renumber to a flat `finding-001`; set `evidence` to that dir's
     `description.md` and confirm the path resolves before writing the report (drop or flag any finding
     whose dir is missing). Keep `unconfirmed` items **out** of `findings[]` — they belong in
     `coverage_gaps` — so `summary.total` counts only `confidence ∈ {high, probable}`.
   - **Union sharded classes.** When **any** class ran as several shards (same agent, distinct `shard` tags
     — injection/xss/access-control/ssrf on a large codebase), gather every `_safe-{class}-{shard}.md`
     (unioning all four of its sections, not just the first) and
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
   critical/high/medium/low/info counts; confidence breakdown; top 3; coverage gaps; **skipped paths**, if
   any; the **verification line** — verified / confirmed / uncertain / refuted, and which refutations you
   spot-checked or overrode; and, when `--previous` ran, the `run_diff` line — `new / persisting / not
   re-found` — plus the `accepted_risk` count when `--accepted` ran). Confirm: "Write the final report now?"
3. On confirmation, produce the deliverables **exactly per** `$CA/skills/code-audit/reference/REPORT_CONTRACT.md`:
   - `outputs/{engagement}/codeaudit-report.json` — fixed schema (engagement/repo/commit/target_url
     metadata, findings[] with file:line/source/sink/slot/confidence/owasp/**`privilege_required`** **and
     `endpoint` when resolved in step 1b**, summary counts, and **all four evidence arrays —
     `tested_not_vulnerable` (each with a `disposition`), `design_properties`, `unverified_assumptions`,
     `coverage_gaps`** — plus the audit `depth`). Emit all four arrays even when empty: an absent array
     reads as "not considered", an empty one as "considered, nothing to report". `coverage_gaps` lists
     anything left unconfirmed (e.g. a class with no scanner installed) — there is no time-based de-scoping.
     **Apply the `privilege_required` severity caps** from `REPORT_CONTRACT.md` here, at aggregation, so two
     runs of the same audit produce the same severities. Restate the table in full — a partial restatement is
     how the most common value silently keeps an inflated rating:
     `none` → `critical` · **`authenticated` → `high`** · `admin` → `high` · `maintainer` → `medium` ·
     `local-root` → `medium`. Recompute `summary` **after** capping.
     A finding missing `privilege_required` **stays in `findings[]`** — never drop a confirmed finding over a
     missing metadata field. Derive it from the trace when the principal is unambiguous; otherwise set
     `privilege_required: "unknown"`, apply **no** cap (an unknown privilege must not silently lower
     severity), add a `coverage_gaps` entry naming the finding id and the unresolved principal, and log
     `"contract_violation":"privilege_required missing","finding":"<id>"`. Deleting it would remove a
     confirmed vulnerability from `summary`, from `report.md`, from SARIF/CSV and from the pentest
     handoff — a strictly worse outcome than an imperfectly-rated finding.
   - `outputs/{engagement}/report.md` — REQUIRED consolidated human report from the fixed template. Render it
     with the shipped tool rather than by hand — the evidence sections run to hundreds of lines and a
     hand-written report drops them:
     ```bash
     python3 -I "$CA/tools/render.py" "outputs/{engagement}"      # reads codeaudit-report.json + plan/_narrative.json
     ```
     You write the **judgement** half first, as `plan/_narrative.json` (contract in `OUTPUT_STRUCTURE.md`):
     the executive-summary paragraphs, the threat-model corrections established during the waves, the
     one-page summary and its boundaries, the remediation groups (one ticket per fix, `finding_ids[]`,
     priority, business impact, acceptance check), and the coverage / reconciliation / sweep statements.
     The tool renders everything mechanical (every finding with its trace, code and remediation from its
     `description.md`; the four evidence arrays grouped by class; relations; appendix) and leaves a visible
     `TODO-ORCHESTRATOR` marker wherever the narrative is missing — never a silent blank.
   - Keep per-finding markdown under `findings/finding-*/` as the depth layer.
4. **Operator-selected extra formats** (from `output_formats`) — `render.py` produces all four in the same
   run, from the same `codeaudit-report.json`, so they can never disagree with the report:
   - "Executive summary" → `exec-summary.md` (1-page, non-technical; from `exec_summary_page`,
     `exec_boundaries` and the top remediation groups).
   - "Remediation plan" → `remediation-plan.md` (ticket-style, grouped by fix; any finding not covered by a
     group is listed as its own ticket so nothing is silently unassigned).
   - "CSV findings table" → `findings.csv`.
   - "SARIF" → `codeaudit.sarif` (SARIF 2.1.0: one result per finding, `physicalLocation` = file + line,
     `relatedLocations` from `locations[]`, `level` from severity, `ruleId` = `{vuln_class}/{cwe}`). This
     enables CI / code-scanning ingestion.
   - "PDF render" → render `report.md` via pandoc if available:
     ```bash
     command -v pandoc >/dev/null 2>&1 && pandoc "outputs/{engagement}/report.md" -o "outputs/{engagement}/report.pdf"
     ```
     If pandoc is missing, skip and warn (`PDF requested but pandoc is not available — delivered report.md
     instead.`) — graceful degradation, never fail the run.
5. Log `phase":"report","action":"report-written","path":"outputs/{engagement}/codeaudit-report.json","formats":<output_formats>,"result":"complete"` and tell the operator where the deliverables are.

### Step 6.7 — Carry forward (what this run established, into the context file)

The run just settled things the next run should not re-derive: the design properties the auditors confirmed
as intended, the risks the operator accepted, the version-gated patterns ruled out at a named pin. Propose them
for `{repo}/.codeaudit-context.md` — and only propose:

```bash
python3 -I "$CA/tools/context.py" propose "outputs/{engagement}" --context "{repo}/.codeaudit-context.md"
```

It writes `plan/_context-additions.md` (one *Known non-findings* line per item the file does not already
carry) and prints them. If there are none, log `phase":"carry-forward","additions":0` and stop. Otherwise show
the lines to the operator via AskUserQuestion — "Add these {n} lines to `.codeaudit-context.md`?" with
**Apply all** / **Let me edit the list first** / **Skip** — and:
- **Apply all** → `python3 -I "$CA/tools/context.py" apply "outputs/{engagement}" --context "{repo}/.codeaudit-context.md"`.
- **Let me edit** → tell them to delete the lines they do not endorse from `plan/_context-additions.md`,
  wait for their go-ahead (plain prompt), then run `apply`.
- **Skip** → leave the additions file in place and move on.
Never run `apply` without that answer: the file is the operator's statement, and an agent-written line in it
without their approval is exactly the kind of inherited claim the *Known non-findings* rule exists to prevent.
Remind them to commit the file. Log `phase":"carry-forward","additions":<n>,"applied":<true|false>`.

Do not ask for additional confirmation before Step 6.1 — the audit summary is the launch confirmation.
The operator gates remain at Step 6.4 (plan approval), Step 6.6 (pre-report) and Step 6.7 (carry forward).
