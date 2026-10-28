# Code-Audit Output Structure

The working layout written during an audit by the auditor agents and aggregated by the
`/codeaudit:codeaudit` command. The final deliverable shape (`codeaudit-report.json` + `report.md`) is
defined in [`REPORT_CONTRACT.md`](REPORT_CONTRACT.md).

```
outputs/{engagement}/
├── activity/                       # NDJSON logs, one per agent
│   ├── codeaudit-orchestrator.log
│   ├── code-recon.log
│   ├── threat-modeler.log
│   ├── adversarial-sweep-{mode}.log
│   └── {class}-auditor.log
├── recon/                          # baseline (the foundation)
│   ├── attack-surface.md           # entry points, sources, sinks, trust boundaries
│   ├── architecture.md             # stack, frameworks, data flows, security mechanisms
│   ├── sink-inventory.json         # machine-readable: sinks by class (file:line) + entry_points[] (route↔source map) + exported_surface[] + ecosystems[] (reference routing + version pins)
│   ├── _coverage.json              # written by tools/recon-coverage.py (Step 6.2 gate): route-shaped files vs recon's handler inventory, residue by directory
│   └── threat-model.json           # the security contract: entry-point trust table, adversaries, properties provided/disclaimed, controls + assumptions, dispositions
├── plan/
│   ├── deployment-plan.json        # which auditors, against which components
│   └── audit-plan.md               # human narrative of the plan
├── findings/
│   ├── _safe-{class}.md            # REQUIRED per auditor — the four evidence categories (format below)
│   ├── _safe-sweep-{mode}.md       # adversarial-sweep negatives (blind-dig | challenge-exclusion)
│   ├── finding-sweep-{NNN}/        # adversarial-sweep findings — same shape as any auditor's
│   └── finding-{NNN}/
│       ├── description.md          # REQUIRED — details, trace, impact, remediation
│       ├── snippet.txt             # the vulnerable code at the sink (with file:line header)
│       ├── trace.md                # full source→sink hop list with file:line each hop
│       ├── poc.md                  # OPTIONAL — witness payload / repro idea (no live exec required)
│       ├── corroboration.txt       # OPTIONAL — live witness result (hybrid mode only)
│       └── verification.md         # written by the finding-verifier (Step 6.5c) — cited verdict: confirmed | refuted | uncertain
├── codeaudit-report.json           # ALWAYS — fixed machine schema
├── report.md                       # ALWAYS — consolidated human report
└── pr-comment.md                   # diff mode (`render.py --pr-comment`): the net-new findings, review-sized; absent on a green run
```

Diff mode (`/codeaudit:codeaudit-diff`) adds `plan/_diff-scope.json` — the changed files plus one import hop
each way, written by `tools/diff-scope.py` — and reuses the previous engagement's `recon/` and
`threat-model.json` by path. An interrupted engagement is probed by `tools/resume.py`, which reads the tree
above and never writes to it.

```
```

## Activity Log (NDJSON)

**Location**: `outputs/{engagement}/activity/{agent}.log` — one JSON object per line.

**Orchestrator**:
```json
{"timestamp":"2026-06-18T10:00:00Z","agent":"codeaudit-orchestrator","phase":"init","repo":"/src/acme","result":"started"}
{"timestamp":"2026-06-18T10:02:00Z","agent":"codeaudit-orchestrator","phase":"recon","action":"baseline-complete","sources":48,"sinks":21}
{"timestamp":"2026-06-18T10:05:00Z","agent":"codeaudit-orchestrator","phase":"planning","action":"plan-ready","auditors":7}
{"timestamp":"2026-06-18T10:35:00Z","agent":"codeaudit-orchestrator","phase":"audit","action":"auditors-complete","findings":16}
```

**Auditor**:
```json
{"timestamp":"2026-06-18T10:10:00Z","agent":"injection-auditor","action":"recon","sources_to_trace":12}
{"timestamp":"2026-06-18T10:12:00Z","agent":"injection-auditor","action":"trace","source":"req.query.sort","sink":"userRepo.ts:130","slot":"SQL-keyword"}
{"timestamp":"2026-06-18T10:13:00Z","agent":"injection-auditor","action":"verdict","finding":"finding-001","verdict":"vulnerable","confidence":"high"}
{"timestamp":"2026-06-18T10:20:00Z","agent":"injection-auditor","action":"safe","vector":"login username param","reason":"parameterized via prepared statement"}
```

## description.md template (per finding)

