# Code-Audit Report Deliverable Contract

The deliverable shape is **fixed**, not improvised per run. Every audit launched via
`/codeaudit:codeaudit` ends by producing exactly the artifacts below, so two independent runs yield
structurally identical deliverable sets.

> **Who produces these.** Step 6.6 of `commands/codeaudit.md` (the main session, which owns
> orchestration) writes the aggregated reports after the operator confirms the findings summary. The
> per-finding markdown is written earlier by each auditor agent.

Findings reference **code locations (`file:line`)**, not live endpoints. A proof-of-concept payload is
**optional context**, never required — the source→sink trace is the evidence.

## Required artifacts (always produced)

| Artifact | Path | Purpose |
|----------|------|---------|
| Machine-readable report | `outputs/{engagement}/codeaudit-report.json` | Fixed schema — tooling/tracking ingest |
| Consolidated human report | `outputs/{engagement}/report.md` | Single readable deliverable, fixed template |
| Per-finding detail | `outputs/{engagement}/findings/finding-{NNN}/` | Depth layer: trace, snippet, remediation |

A run is **incomplete** if `report.md` does not exist.

## `codeaudit-report.json` — fixed schema

```json
{
  "engagement": "acme-api-2026-06",
  "repo": "/home/user/src/acme-api",
  "commit": "8b956c9",
  "target_url": null,
  "date": "2026-06-18",
  "metadata": {
    "scope": { "code_paths": "all", "out_of_scope": "tests/, migrations/", "focus": "src/api" },
    "mode": "static | hybrid",
    "depth": "Thorough",
    "classes_audited": ["injection","xss","auth","access-control","ssrf","secrets","crypto","deps","config"],
    "languages": ["typescript","sql"],
    "files_in_scope": 412,
    "live_correlation": false
  },
  "findings": [
    {
      "id": "finding-inj-001",
      "title": "SQL injection via unvalidated ORDER BY in user listing",
      "severity": "high",
      "confidence": "high",
      "status": "open",
      "vuln_class": "injection",
      "owasp": "A03:2021 Injection",
      "cwe": "CWE-89",
      "cvss": 8.6,
      "location": { "file": "src/db/userRepo.ts", "line": 130 },
      "source": "req.query.sort (src/api/userController.ts:42)",
      "sink": "template-literal SQL in listUsers (src/db/userRepo.ts:130)",
      "trace": ["userController.ts:42", "listService.ts:88", "userRepo.ts:130"],
      "slot_type": "SQL-keyword",
      "externally_reachable": true,
      "endpoint": { "method": "GET", "path": "/api/users", "param": "sort", "in": "query" },
      "evidence": "findings/finding-inj-001/description.md",
      "witness_payload": "?sort=id--"
    }
  ],
  "summary": { "critical": 1, "high": 4, "medium": 6, "low": 3, "informational": 2, "total": 16 },
  "tested_not_vulnerable": [
    { "vuln_class": "ssrf", "detail": "all outbound fetches use a static host allowlist (src/http/client.ts:20)" }
  ],
  "coverage_gaps": [
    { "item": "deserialization in worker queue", "reason": "queue payload schema not fully traced (dynamic dispatch)", "recommended_action": "trace src/workers/*.ts consumers" },
    { "item": "full SCA of transitive dependencies", "reason": "no scanner installed; only direct deps reviewed", "recommended_action": "run osv-scanner / composer audit in CI" }
  ]
}
```

### Field rules

- **`findings[]`** — required keys: `id`, `title`, `severity`, `confidence`, `status`, `vuln_class`,
  `owasp`, `location` (file + line), `source`, `sink`. Optional: `cwe`, `cvss`, `trace`, `slot_type`,
  `externally_reachable`, `endpoint`, `witness_payload`, `write_site`, `evidence`.
