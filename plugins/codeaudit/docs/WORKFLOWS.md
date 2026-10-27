# Code Audit Workflows

How the `codeaudit` plugin runs a white-box source code security audit. It mirrors the `pentest`
plugin's orchestration model (the command in the main session owns dispatch; agents are single-purpose;
nesting is one level deep) but the target is **source code**, not a live host.

## Quick start

```
/codeaudit:codeaudit
```

The command walks you through: isolation → scope (repo path, optional live URL, optional depth) → class
profile → tooling check → summary → execution. Two operator gates: plan approval and pre-report
confirmation. There is **no time budget** — a code audit is bounded and runs until every source→sink
path in scope is analyzed, then stops.

Optional pre-configuration:

```
/codeaudit:codeaudit-scope     # save repo/scope to .codeaudit-scope.json without launching
/codeaudit:codeaudit-classes   # save the vuln-class profile to .codeaudit-classes.json
/codeaudit:codeaudit           # launch (reuses saved scope/classes if present)
/codeaudit:codeaudit-exit      # close session, flush findings, lift isolation
```

## The pipeline

```
[main session: /codeaudit:codeaudit command]  ← owns ALL dispatch
        │
        ▼
1. code-recon  (Task)        → recon/architecture.md, attack-surface.md, sink-inventory.json
        │   the ONLY baseline pass: maps stack, sources, sinks, mechanisms, ecosystems + version pins
        │   WHAT EXISTS
        │   → tools/recon-coverage.py gates it: every route-shaped source file vs the handler
        │     inventory; a missed family sends recon back on the residue before anything inherits it
        ▼
2. threat-modeler (Task)     → recon/threat-model.json
        │   entry-point trust table, adversaries, properties provided/disclaimed,
        │   controls + their assumptions, known non-findings, dispositions
        │   WHAT IS SUPPOSED TO BE TRUE — every rule-out downstream cites it
        ▼
3. audit-planner (Task)      → plan/deployment-plan.json, plan/audit-plan.md
        │   reads baseline + model, decides which auditors against which dirs → OPERATOR APPROVES
        ▼
4. auditors (parallel Task)  → findings/finding-*/  (+ _safe-*.md: the four evidence categories)
        │   17 classes · each: Recon → Trace (source→sink) → Verdict (slot↔defense) → Emit
        ▼
5. completeness loop         → re-dispatch/escalation until every source→sink path is analyzed
        ▼
6. adversarial sweep (×2)    → findings/finding-sweep-*/
        │   blind-dig: a directory the plan never covered, run WITHOUT model/recon/findings
        │              (context isolation is the method — it prevents anchoring)
        │   challenge-exclusion: take one exclusion the AUDIT made and try to refute it
        ▼
6b. finding-verifier (parallel Task, batches of ≤6)  → findings/finding-*/verification.md
        │   every high/critical finding (or all, on a small set) gets a SECOND agent that tries to
        │   refute it from source — rebuilt trace, guard hunt, git history — and writes a cited
        │   verdict: confirmed / refuted (needs disposition + file:line) / uncertain
        ▼
7. aggregate + report        → de-dup → verification (refuted → tested_not_vulnerable) → relations
                             → privilege_required severity caps → OPERATOR CONFIRMS
                             → codeaudit-report.json + report.md (+ optional formats)
```

### Why the command orchestrates (not an agent)

This harness allows **one level of subagent nesting**. The command runs in the main session and can
spawn agents via `Task`; any agent it spawns cannot spawn further agents. So `code-recon`, the
`threat-modeler`, the planner, the auditors and the `adversarial-sweep` agents are **all** spawned by the
command. The planner only *plans* — it never deploys. This is the same constraint that shapes the `pentest`
plugin.

It is also why the `blind-dig` sweep's context isolation is the **command's** responsibility rather than the
agent's: the agent is told not to go looking for the threat model, recon or findings, but only the caller
controls what actually reaches its prompt. An orchestrator that helpfully summarises "recon found X here"
into that prompt has defeated the sweep without breaking anything visible.

### Difference from Shannon's pre-recon