```markdown
# [{vuln_class}] {title}

**Severity**: {critical|high|medium|low|informational}
**Confidence**: {high|probable|unconfirmed}
**OWASP**: {Axx:2021 ...}   **CWE**: {CWE-xx}   **CVSS**: {score, optional}
**Reachable**: {externally_reachable}   **Privilege required**: {none|authenticated|admin|maintainer|local-root}

## Location
`{file}:{line}`

## Source → Sink
- **Source**: {param} in `{query|path|header|cookie|json|form}` (`{file}:{line}`)
- **Path**: {hop → hop → sink}
- **Sink**: {sink call} (`{file}:{line}`), slot `{slot_type}`
- **Endpoint** (when resolvable): {METHOD} {path} — resolved from recon `entry_points` (the Step 6.6
  aggregator copies this into `codeaudit-report.json` `endpoint` for the pentest hybrid handoff; omit if the route is dynamic)

## Why it is vulnerable
{Plain-language: the tainted value reaches a {slot} slot with {no defense | wrong defense | defense
nullified by post-sanitization concat at file:line}.}

## Code
```{lang}
{short snippet at the sink}
```

## Impact
{What an attacker achieves on a network-reachable path.}

## Remediation
{Specific, idiomatic fix for this stack — e.g. "use parameterized query / allowlist the column".}

## Prior art & prevalence
{What `git log -S` / `git log --grep` and the issue tracker say about this code, and the prevalence count as
`<n> hits` with the literal command. Write "searched X and Y, nothing found" when that is the answer — a
recorded negative search is worth more than silence. Copied into the report's `prior_art` field.}

## Witness payload (optional)
`{payload}`  — structure-influence probe for the exploit/validation phase. Not executed during a
static audit; in hybrid mode a single benign corroboration may be attempted.
```

**Parsed labels — keep them verbatim.** `tools/aggregate.py` reads the first line (`# [{vuln_class}] {title}`),
the bold `**Severity**` / `**Confidence**` / `**Privilege required**` fields (leading enum token; a
parenthetical after it is kept as a note), and the `- **Source**:` / `- **Sink**:` / `- **Path**:` bullets
under `## Source → Sink`. On a real engagement three findings lost their endpoint resolution because one
wrote `**source**` in lower case, one wrote the source as prose with no bullet, and one wrote
`**Source** (primary):` — the parser now tolerates the first and third, but a `Source` bullet with **no
`file:line`** is a recorded contract violation and the finding cannot be handed to the pentest plugin. One
primary source per finding; secondary sources go in the prose or in `locations[]`.

## `verification.md` (per finding, written by the finding-verifier only)

The second opinion, additive and never edited by the filer. `tools/aggregate.py` reads the bold labels
(leading enum token first) and the two sections:

```markdown
# Verification — finding-inj-001

**Verdict**: refuted
**Disposition**: guard_present
**Cited**: src/db/repo.ts:88
**Adjusted severity**: none
**Adjusted confidence**: none
**Verifier**: finding-verifier (batch v1)

## Reasoning
Five to ten sentences showing the rebuilt hop, the guard found or not found, the git history, the ecosystem
or threat-model row relied on, and — for a bypass — the exact input.

## Rebuilt trace
src/api/users.ts:42 → src/service/list.ts:88 → src/db/repo.ts:130
```

`Verdict` ∈ `confirmed | refuted | uncertain`. A `refuted` needs a `Disposition` from the closed enum **and** a
`Cited` `file:line`; without both the aggregator records a violation and treats it as `uncertain`.
`Adjusted severity` ∈ `none` + the severity enum; `Adjusted confidence` ∈ `none | high | probable` (never
`unconfirmed`). What each verdict does to the finding is in `REPORT_CONTRACT.md` → `revalidation` / `refuted`.

## `_safe-{class}.md` format (the four evidence categories)

Each auditor writes exactly one of these (one per **shard** when a class is sharded:
`_safe-{class}-{shard}.md`). The Step 6.6 aggregator splits it on these four headings into the matching
top-level arrays of `codeaudit-report.json`, so **the headings are the contract** — keep them verbatim, and
keep all four even when a section is empty (write `- none`).

```markdown
# Evidence — {class}-auditor{ (shard {shard})}

## tested_not_vulnerable
- [guard_present] all outbound fetches go through a static host allowlist (src/http/client.ts:20)
- [not_attacker_controlled] report template name comes from a server-side enum (src/report/kinds.ts:8)
- [precondition_subsumes] "operator can edit the plugin dir" — already code execution
- [model_gap] admin impersonation flow: could not resolve which principal the audit log binds to

## design_properties
- public share links are intentionally unauthenticated, scoped to one object id and revocable
  (docs/sharing.md:14, src/share/resolve.ts:31)

## unverified_assumptions
- investigated: read nginx.conf + the Helm chart; both terminate TLS upstream, the app never sets HSTS
  itself → still needs: the deployed edge/CDN TLS and HSTS configuration (not in this repository)

## coverage_gaps
- deserialization in the worker queue — payload schema not statically resolvable (dynamic dispatch)
  → recommended: trace src/workers/*.ts consumers
- [skipped] src/legacy/exploit-samples.ts — declined: reads as a payload corpus; analysis stopped at line 40
```

