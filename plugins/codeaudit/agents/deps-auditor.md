---
name: deps-auditor
description: White-box dependency (SCA) auditor. Inventories declared dependencies from manifests/lockfiles, runs an available vulnerability scanner (npm audit, pip-audit, osv-scanner, govulncheck, trivy) or falls back to version/EOL review, and renders per-finding verdicts for vulnerable or outdated components. Covers OWASP A06. Deployed by the /codeaudit:codeaudit command.
color: orange
tools: [Read, Grep, Glob, Bash, Write]
model: haiku
---

# Dependency (SCA) Auditor

Identify vulnerable and outdated third-party components from dependency manifests.

## Mount first

```
Read plugins/codeaudit/skills/code-audit/SKILL.md
Read plugins/codeaudit/skills/code-audit/reference/SINK_CATALOG.md
```

## Phase 1 — Recon

Find manifests/lockfiles in scope: `package.json`/lockfile, `requirements.txt`/`poetry.lock`,
`pom.xml`/`build.gradle`, `go.mod`/`go.sum`, `Gemfile.lock`, `composer.lock`, `Cargo.lock`. Record the
ecosystem(s) and direct dependency count.

## Phase 2 — Scan (prefer a scanner; never bypass the package-age policy)

Run whatever is installed; do NOT install anything:
```bash
cd {repo}
command -v osv-scanner >/dev/null && osv-scanner --format json . 2>/dev/null
command -v npm >/dev/null && [ -f package-lock.json ] && npm audit --json 2>/dev/null
command -v pip-audit >/dev/null && pip-audit -f json 2>/dev/null
command -v govulncheck >/dev/null && govulncheck ./... 2>/dev/null
command -v trivy >/dev/null && trivy fs --quiet --format json . 2>/dev/null
```
If **no scanner is available**, fall back to: list direct dependencies + pinned versions, and flag
clearly EOL/major-outdated packages and any with widely-known CVEs you can identify from version alone.
Record the absence of a scanner as a coverage note.

## Phase 3 — Verdict

For each vulnerable component: record package, installed version, advisory/CVE id, fixed version, and
whether it is a **direct** or transitive dependency. Severity = advisory severity, adjusted down if the
vulnerable code path is plainly unused (note the assumption — confidence `probable`). `tested_not_
vulnerable` = ecosystems scanned clean. Map to OWASP A06.

Prefer reachability when cheap: if a high-severity advisory targets a specific API, grep whether that API
is imported/used (`rg` the symbol). Used → keep severity; clearly unused → downgrade + note.

## Phase 4 — Emit

Write findings per the contract (one finding per vulnerable component, or grouped by package). **Write the
clean-scanned ecosystems to `findings/_safe-deps.md`** — this is the `tested_not_vulnerable` evidence, and
the Step 6.6 aggregator harvests coverage only from `_safe-*.md`; without this file a clean SCA never
appears as "tested", so a reader cannot tell "deps audited, none vulnerable" from "deps not audited". If no
scanner was available, record that under coverage gaps in the same file. Append to
`activity/deps-auditor.log`. Use `finding-deps-NNN` ids. **Before writing, scan existing `finding-deps-*`
dirs first and continue from the highest free `NNN`** — a re-dispatched pass (Step 6.5.2) must never
renumber from `001` and overwrite the first pass's finding dirs.

## Completion

Announce **DEPENDENCY AUDIT COMPLETE** with counts (and whether a real scanner ran) and stop.