- **`id` / `evidence`** — auditors write per-class on-disk dirs `findings/finding-{prefix}-{NNN}/`
  (`inj`/`xss`/`ac`/`ssrf`/`auth`/`sec`/`crypto`/`deps`/`cfg`/`log`) to stay collision-free across parallel
  runs. **Keep that class-prefixed id as the finding `id`** — do NOT renumber to a flat `finding-001` —
  and set `evidence` to the matching path `findings/finding-{prefix}-{NNN}/description.md`. The Step 6.6
  aggregator MUST confirm each `evidence` path resolves on disk before writing the report; a dangling
  `evidence` link breaks per-finding drill-down and SARIF/CSV ingestion.
- **`source`** — the tainted input as `expr (file:line)` and the `file:line` is **required** (it is the
  entry-point-resolution key for `endpoint`, and is the *source* read site, distinct from the top-level
  `location` which is the *sink*). E.g. `"req.query.sort (src/api/userController.ts:42)"`.
- **`write_site`** (optional; stored / second-order findings only) — for a stored XSS / stored SQLi /
  second-order injection, the **write half** as `expr (file:line)` where the attacker value was persisted.
  The read/render sink stays in `location`/`sink`; the read-back of the stored value is the `source`.
  Seed it from `recon/sink-inventory.json` `stored_sources`. A stored finding reaches `high` only when it
  carries **both** a `write_site` and a complete stored-value→sink trace (both halves exhibited).
- **`endpoint`** (optional, request-reachable findings only) — the live HTTP binding
  `{ method, path, param, in }`, resolved by the **Step 6.6 aggregator** from `recon/sink-inventory.json`
  `entry_points`: match the finding's `source` (the param **name** + `file:line`) to an entry point's
  `sources[] {name, at}`, then take `method`/`path`/`in` from that entry point and `param` = the source name.
  `in` is the fixed enum **`query | path | header | cookie | json | form`** (same vocab code-recon writes and
  the pentest normalizer produces — never `body`). Set it whenever the route is statically resolvable;
  **omit it** when routing is dynamic (programmatic mounting, gateway rewrites) or no entry point matches —
  never guess a path. This is what the pentest hybrid handoff consumes to route a code-confirmed finding
  straight to a live target (`HYBRID_HANDOFF_SPEC.md`); when absent, the handoff falls back to correlating
  the param against the black-box surface map.
- **`confidence`** — `high` (complete, unambiguous code trace) or `probable` (likely flaw, a branch/helper
  not fully inspected) for every entry in `findings[]`. `unconfirmed` (suspected, no complete path) is
  **not a finding**: record it under `coverage_gaps` only, never in `findings[]` — this keeps the headline
  count deterministic across runs. In hybrid mode a live corroboration may raise `probable`→`high`.
- **`status`** — `open` | `remediated` | `accepted-risk` (default `open`).
- **`depth`** — `Quick` | `Standard` | `Thorough` (default). Records how far indirect/second-order flows
  were chased. It does NOT cap which sources were covered: a complete audit traces every in-scope source
  regardless of depth — depth only governs how deep each path is followed.
- **`coverage_gaps`** — unconfirmed flaws and any class/area not fully traced (e.g. dynamic dispatch that
  could not be resolved statically, or a class with no scanner installed). First-class section. There is
  no time-based de-scoping — a code audit runs to completion.
- **`tested_not_vulnerable`** — vectors analyzed and confirmed safe, so coverage is provable.
- **`summary`** — severity counts computed over `findings[]` only. Because `findings[]` carries only
  `high`/`probable` confidence (`unconfirmed` lives in `coverage_gaps`) and the headline vulnerability
  tally excludes `informational` (see Exploitability bar), `summary.total` counts exactly the confirmed
  findings (`confidence ∈ {high, probable}`, severity ≥ `low`) — the same input twice yields the same total.

## Severity rubric (impact × reachability × confidence)

- **critical** — RCE / auth bypass / mass data exposure on a network-reachable path, high confidence.
- **high** — serious impact (SQLi, SSRF to internal, stored XSS, IDOR on sensitive data),
  network-reachable.
- **medium** — real but constrained (reflected XSS needing interaction, authz gap on low-value object,
  weak crypto not directly exploitable).
