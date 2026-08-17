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
        │   the ONLY baseline pass: maps stack, sources, sinks, security mechanisms
        ▼
2. audit-planner (Task)      → plan/deployment-plan.json, plan/audit-plan.md
        │   reads baseline, decides which auditors against which dirs  → OPERATOR APPROVES
        ▼
3. auditors (parallel Task)  → findings/finding-*/  (+ _safe-*.md negatives)
        │   injection · xss · auth · access-control · ssrf · secrets · crypto · deps · config
        │   each: Recon → Trace (source→sink) → Verdict (slot↔defense) → Emit
        ▼
4. completeness loop         → re-dispatch/escalation until every source→sink path is analyzed
        ▼
5. aggregate + report        → de-dup, confidence gate  → OPERATOR CONFIRMS
                             → codeaudit-report.json + report.md (+ optional formats)
```

### Why the command orchestrates (not an agent)

This harness allows **one level of subagent nesting**. The command runs in the main session and can
spawn agents via `Task`; any agent it spawns cannot spawn further agents. So `code-recon`, the planner,
and the auditors are all spawned by the command. The planner only *plans* — it never deploys. This is
the same constraint that shapes the `pentest` plugin.

### Difference from Shannon's pre-recon

Shannon's `pre-recon` agent delegates code reading to its own sub-Task agents. Here, under the nesting
constraint, `code-recon` reads the code **directly** (Grep/Glob/Read) — it is itself a subagent and
cannot fan out. The orchestration fan-out happens one level up, in the command, across the auditors.

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
