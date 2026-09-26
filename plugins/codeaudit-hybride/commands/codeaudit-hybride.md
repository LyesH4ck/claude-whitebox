---
name: codeaudit-hybride
description: Launch a dual-engine white-box audit — the unchanged codeaudit pipeline (Claude) plus Codex as a blind second detector, cross-verifier and false-negative hunter. Collects scope (incl. explicit Codex authorization), runs recon/plan/auditors with Codex twins, reconciles deterministically, cross-verifies, calibrates confidence by agreement, and reports in codeaudit's contract with additive hybrid fields.
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
|   C O D E A U D I T  ·  H Y B R I D E              |
|                                                    |
|        Claude  ⇄  Codex   white-box audit          |
|                                                    |
======================================================
root@claude:~# [INITIALIZING DUAL-ENGINE CODE AUDIT...]
root@claude:~# [READY]
```

## Step 0 — Resolve the two plugins

`codeaudit-hybride` **reuses** the `codeaudit` plugin (agents, methodology, report contract) — it never
modifies it. Resolve both roots (repo checkout first, else the newest installed cache):

```bash
CA="plugins/codeaudit"; [ -f "$CA/skills/code-audit/SKILL.md" ] || CA=$(ls -d ~/.claude/plugins/cache/*/codeaudit/*/ 2>/dev/null | sort -V | tail -1)
HB="${CLAUDE_PLUGIN_ROOT:-}"; [ -f "$HB/scripts/codex-bridge.mjs" ] || HB="plugins/codeaudit-hybride"
[ -f "$HB/scripts/codex-bridge.mjs" ] || HB=$(ls -d ~/.claude/plugins/cache/*/codeaudit-hybride/*/ 2>/dev/null | sort -V | tail -1)
echo "CA=${CA%/}"; echo "HB=${HB%/}"
```

If either is missing, stop with an actionable message (install `codeaudit` from the `claude-whitebox`
marketplace). Then **Read**:
- `{CA}/commands/codeaudit.md` — the base procedure. Below, "codeaudit Step X" means that file's step,
  applied **exactly**, with the deltas stated here. Agent names there are unprefixed; here dispatch them
  as `codeaudit:<agent>` (e.g. `codeaudit:injection-auditor`).
- `{HB}/skills/hybrid-audit/SKILL.md` — the hybrid rules (roles, blindness, calibration, contract).

Let `BRIDGE={HB}/scripts/codex-bridge.mjs` and `RECON={HB}/scripts/reconcile.mjs`.

## Step 1 — Isolation

Ask via AskUserQuestion: "Isolate this session to codeaudit + codeaudit-hybride? (Recommended)" —
options "Yes — isolate me (recommended)" / "No — keep all plugins active". On Yes, output verbatim:

```
============================================================
[CODE AUDIT HYBRIDE — ISOLATION ACTIVE]

For this session, you MUST operate under these constraints:
- Only invoke agents from the codeaudit and codeaudit-hybride plugins
- Reach Codex ONLY through codeaudit-hybride's codex-bridge.mjs
  (never the codex:* agents, never /codex:* commands, never --write)