- **low** — limited impact / hard to reach / defense-in-depth gap.
- **informational** — hygiene (missing header, untracked secret, outdated-but-unexploited dep).

Internal-only reachability drops severity by one band. (`unconfirmed` items are not findings — they live
in `coverage_gaps` and carry no severity; see the `confidence` rule. A `probable` finding whose flaw
hinges on an uninspected branch should not be rated above `high`.)

**Exploitability bar.** A finding rated `low` or higher MUST carry a source→sink path or a concrete
exploitation primitive. A bare missing-control observation (absent header, cookie flag, debug mode,
verbose error) with no proven path is `informational` (hardening): it is still reported, but the
executive-summary **vulnerability count excludes `informational`** so hygiene never inflates the tally.
Prefer a small high-true-positive set over a long noisy one.

## OWASP Top-10 (2021) mapping reference

A01 Broken Access Control · A02 Cryptographic Failures · A03 Injection · A04 Insecure Design ·
A05 Security Misconfiguration · A06 Vulnerable & Outdated Components · A07 Auth Failures ·
A08 Software & Data Integrity (incl. insecure deserialization) · A09 Logging Failures ·
A10 SSRF.

## Default CWE by class (fill `cwe` deterministically)

`cwe` feeds the SARIF `ruleId` (`{vuln_class}/{cwe}`), so fill it on every finding. Use the default below,
refined to the specific sub-class where one applies:

| class | default `cwe` (refine per finding) |
|-------|------------------------------------|
| injection | CWE-89 SQLi · CWE-943 NoSQLi · CWE-78 OS-cmd · CWE-22/98 path/LFI · CWE-1336 SSTI · CWE-611 XXE · CWE-502 deser · CWE-1321 proto-pollution |
| xss | CWE-79 |
| auth | CWE-287 · CWE-384 session · CWE-916 weak hash · CWE-345 JWT |
| access-control | CWE-284 · CWE-639 IDOR · CWE-862 missing authz · CWE-269 privesc · CWE-915 mass-assign · CWE-352 CSRF |
| ssrf | CWE-918 · CWE-601 open-redirect |
| secrets | CWE-798 |
| crypto | CWE-327 · CWE-330 weak RNG · CWE-916 password hash |
| deps | CWE-1104 / CWE-937 |
| config | CWE-16 · CWE-614/1004 cookie flags · CWE-942 CORS |
| logging | CWE-532 · CWE-778 missing audit log · CWE-117 log injection · CWE-200 exposure |

## `report.md` — fixed consolidated template

```markdown
# Code Security Audit — {engagement}

**Repository:** {repo} @ {commit}
**Date:** {date}   **Auditor:** {operator}
**Mode:** {static|hybrid}{ + Target: {target_url} if hybrid}
**Scope:** {code_paths}  |  **Out of scope:** {out_of_scope}
**Classes audited:** {classes}
**Depth:** {depth}  ·  **Coverage:** all in-scope sources traced

## Executive Summary
{2-4 sentences: overall posture, count by severity, the single most important risk.}

## Findings by Severity
{For each finding, in severity order:}
### [{SEVERITY}] {title}  ({vuln_class}, {owasp}{, cwe})
- **Confidence:** {confidence}   **Reachable:** {externally_reachable}
- **Location:** `{file}:{line}`
- **Source → Sink:** `{source}` → `{sink}`  (slot: {slot_type})
- **Trace:** {trace hops}
- **Why vulnerable:** {1-2 lines: missing/mismatched defense}
- **Code:** {short fenced snippet at the sink}
- **Remediation:** {specific fix}
{ - **Witness payload:** {payload}  (optional)}
{ - **Live corroboration:** {result}  (hybrid only)}

## Vectors Tested — Not Vulnerable
{bullet list from tested_not_vulnerable}

## Coverage Gaps & Recommendations
{bullet list from coverage_gaps}

## Appendix — Methodology & Scope
{classes, languages, files-in-scope, depth, tools used}
```