Shannon's `pre-recon` agent delegates code reading to its own sub-Task agents. Here, under the nesting
constraint, `code-recon` reads the code **directly** (Grep/Glob/Read) — it is itself a subagent and
cannot fan out. The orchestration fan-out happens one level up, in the command, across the auditors.

## Diff mode (a change, not a repository)

```
/codeaudit:codeaudit-diff
```

Scope is the files a diff touched (`--ref origin/main`, `--working`, `--staged` or an explicit list) plus one
import hop each way (`tools/diff-scope.py`): importers are where a changed helper becomes reachable, imports
are what a changed handler now reaches. The standing baseline is reused by path — the repo's
`.codeaudit-context.md`, the most recent full engagement's recon and threat model, its report as
`--previous`, the accepted-risk file. The planner scopes auditors to the slice, every finding is verified,
and `render.py --pr-comment` writes the **net-new** findings by fingerprint — nothing on a green run. It
does not replace the full engagement, which is what builds the baseline a change is judged against.

## Resuming an interrupted engagement

Everything a run produces is on disk. `tools/resume.py outputs/<engagement>` classifies each phase from
artifacts alone (never from an agent's "complete") and names the first step to resume from and the auditors
still owed; `/codeaudit:codeaudit` Step 6.0b offers **Resume** / **Start over** / **Cancel** before
initializing anything.

## Static vs hybrid mode

- **Static** (no `target_url`): the audit reasons entirely from source. Findings cite `file:line` and a
  source→sink trace; no app needs to run, no network access happens.
- **Hybrid** (`target_url` set): identical analysis, plus auditors may send a *single benign witness*
  request to corroborate a `probable` finding (e.g. a quote for SQLi, `{{7*7}}` for SSTI). Corroboration
  raises confidence `probable → high`; its absence never lowers a code-derived verdict.

## What makes a finding (verdict discipline)

A finding is a proven **source → [transforms/sanitizers] → sink** path where the defense is missing,
wrong for the sink's slot, or nullified by post-sanitization concatenation. See
`skills/code-audit/reference/SOURCE_TO_SINK.md`. Findings carry a confidence (`high`/`probable`/
`unconfirmed`) and a reachability flag. Safe vectors are recorded too, so coverage is provable.

## Deliverables

Always: `outputs/{engagement}/codeaudit-report.json` (fixed schema) + `outputs/{engagement}/report.md`
(fixed template). Optional: exec summary, remediation plan, CSV, **SARIF** (for CI/code-scanning), PDF.
Per-finding depth lives in `outputs/{engagement}/findings/finding-*/`. The full contract is in
`skills/code-audit/reference/REPORT_CONTRACT.md`; the working layout in
`skills/code-audit/reference/OUTPUT_STRUCTURE.md`.

## Classes covered

| Class | Agent | OWASP |
|-------|-------|-------|
| Injection (SQLi/NoSQLi/CMDi/LFI/RFI/SSTI/XXE/path/deser) | `injection-auditor` | A03 |
| XSS (reflected/stored/DOM) | `xss-auditor` | A03 |
| Authentication & sessions | `auth-auditor` | A07 |
| Access control (authz/IDOR/mass-assignment) | `access-control-auditor` | A01 |
| SSRF | `ssrf-auditor` | A10 |
| Secrets / hardcoded credentials | `secrets-auditor` | A05/A07 |
| Cryptography | `crypto-auditor` | A02 |
| Vulnerable dependencies (SCA) | `deps-auditor` | A06 |
| Security configuration | `config-auditor` | A05 |

## Optional external tools

Auditors prefer these if installed but never install them (and degrade gracefully): `gitleaks` /
`trufflehog` (secrets), `osv-scanner` / `npm audit` / `pip-audit` / `govulncheck` / `trivy` (SCA),
`pandoc` (PDF/DOCX render). Missing tools become logged coverage notes, not failures. (Taint analysis is
done by the auditors themselves + their rules — not an external scanner; an in-repo trial showed the LLM
auditors caught sinks even semgrep missed.)

## Knowledge reuse

Auditors reuse the `pentest` plugin's attack catalog (`plugins/pentest/skills/pentest/attacks/**`) for
payload shapes, sink lists, and bypass context — but the verdict is always derived from the code.