- You MAY read the pentest plugin's attack reference files; invoke no pentest agents
- Ignore agents and skills from all other plugins
- Active until /codeaudit-hybride:codeaudit-hybride-exit or /clear
============================================================
```

## Step 2 — Scope

Scope file: `.codeaudit-hybride-scope.json` (this plugin never writes codeaudit's `.codeaudit-scope.json`).

- If it exists and is valid JSON → show it (codeaudit Step 2 display + a `Codex:` line with
  `codex.allowed/transport/model/effort/classes`) and ask "Use pre-defined scope (Recommended)" / "Enter
  new scope".
- Else, if `.codeaudit-scope.json` exists → ask "Import the codeaudit scope as a starting point?
  (Recommended)" / "Enter new scope". Import = read-only copy of its fields.
- Else collect the base fields exactly as codeaudit Step 2 (repo, engagement, focus, out_of_scope,
  target_url; depth only on request; deliverable formats multi-select).

Then the **Codex fields** (always asked when not pre-defined):

1. **Authorization** (AskUserQuestion) — "Codex will receive the audited source code (sent to OpenAI in
   addition to Anthropic). With the companion transport, Codex threads are also persisted in `~/.codex`
   until deleted at exit. Is sending this code to OpenAI authorized for this engagement?"
   - "Yes — authorized for this engagement"
   - "No — stop (use /codeaudit:codeaudit for a Claude-only audit)"
   On No: set nothing, tell the operator to run `/codeaudit:codeaudit`, and **stop**.
2. **Codex classes** (AskUserQuestion) —
   - "Grep-sink classes: injection, xss, access-control, ssrf (Recommended)"
   - "Every selected class"
   - "Custom list" → follow up with a plain free-text prompt for comma-separated class keys.
3. **Effort** (AskUserQuestion) — "high (Recommended)" / "xhigh — slower, deepest" / "medium — faster".

Model and transport are settled in Step 4 (they need the preflight). Write the scope file:

```json
{
  "repo": "...", "engagement": "...", "focus": "...", "out_of_scope": "...", "target_url": null,
  "depth": "Thorough", "output_formats": [], "extra_roots": [],
  "codex": { "allowed": true, "classes": ["injection","xss","access-control","ssrf"], "effort": "high",
             "model": null, "transport": null, "max_parallel": 4, "timeout_min": 90 },
  "status": "active"
}
```
Verify the repo exactly as codeaudit Step 2 does.

## Step 3 — Class profile

Exactly codeaudit Step 3 (read `.codeaudit-classes.json` **read-only** if present, else ask with the same
options and keys). Then intersect: `codex.classes := codex.classes ∩ classes` ("Every selected class" =
`classes`). An empty intersection is allowed (Codex then only runs safe-review/verify on nothing — tell
the operator the run is effectively Claude-only and ask whether to continue).

## Step 4 — Tooling check + Codex preflight

Run codeaudit Step 4 (optional scanners). Then:

```bash
node "$BRIDGE" preflight --out "outputs/{engagement}" --repo "{repo}"
```

- `codeaudit_root` null → stop (dependency missing).
- `transports_available` empty → show `notes` and ask: "Retry after fixing" / "Abort". Never continue
  silently without Codex.
- `companion_setup.reviewGateEnabled: true` → warn: the codex stop-review-gate would review every Claude
  stop; recommend `/codex:setup --disable-review-gate` before continuing.
- Transport: `companion` if available (background jobs, status/cancel, maintained by OpenAI). If only
  `exec` is available, ask "Use the codex exec fallback (Recommended)" / "Abort".
- Model: ask "Pin `{config_model}` (Recommended)" / "Other model" (free-text follow-up). Store the
  literal model id — the run must be reproducible even if `~/.codex/config.toml` changes.

Update `codex.model` / `codex.transport` in the scope file.

## Step 5 — Summary

Output codeaudit Step 5's summary plus:

```
Codex:        {transport} · {model} · effort {effort} · max {max_parallel} parallel jobs
Dual classes: {codex.classes}   (Claude-only: {classes − codex.classes})
Roles:        blind twin detection → deterministic reconciliation → cross-verification → safe-review
```

## Step 6 — Execution

Maintain `outputs/{engagement}/activity/hybride-orchestrator.log` (NDJSON, same conventions as codeaudit).

### 6.1 Initialize
codeaudit Step 6.1, plus `mkdir -p outputs/{engagement}/hybrid`.

### 6.2 Recon
codeaudit Step 6.2 with `codeaudit:code-recon`.

### 6.3 Planning
codeaudit Step 6.3 with `codeaudit:audit-planner`, then codeaudit Step 6.4.1 (plan validation).

### 6.4 Hybrid overlay, approval, dispatch

1. Write `plan/hybrid-plan.json`: for every deployment in `deployment-plan.json` `waves[]` whose class is
   in `codex.classes`, add a **Codex twin** in the same wave:
   `{ "agent": "codeaudit-hybride:codex-auditor", "mode": "detect", "class": "<class>",
   "tag": "cx-<class>[-<shard>]", "scope": "<same scope>", "twin_of": "<claude agent[/shard]>" }`.
   Same scope and shard as the Claude auditor — **never** split a scope between the engines.
2. Present `plan/audit-plan.md` + a short twin table via AskUserQuestion (Approve / Modify / Cancel),
   exactly like codeaudit Step 6.4.2.
3. Dispatch wave 1 in **one message**, all `run_in_background=True`:
   - every Claude auditor as `codeaudit:<agent>` with codeaudit Step 6.4.3's prompt (scope,
     completeness mandate, REPORT_CONTRACT reminder). Say **nothing** about Codex to Claude auditors.
   - up to `codex.max_parallel` Codex twins as `codeaudit-hybride:codex-auditor`, prompt:
     "out=outputs/{engagement} repo={repo} mode=detect class=<class> tag=<tag> scope=<scope>
     out_of_scope={out_of_scope} depth={depth} transport={transport} model={model} effort={effort}
     timeout_min={timeout_min}. Follow your agent definition exactly."
   Twins beyond the cap are **queued** and dispatched as earlier twins terminate — never dropped.

### 6.5 Completeness loop

- **Claude auditors**: codeaudit Step 6.5, unchanged — including the mechanical source reconciliation.
  Codex results never count toward Claude's source coverage proof.
- **Codex twins**: parse the `STATUS:` line.
  - `complete` → done.
  - `incomplete` → re-dispatch once, tag `<tag>-r1`, `scope` = the `REMAINING` items. Still incomplete →
    record remaining items as `second-engine gap`.
  - `errored` / no parseable status → re-dispatch once on the full scope with the new tag `<tag>-r1`; still
    errored → `second-engine gap: codex detect for <class> did not complete` (not a class gap).
- Dispatch each next wave's Claude auditors **and** their twins together.
- Check the bridge ledger at the end: `node "$BRIDGE" status --out "outputs/{engagement}"` — no job may
  remain `queued`/`running`.

### 6.6 Reconcile + cross-verify

1. **Claude-side dedup first**: apply codeaudit Step 6.6.1's de-duplication + confidence gate to
   `findings/` only.
2. **Extract** `outputs/{engagement}/hybrid/claude-index.json` — one entry per surviving Claude finding
   (`confidence ∈ {high, probable}`), read from its `description.md`:
   `{ "id", "vuln_class", "title", "severity", "confidence", "sink_file", "sink_line", "sink_expr",
   "slot_type", "source_expr", "source_file", "source_line", "trace": ["file:line", …],
   "why_vulnerable", "evidence" }` (`id` = the on-disk dir name; `vuln_class` = codeaudit class key).
   Extraction only — no judgment here.
3. **Match** (deterministic):
   ```bash
   node "$RECON" match --out "outputs/{engagement}" --claude-index "outputs/{engagement}/hybrid/claude-index.json" \
     --dual-classes "<codex classes whose detect twin was collected>" --repo "{repo}"
   ```
4. **Cross-verify + safe-review — one parallel message**, all in background:
   - each `hybrid/verify-input/for-codex-<class>.json` → `codeaudit-hybride:codex-auditor`,
     `mode=verify class=<class> tag=cxv-<class> input=<file>`;
   - each `hybrid/verify-input/for-claude-<class>.json` → `codeaudit-hybride:finding-verifier`,
     `repo={repo} input=<file> output=outputs/{engagement}/hybrid/verify/claude-<class>.json`;
   - each dual class: `node "$RECON" safe-input --out … --class <class>`; if not `empty` →
     `codex-auditor`, `mode=safe-review class=<class> tag=cxs-<class> input=<input_file>`.
   Same error handling as 6.5 (one retry, then `second-engine gap`).
5. **Overturns**: for each collected `cxs-<class>`:
   `node "$RECON" overturn-input --out … --class <class>`; if `overturns > 0` → `finding-verifier` with
   `output=outputs/{engagement}/hybrid/verify/claude-overturn-<class>.json` (parallel, one message).
6. **Calibrate**:
   ```bash
   node "$RECON" finalize --out "outputs/{engagement}" --claude-index "outputs/{engagement}/hybrid/claude-index.json"
   ```
7. **Adjudicate** every `adjudicate` row per the hybrid skill: open the cited `file:line`, apply
   codeaudit's guard rules, then either move the finding to `tested_not_vulnerable`
   (`"refuted by <engine> at <file:line>, adjudicated"`) or keep it `disputed` / `probable` with both
   arguments quoted. Record each decision in `hybrid/adjudication.json`. Never drop silently.

Log `phase":"hybrid","action":"calibrated","stats":<calibration stats>`.

### 6.7 Aggregate + report

codeaudit Step 6.6 (from point 1b on: endpoint resolution, operator confirmation, deliverables, extra
formats) over the **calibrated union**:
- `both` rows → the Claude finding (canonical id) + `merged_ids`; Codex evidence path listed too.
- kept Codex findings (`findings-codex/finding-cx…`) → included with their own ids and evidence paths;
  resolve their `endpoint` from `source_file:source_line` like Claude's.
- `overturn-unverified` + second-engine gaps → `coverage_gaps`; `overturn-rejected` →
  `hybrid.disputed_safe`.
- Add the **additive fields** and the `hybrid` block from the hybrid skill; add the **Hybrid analysis**
  section to `report.md`. In the pre-report summary, include the agreement breakdown
  (both / cross-verified / single / disputed / Codex-unique kept / safe overturned).
- SARIF (if selected): add `properties.detected_by` and `properties.agreement` per result.

The operator gates are the same as codeaudit: plan approval (6.4) and pre-report confirmation (6.7).
