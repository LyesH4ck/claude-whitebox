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
      "privilege_required": "authenticated",
      "prior_art": "git log -S listUsers: introduced 2024-03 (8b12f4a), never revisited. No issue or PR mentions ORDER BY. Prevalence: 1 hit of template-literal SQL vs 37 parameterized call sites — a local slip, not a convention.",
      "endpoint": { "method": "GET", "path": "/api/users", "param": "sort", "in": "query" },
      "evidence": "findings/finding-inj-001/description.md",
      "witness_payload": "?sort=id--"
    }
  ],
  "summary": { "critical": 1, "high": 4, "medium": 6, "low": 3, "informational": 2, "total": 16 },
  "tested_not_vulnerable": [
    { "vuln_class": "ssrf", "disposition": "guard_present",
      "detail": "all outbound fetches use a static host allowlist (src/http/client.ts:20)" },
    { "vuln_class": "injection", "disposition": "not_attacker_controlled",
      "detail": "report template name comes from a server-side enum, never the request (src/report/kinds.ts:8)" }
  ],
  "design_properties": [
    { "vuln_class": "access-control", "detail": "public share links are intentionally unauthenticated; scope is bound to a single object id and revocable (docs/sharing.md:14, src/share/resolve.ts:31)" }
  ],
  "unverified_assumptions": [
    { "vuln_class": "config", "investigated": "read nginx.conf and the Helm chart in-repo; both terminate TLS upstream and the app never sets HSTS itself",
      "evidence_needed": "the deployed edge/CDN TLS and HSTS configuration, which is not in this repository" }
  ],
  "finding_relations": {
    "duplicates": [ { "canonical_id": "finding-inj-001", "duplicate_ids": ["finding-xss-007"],
                      "reason": "same template-literal SQL at userRepo.ts:130 reached from the same request param; the xss auditor filed it from the render side of one stored-taint path" } ],
    "subsumed":   [ { "parent_id": "finding-ac-002", "subsumed_ids": ["finding-inj-004"],
                      "reason": "finding-inj-004 is reachable only through the unauthenticated admin router in finding-ac-002; gating that router closes its only untrusted path" } ],
    "chains":     [ { "finding_ids": ["finding-ac-009", "finding-log-003"], "composed_severity": "high",
                      "reason": "ac-009 reads arbitrary files under the app root; log-003 writes a session token to a predictable path under that root. Together: unauthenticated session takeover." } ]
  },
  "coverage_gaps": [
    { "item": "deserialization in worker queue", "reason": "queue payload schema not fully traced (dynamic dispatch)", "recommended_action": "trace src/workers/*.ts consumers" },
    { "item": "full SCA of transitive dependencies", "reason": "no scanner installed; only direct deps reviewed", "recommended_action": "run osv-scanner / composer audit in CI" }
  ]
}
```

### Field rules

- **`findings[]`** — required keys: `id`, `title`, `severity`, `confidence`, `status`, `vuln_class`,
  `owasp`, `location` (file + line), `source`, `sink`, `privilege_required`. Optional: `cwe`, `cvss`,
  `trace`, `slot_type`, `externally_reachable`, `endpoint`, `witness_payload`, `write_site`, `prior_art`,
  `locations`, `evidence`, and the aggregator-written `severity_reported` (as filed), `severity_cap_applied`,
  `severity_revision`, `confidence_note`, `privilege_note`, `merged_ids`.
- **Enum fields with a note** — `**Confidence**: probable (platform fact outside the repo)` and
  `**Privilege required**: none (precondition: a Slack workspace membership)` are valid: the aggregator reads
  the **leading token** against the enum and stores the remainder as `confidence_note` / `privilege_note`.
  Write the token first; a token the enum does not contain is a violation (`unknown` for privilege, a
  `coverage_gaps` entry for confidence), never a silently dropped finding.
- **`orchestrator_adjustments`** (input, in `plan/_relations.json`; output visible per finding) — the only two
  post-filing edits the orchestrator may make, each with evidence:
  ```json
  "orchestrator_adjustments": {
    "severity_overrides": [ { "id": "finding-auth-auth-s1-002", "severity": "medium",
        "by": "resource-exhaustion-auditor (class owner)", "reason": "pre-auth work-imbalance rule applied …",
        "evidence": "findings/finding-auth-auth-s1-002/resource-exhaustion-addendum.md" } ],
    "additional_locations": [ { "id": "finding-life-001", "note": "same root cause found by follow-up life-f1",
        "evidence": "findings/_safe-data-lifecycle-f1.md",
        "locations": [ { "file": "src/routes/stream.ts", "line": 95, "channel": "GET /v0/sessions/:id/events/stream" } ] } ]
  }
  ```
  An override is applied **before** the privilege cap (the cap still wins) and recorded on the finding as
  `severity_revision {from, to, by, reason, evidence}` with `severity_reported_by_filer` kept; additional
  locations append to `locations[]` and surface as SARIF `relatedLocations`. An adjustment naming an unknown
  finding or an invalid severity is a `contract_violations` entry, not a crash.
- **`id` / `evidence`** — auditors write per-class on-disk dirs `findings/finding-{prefix}-{NNN}/`
  (core: `inj`/`xss`/`ac`/`ssrf`/`auth`/`sec`/`crypto`/`deps`/`cfg`/`log`; extended: `biz` business-logic /
  `feat` feature-abuse / `life` data-lifecycle / `cli` client-side / `http` http-protocol / `ai` ai-llm /
  `dos` resource-exhaustion; plus `sweep` for the adversarial-sweep agent, whose findings share the
  same shape and the same bar) to
  stay collision-free across parallel runs. **Keep that class-prefixed id as the finding `id`** — do NOT renumber to a flat `finding-001` —
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
- **`privilege_required`** (required on every finding) — the **minimum** attacker position needed to reach
  the sink, as the trace actually describes it. Closed enum: **`none`** (unauthenticated network peer, or
  attacker-supplied file/message input) · **`authenticated`** (any logged-in user) · **`admin`** (an elevated
  role in the application) · **`maintainer`** (repository or package-publish rights) · **`local-root`**
  (already root on the host), plus **`unknown`** — reserved for the aggregator when a finding arrives without
  the field and the trace does not settle the principal. `unknown` applies **no** cap (an unresolved
  privilege must not silently lower severity) and requires a `coverage_gaps` entry naming the finding; an
  auditor must never emit it. It is a discrete field, not prose folded into the severity rationale, so a
  reader can filter "what is exploitable with no account" without re-reading every trace. It also constrains
  severity: `admin` and above cannot be `critical`, and `maintainer`/`local-root` cap at `medium` — if your
  severity and your `privilege_required` disagree, one of them is wrong. A precondition **at or above** the
  effect is not a low-privilege finding at all, it is circular — see `SKILL.md` → *Precondition subsumes
  conclusion*.
- **`prior_art`** (optional, strongly expected on `high` findings) — one or two sentences recording the two
  checks from `SKILL.md` → *Prior art and prevalence*: what the git history and issue tracker say about this
  code, and the prevalence count as `<n> hits` with the literal command. "Never reported" and "the maintainer
  declined this in #412 but the guard they cited was removed in 9af2c1" are both high-value sentences, and
  neither is recoverable later. A **systemic** finding (the pattern is the project's convention) must carry
  the count here and list the sibling sites in `locations[]` rather than being filed N times.
- **`confidence`** — `high` (complete, unambiguous code trace) or `probable` (likely flaw, a branch/helper
  not fully inspected) for every entry in `findings[]`. `unconfirmed` (suspected, no complete path) is
  **not a finding**: record it under `coverage_gaps` only, never in `findings[]` — this keeps the headline
  count deterministic across runs. In hybrid mode a live corroboration may raise `probable`→`high`.
- **`status`** — `open` | `remediated` | `accepted-risk` (default `open`). `accepted-risk` is set **only** by the
  aggregator from the operator's accepted-risk file (below) — never by an auditor, and never inherited from a
  previous report: a risk accepted last run whose entry is absent now comes back `open` with a recorded
  `contract_violations` entry, so an acceptance cannot outlive the file that records it.
- **`fingerprint`** (aggregator-written, every finding) — the finding's **cross-run identity**: `fp_` + 16 hex
  of a hash over `vuln_class`, the sink **file**, the sink **expression**, `slot_type`, the source
  **expression** and the source **file**. **No line number goes in**, so an unrelated edit above the sink
  does not change it; a renamed sink file does, and that reads as a new finding — the documented limit. Two
  surviving findings with identical material (one raw query pasted twice in one file) get `-2`, `-3`
  suffixes in ascending sink-line order. The per-run `id` stays the on-disk name; the fingerprint is what
  `--previous`, the accepted-risk file, SARIF (`partialFingerprints["codeaudit/fingerprint"]`) and any
  tracker should key on.
- **`change`** / **`first_seen`** / **`previous_id`** — written when the aggregator ran with `--previous
  <older codeaudit-report.json>`: `change` is `new` or `persisting` (`null` when no previous report was
  given), `first_seen` is the date the fingerprint was first reported (inherited through successive
  reports), `previous_id` the id it carried last time. An older report with no fingerprints is recomputed,
  not rejected.
- **`accepted`** — `{ reason, by, date, expires }` copied from the matching accepted-risk entry when
  `status` is `accepted-risk`.
- **`run_diff`** (top level; `null` without `--previous`) — `{ previous_report, previous_engagement,
  previous_date, new[], persisting[], not_refound[], note }`. **`not_refound` is a list to verify, never a
  list of fixes**: a finding can vanish because the code was fixed, because the file was renamed, because
  an auditor skipped it, or because this run's recon never reached it. Confirm each with git history or a
  focused re-dispatch before anything is marked `remediated`.
- **`revalidation`** (aggregator-written, every finding; `null` when the finding-verifier did not examine
  it) — the independent second opinion from Step 6.5c: `{ verdict: confirmed | uncertain, disposition,
  cited, reasoning, by, rebuilt_trace, adjusted_severity, adjusted_confidence, overridden? }`. A
  `confirmed` with an adjusted severity shows up as a `severity_revision` by the verifier (caps still apply);
  an `uncertain` holds the finding's confidence at `probable`. A `refuted` verdict never appears here — a
  refuted finding is not in `findings[]` (next field). `overridden` records an orchestrator
  `verification_overrides` entry that reinstated a refuted finding as `uncertain`, with who and why.
- **`refuted[]`** (top level) — findings an auditor filed and the finding-verifier refuted **with a
  disposition and a cited `file:line`**: `{ id, title, vuln_class, severity_reported, disposition, cited,
  reasoning, by, evidence }`. Each is also appended to `tested_not_vulnerable` with that disposition, so a
  refutation is a rule-out like any other — and the write-up stays on disk in the finding's directory next to
  its `verification.md`. A refutation without a citation is downgraded to `uncertain` at aggregation with a
  recorded violation: an uncited opinion never removes a finding. `--verified-min <severity>` adds a
  `coverage_gaps` entry (`kind: "unverified"`) for every open finding at or above that band that carries no
  verdict, so "the pass ran" cannot hide "the pass skipped this one".
- **`orchestrator_adjustments.verification_overrides[]`** (input, in `plan/_relations.json`) — the third and
  last post-filing edit the orchestrator may make: `{ id, reason, by, evidence }` reinstates a refuted
  finding as `uncertain` when the cited line does not discharge it. The reason is required; an entry naming
  a finding that was not refuted is a violation.
- **`skipped_paths`** (top level) — the skipped registers of every auditor (`SKILL.md` → *The skipped
  register*): the `coverage_gaps` entries with `kind: "skipped"`, each a path an auditor declared it
  declined, refused or did not finish. They stay in `coverage_gaps` too; this array exists so the orchestrator
  and the reader cannot miss them in a long gaps list.

#### The accepted-risk file (`.codeaudit-accepted.json`, operator-owned)

Lives at the root of the audited repository, is committed, and is the only input that turns a finding into
`accepted-risk`:

```json
{ "accepted": [
  { "fingerprint": "fp_3f9c2a1b7e8d4c05", "reason": "object ids are unguessable UUIDs; tracked in SEC-42",
    "by": "security lead", "date": "2026-01-15", "expires": "2026-12-31" }
] }
```

`fingerprint` and `reason` are required; an entry without either is a recorded violation and ignored. An
accepted finding **stays in `findings[]`** with its rating untouched (acceptance is a decision, not a
re-assessment) and is **excluded from `summary`**, which gains an `accepted_risk` count; in SARIF it becomes a
`suppressions[]` entry so code-scanning UIs hide it without losing it. A fingerprint in the file that matches
no finding is listed under `aggregation_stats.accepted_unmatched` — the usual cause is a sink rename that
changed the fingerprint, which is the moment to re-read the acceptance rather than carry it forward blindly.
- **`depth`** — `Quick` | `Standard` | `Thorough` (default). Records how far indirect/second-order flows
  were chased. It does NOT cap which sources were covered: a complete audit traces every in-scope source
  regardless of depth — depth only governs how deep each path is followed.
- **`coverage_gaps`** — unconfirmed flaws and any class/area not fully traced (e.g. dynamic dispatch that
  could not be resolved statically, or a class with no scanner installed). First-class section. There is
  no time-based de-scoping — a code audit runs to completion.
- **`tested_not_vulnerable`** — vectors analyzed where the invariant **holds**. Each entry carries a
  `disposition` from a closed enum, so a rule-out is auditable instead of free text:
  **`guard_present`** (a correct, context-matched defense is on every path — cite it) ·
  **`not_attacker_controlled`** (the value is a constant, a server-side enum, or derived only from trusted
  state) · **`not_reachable`** (no network entry point reaches it — see Reachability) ·
  **`by_design`** (intended behaviour backed by a maintainer statement or documentation **re-verified against
  current code**) · **`precondition_subsumes`** (circular — the attacker already holds the effect) ·
  **`model_gap`** (cannot be routed to any of the above; the audit's own understanding is incomplete — this
  is the honest escape hatch, and an entry here is a signal to revisit, not a clearance).
  When a **threat model** was produced (Step 6.2b), three more become available, and each one **must** cite
  the model field that backs it — that citation is what makes the rule-out auditable and inheritable:
  **`out_of_model_adversary`** (requires a capability `adversaries.out_of_scope` excludes) ·
  **`out_of_model_component`** (lands in code the model places outside it — cite `out_of_scope[i]` or
  `components[i]`) · **`out_of_model_non_default_build`** (only manifests under a discouraged or non-default
  `build_variants[i]`). Two rules keep these honest: a rule-out resting **only** on a `provenance: "inferred"`
  model claim is `model_gap`, not a clearance; and a sink whose entry point is absent from `entry_points[]`
  is `model_gap` too — the model is incomplete, which is a reason to revisit it, not to drop the sink.
  Every entry needs the `file:line` of whatever discharges it. `model_gap` is the exception: it needs the
  open question instead.
- **`design_properties`** — behaviour that is **intentional and confirmed as such**, with the evidence that
  makes it intentional (documentation, a code comment stating the reason, a maintainer decision). This is
  what stops the next run from re-reporting a deliberate choice, and it is distinct from
  `tested_not_vulnerable`: that one says *we checked and it holds*, this one says *it is meant to be this
  way*. An "intentional" claim with no evidence is not a design property — it is an assumption.
- **`unverified_assumptions`** — facts the source cannot settle: deployed TLS and reverse-proxy
  configuration, CDN/edge behaviour, IdP policy, production secrets and runtime config, browser specifics,
  hardware. **Each entry must name both the investigation performed and the evidence that would settle it**
  — an assumption without the work behind it is indistinguishable from not having looked. Keep these out of
  `tested_not_vulnerable` (recording an unknown as safe is a false clearance) and out of `coverage_gaps`
  (which would lose the fact that you investigated).

- **`finding_relations`** — how the surviving findings relate to each other, in three arrays:
  `duplicates` (same root cause, keys differed), `subsumed` (the parent's fix closes the child, and the child
  has no independent path), `chains` (members compose into a higher-severity attack than any alone; carries
  `composed_severity` and states the exploit order in `reason`). Written by the Step 6.6 aggregator, never by
  an auditor — only the aggregator sees every class at once, which is exactly why `chains` exists: each
  member is correctly rated low in its own auditor's scope. **Relations never alter `summary` counts or
  member severities**; a chain's composed severity lives in its `reason`, so the tally stays reproducible.
  Emit all three arrays even when empty.

> The four evidence arrays are **separate on purpose and all four are expected, even when empty**. Collapsing
> them loses the difference between *we checked and it holds*, *this is deliberate*, *we could not tell from
> source*, and *we did not get to it*. Empty `findings[]` is never proof of complete coverage — these arrays
> are what makes coverage provable.
- **`summary`** — severity counts computed over the **open** entries of `findings[]` only. Because
  `findings[]` carries only `high`/`probable` confidence (`unconfirmed` lives in `coverage_gaps`) and the
  headline vulnerability tally excludes `informational` (see Exploitability bar), `summary.total` counts
  exactly the confirmed, open findings (`confidence ∈ {high, probable}`, severity ≥ `low`, `status ≠
  accepted-risk`) — the same input twice yields the same total. `summary.accepted_risk` counts the entries
  excluded by acceptance, so the two numbers always add back up to the listed findings.

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

**`privilege_required` caps severity — apply these after the band above, not instead of it.** They make the
rating reproducible across runs instead of leaving it to narrative emphasis:

| `privilege_required` | Maximum severity | Why |
|---|---|---|
| `none` | `critical` | no precondition to discount |
| `authenticated` | `high` | an account is a real barrier; `critical` is reserved for unauthenticated reach |
| `admin` | `high` | an elevated role already holds broad authority — it cannot be `critical` |
| `maintainer` | `medium` | publish/commit rights already imply code execution downstream |
| `local-root` | `medium` | already root on the host |
| `unknown` | *(no cap)* | aggregator-only; an unresolved privilege must not lower severity by default |

If the cap and your band disagree, the cap wins and you say why in the finding. If applying the cap makes the
finding look trivial, check it is not actually **circular** (`SKILL.md` → *Precondition subsumes
conclusion*) — a `maintainer`-privilege finding whose effect *is* maintainer-level authority is not a low
finding, it is a non-finding.

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

Extended-class OWASP anchors: **business-logic** → A04 Insecure Design; **feature-abuse** → A04 / A01;
**data-lifecycle** → A01 Broken Access Control; **client-side** → A03 (DOM injection) / A05; **http-protocol**
→ A05 Security Misconfiguration; **resource-exhaustion** → A04 Insecure Design (uncontrolled resource
consumption); **ai-llm** → A04 Insecure Design, cross-referenced to the **OWASP LLM
Top-10** (LLM01 prompt injection, LLM06 excessive agency, LLM08 vector/embedding, etc.) — an auditor MAY set
`owasp` to the `LLMNN` code where it is the better fit.

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
| business-logic | CWE-840 business-logic · CWE-841 workflow · CWE-362/367 race/TOCTOU · CWE-639 authz-logic · CWE-190 numeric |
| feature-abuse | CWE-200 exposure · CWE-213 intended-info-exposure · CWE-639 IDOR-via-feature · CWE-918 webhook-SSRF |
| data-lifecycle | CWE-639 IDOR · CWE-566 authz-bypass-via-key · CWE-283 unverified-ownership · CWE-459 incomplete-cleanup |
| client-side | CWE-79 DOM-XSS · CWE-1321 prototype-pollution · CWE-346 origin · CWE-942 CORS · CWE-1021 clickjacking · CWE-601 navigation |
| http-protocol | CWE-444 request-smuggling · CWE-524/525 cache · CWE-113 response-splitting · CWE-644 host-header |
| ai-llm | CWE-1427 prompt-injection-to-action · CWE-77/74 downstream-injection · CWE-285/862 authorization · CWE-668 exposure |
| resource-exhaustion | CWE-400 uncontrolled-consumption · CWE-770 alloc-without-limits · CWE-1333 ReDoS · CWE-409 decompression-bomb · CWE-834 excessive-iteration · CWE-405 asymmetric |

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
- **Confidence:** {confidence}   **Reachable:** {externally_reachable}   **Privilege required:** {privilege_required}
- **Location:** `{file}:{line}`
- **Source → Sink:** `{source}` → `{sink}`  (slot: {slot_type})
- **Trace:** {trace hops}
- **Why vulnerable:** {1-2 lines: missing/mismatched defense}
- **Code:** {short fenced snippet at the sink}
- **Remediation:** {specific fix}
{ - **Prior art:** {prior_art}  (git history / issue tracker / prevalence count)}
{ - **Witness payload:** {payload}  (optional)}
{ - **Live corroboration:** {result}  (hybrid only)}

## Vectors Tested — Not Vulnerable
{bullet list from tested_not_vulnerable, each prefixed with its [disposition]}

## Related & Chained Findings
{From `finding_relations`. Lead with `chains` — a chain is the part of the report a per-class reader cannot
reconstruct: state the composed effect, the exploit order, and each member's own severity. Then `subsumed`
(fix the parent first — name which fix closes which child), then `duplicates` (one line, canonical id).
Omit the section only when all three arrays are empty.}

## Design Properties — Intentional Behaviour
{bullet list from design_properties, each with the evidence that it is intended. Omit the section only if the array is empty.}

## Unverified Assumptions — Not Decidable From Source
{bullet list from unverified_assumptions, each as "{investigated} → still needs: {evidence_needed}".
This section is the honest boundary of a static audit; do not drop it to make the report look cleaner.}

## Coverage Gaps & Recommendations
{bullet list from coverage_gaps}

## Appendix — Methodology & Scope
{classes, languages, files-in-scope, depth, tools used}
```