Rules for this file:
- A `coverage_gaps` line opening with **`[skipped]`** is the **skipped register** (`SKILL.md` → *The skipped
  register*): one line per path in your scope you declined, refused, or did not finish, as
  `- [skipped] path — why`. The aggregator keeps the path verbatim, tags the entry `kind: skipped`, lists it
  under `skipped_paths` in the report and prints it as its own section, and the orchestrator re-dispatches on
  it. Write the path, not a description — the orchestrator dispatches on what you wrote.
- A `tested_not_vulnerable` line **must** open with a `[disposition]` from the closed enum in
  `REPORT_CONTRACT.md` and carry the `file:line` that discharges it (`model_gap` carries the open question
  instead).
- An `unverified_assumptions` line **must** contain both halves — what you investigated **and** what evidence
  would settle it. A bare "TLS config unknown" is not an assumption entry, it is a shrug.
- Do not promote an `unverified_assumptions` item into `tested_not_vulnerable` to tidy the report. Recording
  an unknown as safe is a false clearance, and it is the one error in this file that actively misleads.
- **Cite paths so a machine can match them.** The Step 6.5 reconciler matches your `file:line` citations
  against recon's enumerated sources by path suffix. Full paths from the repo root always match. If you
  condense (a long handler directory cited a hundred times), **declare the alias once in the file's first
  lines** in exactly this shape — ``` `H/` = `src/server/routes/route-handlers/` ``` — and the reconciler
  expands it. An undeclared abbreviation makes every source you verdicted look uncited, and the orchestrator
  will dispatch a follow-up over work you already did.

## Orchestrator-side plan files (Step 6.5 / 6.6 inputs)

These are written by the orchestrator, not by auditors, and are read by the shipped tools:

| File | Written at | Read by |
|---|---|---|
| `plan/_relations.json` | Step 6.6 point 1 ("Relate what you did not merge") | `tools/aggregate.py --relations` |
| `plan/_meta.json` | Step 6.6 (engagement / repo / commit / scope / depth / ecosystems block) | `tools/aggregate.py --meta` |
| `plan/_narrative.json` | Step 6.6 point 3, before rendering | `tools/render.py` |
| `plan/_handoffs-wave{N}.md`, `plan/_handoffs-residue-f{N}.md` | between waves / after reconciliation | the next wave's auditors |
| `plan/_context-additions.md` | Step 6.7 (`tools/context.py propose`) | the operator, then `tools/context.py apply` into `{repo}/.codeaudit-context.md` |

`_relations.json`: `{ "duplicates": [], "subsumed": [], "chains": [], "orchestrator_adjustments": {
"severity_overrides": [], "additional_locations": [], "verification_overrides": [] } }` — shapes in
`REPORT_CONTRACT.md`.

`_narrative.json` keys (every one optional; a missing key renders as a visible `TODO-ORCHESTRATOR` marker):
`plugin_version` · `executive_summary[]` (2-5 paragraphs: nature of the engagement, posture, counts, the single
most important risk with its precondition stated plainly, the chains, the design property that frames the
authorization findings) · `model_corrections[]` (threat-model rows overturned during the waves, each with the
shard that established it) · `cross_references[]` (pairs that are *not* relations, and why) ·
`design_properties_lead[]` · `coverage_gaps_lead[]` · `coverage_statement` · `reconciliation_statement` ·
`sweep_statement` · `exec_summary_page[]` · `exec_boundaries[]` · `exec_top_n` · `remediation_groups[]` of
`{ title, priority (P0|P1|P2), area, finding_ids[], business_impact, fix, acceptance }`.

## Rules

- **Always log**: every trace and verdict to the activity log.
- **Always cite**: `file:line` for source, every hop, and the sink.
- **Always record negatives, in four separate buckets**: `tested_not_vulnerable` (with a `[disposition]`),
  `design_properties`, `unverified_assumptions`, `coverage_gaps` — see the `_safe-{class}.md` format above.
- **Always state the privilege**: every finding carries `privilege_required`; it caps severity
  (`REPORT_CONTRACT.md` → severity rubric).
- **No theoreticals as confirmed**: a finding without a complete code trace is `unconfirmed` and goes in
  coverage gaps.
- **Git-tracked only**: flag tracked files; untracked secrets are informational.
