---
name: code-audit
description: White-box source code security audit methodology. Source-to-sink taint tracing, sink cataloging, sanitizer-to-context matching, confidence scoring, and false-positive discipline for static code analysis. Mounted by all codeaudit auditor agents and the code-recon baseline agent.
---

# Code Audit Methodology

The shared methodology for the `codeaudit` plugin. Every auditor agent mounts this skill plus its
class-specific reference before analyzing code. It defines **how to prove a vulnerability from source
code alone** — without running the application — and how to express findings deterministically.

## When to Use This Skill

Mount this skill at the start of any code-audit agent (`code-recon`, `*-auditor`). It is the source
of truth for the audit verdict process. Class-specific payload and sink knowledge lives in the
reference files and in the reused `plugins/pentest/skills/pentest/attacks/**` catalog.

---

## Core principle: Code is ground truth

A code audit proves the **structural possibility** of a vulnerability by tracing how untrusted input
reaches a dangerous sink without the correct defense. You do not need a running application to reach a
verdict — the data flow in the code *is* the evidence. When a live URL is provided (hybrid mode), live
behavior **corroborates** a code finding; it never replaces the code trace.

This inverts the blackbox model: instead of throwing payloads and observing, you read the code, build
the taint graph, and reason about whether a defense is present and correct for the sink's context.

## The source → sink model

Every finding is a **path**:

```
SOURCE (untrusted input)  →  [transforms / sanitizers]  →  SINK (dangerous operation)
```

- **Source** — any value an attacker can influence: HTTP params/body/headers/cookies, route params,
  uploaded filenames, JSON/GraphQL fields, message-queue payloads, env-derived request data,
  WebSocket frames, second-order sources (a DB row written from a prior tainted input), and
  **AI/LLM/model output** — the response of an AI system is attacker-influenceable (upstream prompt
  injection, or simply unconstrained generation) and must be treated as untrusted wherever it reaches a
  sink (HTML render, shell, query, file path, deserialization).
- **Transforms** — assignments, function calls, string operations the value passes through. Normalizers
  (lowercasing, trimming, JSON parse, schema decode) do **not** remove taint.
- **Sanitizer** — a defense that neutralizes taint *for a specific sink context* (parameterized query,
  output encoder, allowlist, `shlex.quote`, path canonicalization + boundary check).
- **Sink** — the dangerous operation: SQL execution, shell exec, file read/include, template render,
  HTML output, outbound HTTP, deserialization, redirect, etc. See `reference/SINK_CATALOG.md`.

**Second-order (stored) taint.** A read from a data store is tainted **only when** you can link a tainted
*writer* to the *reader*: trace write → store → read and exhibit **both** ends — the handler that persists
attacker input, and the sink that consumes the stored value. Do not taint every DB read blindly (that is
noise); prove the linkage. This is how stored XSS / stored SQLi (Fortify's "Persistent"/"Persistence"
variants) are caught instead of missed. The store boundary is **any** persistence or service hop — DB,
search index (Elasticsearch/Solr), cache, queue, or **your own JSON/GraphQL API**. "It came from our own
backend/aggregation" is **not** a trust boundary: if any write path to that field is user-controllable and
unsanitized, a value later read from it is tainted, even across a `fetch`/serializer round-trip.

## The verdict process (apply per path)

1. **Enumerate sources** from the `code-recon` baseline (`outputs/{engagement}/recon/attack-surface.md`)
   or from your own scan if recon is unavailable. Create one work item per source.
2. **Trace each path** source → sink. **Fork paths**: if one source feeds two different sinks, analyze
   each as an independent path.
3. **Record on each path**: the full hop sequence (controller → service → DAO), every sanitizer (name +
   `file:line` + type), and every concatenation/format/interpolation (flag any that occur *after* a
   sanitizer — they re-introduce taint).
4. **Label the sink slot** — what kind of slot the tainted value lands in (SQL value vs identifier,
   shell argument vs string, file path vs include, HTML text vs attribute vs JS context). The right
   defense depends on the slot. See `reference/SOURCE_TO_SINK.md`.
5. **Match sanitizer to slot context.** A defense that is correct for one slot is useless for another
   (parameter binding does not protect a SQL identifier; HTML-entity encoding does not protect a JS
   context).
6. **Verdict**: `vulnerable` if a tainted value reaches a slot with **no** defense, the **wrong** one
   (or one nullified by post-sanitization concatenation), or a **right-type-but-inadequate** one — a
   defense of the correct category that is incomplete or bypassable (insufficient char set for the slot,
   blocklist instead of allowlist, mis-anchored regex — `^` without `$`, `.` matching newlines —,
   single-pass on a later-re-decoded value (double-decode / mutation XSS), or a bypassable escape such as
   `addslashes` under a multibyte charset). Otherwise `safe`. **Adequacy guard** (keeps this signal, not
   noise): to call an inadequate defense `vulnerable`, you MUST name the concrete input/character/encoding
   that defeats *this* sanitizer. If you cannot exhibit the bypass, record `probable` or a coverage gap —
   never `vulnerable` on suspicion. (This is Fortify's "Poor Validation" class — a real exploitable bug
   that a present-but-partial sanitizer otherwise hides as a false negative.)
7. **Score confidence** (see below) and **assess reachability** (network-reachable vs internal-only).

### Guards protect a variable, not a neighborhood

A sanitizer/validator downgrades a finding **only if it is applied to the same variable** (or a provable
derivation of it) that reaches the sink. A check on a *sibling* variable does not protect the sink variable
— e.g. validating `filename.endswith('.xml')` does nothing for a sink that consumes `s3_url`. Never treat
control-flow proximity ("there is a validation near the flow") as a data-flow guard; follow the actual
variable into the sink. This is a general false-negative killer, not specific to any one class.

### The framework and the version are part of the verdict

Steps 5 and 6 cannot be answered from the sink line alone. Whether a defense is present and adequate depends
on what the framework does by default and on which version of it is installed. `reference/ecosystems/` holds
that knowledge per stack: framework defaults (auto-escaping scope, middleware ordering, guard inheritance, ORM
parameterization), versioned CVE cutoffs **with their preconditions**, an explicit non-finding list, and `rg`
seeds. **Load the file for every ecosystem present in your scope before you write a verdict** — see
`reference/ecosystems/README.md` for the routing table.

Two rules bind every auditor:

1. **Every version-sensitive claim must name the installed version and the cutoff it was compared against**,
   and the version must come from the **lockfile** (`package-lock.json`, `poetry.lock`, `composer.lock`,
   `Gemfile.lock`, `go.sum`, `packages.lock.json`, a resolved `mvn dependency:tree`) — never from a manifest
   range and never from memory. Write the comparison into the finding:
   `jsonwebtoken 8.5.1 (package-lock.json:3312) < 9.0.0 cutoff; verify() called without algorithms at auth/jwt.ts:41`.
   If the installed version cannot be resolved, that is a `coverage_gaps` entry naming the package and the
   open question — **never** a finding and **never** a clearance.
2. **A version below a cutoff is not a finding; the precondition is.** Almost every advisory is conditional
   (Spring4Shell needs a WAR deployment, CVE-2024-4577 needs Windows + PHP-CGI, BatBadBut needs a Windows
   `.bat` target, CVE-2025-29927 needs authorization that lives *only* in Next.js middleware). State which
   precondition you confirmed and from what evidence. When the precondition does not hold, the row belongs in
   `tested_not_vulnerable` with that evidence — not dropped silently, and not reported.

The dangerous direction is **clearing** a finding on a remembered cutoff. Before a version fact retires a
candidate, open the source URL in the reference file and confirm the cutoff still reads that way.

### The threat model is the contract you rule sinks out against

When `outputs/{engagement}/recon/threat-model.json` exists, read it before tracing. It is not a filter and it
never tells you a sink is safe — it is a **contract you cite**, and the difference matters:

- Look each sink's entry point and parameter up in `entry_points[]`. `attacker_controllable: "no"` is a
  rule-out you can cite (`not_attacker_controlled`, naming the row); `"conditional"` hands you the row's
  `condition`, which is the precondition you carry into severity and into `privilege_required`.
- `provenance: "inferred"` rows are **hypotheses, not evidence**. The model author reasoned them out the same
  way you would. Overturn one from code whenever the code disagrees — and a rule-out resting *only* on an
  inferred claim is `model_gap`, never a clearance.
- A sink whose entry point is **absent from the table** is `model_gap` as well. That is a gap in the model, a
  reason to revisit it, and never a reason to drop the sink.
- `controls[].assumptions` is where to attack a design control: "requests reach this package only through the
  authenticated router" is a claim. If your trace violates that assumption, the control did not hold, and
  saying *which assumption broke* is the most useful sentence in the finding — it points at a design decision
  rather than only at a line.

No model (it failed, or an older engagement) changes nothing structural: use free-text rule-out reasons with
the base six dispositions. An unmodelled audit is a weaker claim, and the report says so.

## Hunting discipline (false-negative killers)

The single-happy-path trace is where audits miss real bugs. Apply moves 1-3 on **every** class, and move 4
wherever the code you are reading makes a security decision — they cost little and turn "looks safe" into a
proven verdict:

1. **Test the sad paths, not just the happy path.** For each source/invariant, ask what the interface does
   with **absent / empty / zero / negative / maximum / over-limit / duplicate / mixed-encoding / stale /
   revoked / reordered / concurrent / partially-migrated / failed-dependency / rollback** state — but only
   where the interface actually accepts that shape. A guard that holds for the normal value often collapses
   on the boundary value (an `int` cast that accepts `-1`, a length check that a second decode defeats, a
   regex anchored `^` but not `$`). Compare canonicalization and units at every parser/policy handoff.
2. **The weakest parallel path is the policy.** The same effect (a state change, a data read, a sink) is
   usually reachable through **several** routes — direct handler, batch/bulk endpoint, admin path,
   import/restore, background job, retry, resumed flow, legacy/compat route, GraphQL vs REST. A defense
   present on the polished UI route but missing on a sibling route is a real finding. Enumerate every door
   to the same operation and audit the one with the least defense — not the most.
3. **Diff cross-component guarantees.** Where component A validates and hands off to component B, compare
   what A actually **guarantees** against what B **assumes** — truncation, type coercion, normalization,
   tenant scope, default values, null handling. "It was validated on the way in" is not a guarantee if a
   different write path, a serializer round-trip, or a later re-decode reintroduces the taint (this is the
   second-order/stored-taint case, generalized to any trust boundary).

4. **Ask the fail-open question — mandatory on security-decision code.** Move 1 is a general habit; this is a
   specific check you must run and record whenever you are already reading **authentication, authorization,
   session validation, CSRF, rate-limit/lockout, signature or credential-validation** code. Identify every
   input whose *presence* controls whether a check runs — cookie, header, token, claim, request field — and
   inspect its **absent / null / empty** branch. Then answer, in writing:
   **if this input is absent, null or empty, does the control fail closed, or is the protected operation
   still reachable?**
   Also test the pairwise case: when two inputs feed one decision, does omitting one cause the other to be
   accepted without its normal validation (a `kid` with no `alg`, a token with no session, a signature with
   no payload)?
   An explicit deny / error / redirect-to-login branch is fail-closed — rule it out and **cite that branch**.
   A control reached only when the input is present, with the operation still reachable when it is absent, is
   a finding. This is one question about code already under review, not a second whole-repository sweep.

These are FN killers, not new finding categories: a candidate they surface still passes the full verdict
process and the exploitability bar before it is reported.

## Confidence scoring

- **high** — complete, unambiguous source→sink trace; correct slot labeling; explicit missing/mismatched
  defense; no post-sanitization concat. Reproducible by re-reading the code.
- **probable** — likely flaw but an upstream transform, helper, or branch was not fully inspected; some
  uncertainty remains.
- **unconfirmed** — suspicious construction (heavy string-building, dynamic dispatch) without a complete
  path or slot classification. Must be listed under coverage gaps, not as a confirmed finding.

## Reachability (in-scope filter)

A finding is **network-reachable** if the tainted path can be initiated by a request the deployed app
can receive (public or behind standard auth). Mark `externally_reachable: true/false`. Out-of-scope:
paths only invocable via CLI scripts, build tools, DB migrations, test harnesses, or local dev
utilities never wired to a route.

**Internal-only is a severity adjustment, not a demotion to `informational`.** Set
`externally_reachable: false` and drop the severity **one band** (`REPORT_CONTRACT.md` → severity rubric),
which is the single rule; do not also recategorise it as hardening. The two are not equivalent — an
internal-only deserialization RCE is `high`, not `informational` — and `informational` is excluded from the
headline vulnerability count, so collapsing the two erases the finding from the tally. Only a path with **no**
reachable caller at all belongs in `tested_not_vulnerable` with `disposition: not_reachable`.

## Git awareness (avoid noise)

Before flagging a file, confirm it is tracked: `git ls-files <path>` (output = tracked). Only flag
**tracked** files as vulnerabilities. Untracked but security-relevant files (a committed-by-accident
`.env`, a stray key) are reported as **informational** secrets findings, not code vulnerabilities. Skip
vendored/generated trees (`node_modules/`, `vendor/`, `dist/`, `build/`, minified bundles) unless a
sink genuinely lives there.

## False-positive discipline (the hard part of static audit)

Do NOT report a finding when:

- A correct, context-matched defense is present on **every** path to the sink.
- The "source" is not actually attacker-controllable (a constant, an enum already allowlisted, a value
  derived only from server-trusted state).
- The sink is not reachable from any network entry point (see reachability).
- An ORM/query builder parameterizes by default and the code uses it idiomatically (no raw fragment).
- The framework auto-escapes the output context by default and no escape-hatch (`dangerouslySetInnerHTML`,
  `v-html`, `| safe`, `mark_safe`, `bypassSecurityTrust*`) is used on the tainted value. **Caveat —
  auto-escape covers the HTML-text context only.** A tainted value in a URL attribute (`<a href={v}>` →
  `javascript:`), an inline event handler, a `<script>`/JSON-in-JS block, a `style`/CSS slot, or a prop
  spread (`{...v}`) still needs a **slot-specific** defense even with no escape-hatch — do not mark those
  `safe` on auto-escape alone.
- **The precondition subsumes the conclusion** (circular finding — see the callout below).
- The candidate matches a row in your ecosystem file's **`## Safe or non-reportable forms`** list. Check it
  there before writing: `$queryRaw` tagged templates, `FromSqlInterpolated`, `execFile` with a literal
  program **and a value that cannot start with a dash** (bare argv is not a free pass — see the `CMD-option`
  slot), `YAML.load` on Psych 4, `BinaryFormatter` on net9.0+, Go `regexp` ReDoS, `md5` as a cache key —
  these are the recurring false positives, already enumerated per stack. A candidate that matches a row is a
  `tested_not_vulnerable` entry, not a finding.

When uncertain whether input is reachable or a helper sanitizes correctly, **downgrade confidence**
rather than dropping or over-claiming. Record the assumption in `notes`.

### Precondition subsumes conclusion (the circular finding)

If reaching the sink requires the attacker to **already hold a capability equal to or greater than what the
sink grants**, the finding is circular: its attack path's first step already arrives at its last step. Write
`precondition subsumes conclusion` and move on.

The shapes that recur:
- "An attacker with write access to the directory the app loads plugins from can execute code." They already
  chose the code.
- "An attacker who can set this environment variable / edit this config file can…" On most deployments that is
  the operator, or it is already local code execution.
- "An attacker with a MITM position can influence the connection this finding says they can influence."
- "An attacker with a valid admin token can call the admin endpoint."
- "An attacker who already has the victim's session cookie can act as the victim."

The test is whether the finding **obtains** the capability or **assumes** it. A path traversal that *yields*
arbitrary file write is a finding; one that *requires* arbitrary file write to reach is not. A session-fixation
bug that *fixes* the cookie is a finding; one that starts from a stolen cookie is not.

This is not the same as a legitimate precondition. "Requires an authenticated low-privilege account" is a
precondition that **lowers severity** (and is exactly what `privilege_required` records) — it does not make the
finding circular, because the account does not already grant the effect. Circularity is specifically
*precondition ≥ conclusion*.

## Prior art and prevalence — run before you write it up

Two cheap checks that change *what you write*, not just whether you write it. Run both on every candidate
that survived the verdict process; record the result on the finding (`prior_art`) or on the rule-out
(`tested_not_vulnerable[].detail`), so the next run inherits the reasoning instead of re-deriving it.

**1. Prior art — has this project already seen this?**

```bash
git log -S '<function or key string>' --oneline -- <path>   # when the code appeared/changed
git log --grep='<keyword>' --oneline                        # a fix, a revert, a discussion
git log -1 --format='%H %ad %s' -- <file>                   # is this code current, or vestigial?
```
Then read what the maintainers said: issues and PRs, open and closed, for `wontfix`, `by design`,
`not a bug`, `out of scope`, and inline `# nosec` / `// nolint` / `# noqa` / `NOSONAR` annotations **with a
stated reason**. A maintainer who has already considered this and declined is a different conversation from
one who has never seen it — quote them. Three outcomes:
- *Already fixed upstream / the code is historical* → not a finding. Historical code is never a finding.
- *Declined with a reason that holds against the current code* → `tested_not_vulnerable` with
  `disposition: by_design`, citing the statement **and** the current `file:line` that makes it still true.
  A stale rationale whose guard has since been removed does **not** rule it out — re-verify, do not inherit.
- *Never seen, or the rationale no longer holds* → finding, and say so in `prior_art`. It is the single most
  useful sentence for whoever receives the report.

**2. Prevalence — is this a slip or the house style?**

Before writing a pattern up as unsafe, grep the whole tree for it and **count the call sites**. Record the
literal command and its hit count as `<n> hits` (write `12 hits`, not a bare `12` — a loose number reads like
a line number or a score).

- **1 site doing this while 40 do it the other way** → a local slip. Ordinary finding; the 40 are your
  evidence that the project knows better, and the fix is to match them.
- **40 sites doing it the same way** → that is a **convention**, which is a claim about project intent your
  finding has to answer. Either the project holds something you have not found (a wrapper that makes the
  pattern safe, a build flag, an invariant the types carry — go find it, and if you find it the candidate is
  `tested_not_vulnerable`), or the finding is **systemic**: file **one** finding whose subject is the
  convention, located at the site you actually traced, listing the other sites in `locations[]`, and
  recommending the shared helper rather than N call-site edits. Do not file 40 findings.

**Prevalence never rules a sink out on its own.** A complete trace outranks any count — what the count changes
is *which of two reports you write*, not *whether* you write one. The only case where prevalence closes a
candidate is when the trace did **not** complete and the count says the project does this deliberately
everywhere: then rule it out citing the count and the sites you read, so the next run inherits it.

This check is also why `prior_art` and prevalence are distinct from the Step-5 guard check: that one asks
*is there a mitigation that neutralises this?*; this one asks *how often does the project do this without
one, and what does that imply about intent?*

## Exploitability bar — vulnerability vs hardening

A finding is a **vulnerability** only if it carries either a complete source→sink path or a concrete
exploitation primitive. A bare **missing control** with no proven path — absent security header, cookie
flag, debug flag, verbose error page — is **not** a vulnerability: emit it as `informational` (hardening)
and keep it out of the vulnerability count. This bar applies to **every** auditor; it is what keeps
`config`/`crypto`/`logging` hygiene observations from inflating the finding total. When in doubt whether a
weakness is exploitable as-is, it is hardening until a path or primitive is shown. The goal is a high
true-positive, low-noise report — not a large count.

## Hybrid mode (optional live correlation)

If `target_url` is set in scope, you MAY corroborate a code finding against the running app (a single
benign witness request, e.g. a quote for SQLi or `{{7*7}}` for SSTI). Live corroboration raises a
`probable` to `high` **only when the response carries a named confirming observable** (an evaluated result,
a DB/parser error, the marker reflected unencoded, a collaborator hit) — a bare 200/302 is not proof;
record the observable with the witness. Absence of live access never lowers a code-derived verdict — the
code trace stands on its own. Never run destructive payloads.

## What every auditor emits

Each auditor writes findings to `outputs/{engagement}/findings/finding-{NNN}/` per
`reference/REPORT_CONTRACT.md` and appends to its activity log `outputs/{engagement}/activity/{agent}.log`
(NDJSON).

It also writes `findings/_safe-{class}.md` carrying **four separate evidence categories** — keep them apart,
because collapsing them is how a report loses the difference between "we checked and it holds", "this is
deliberate", and "we could not tell":

| Category | Means | Needs |
|---|---|---|
| `tested_not_vulnerable` | analyzed, and the invariant holds | the enforcement point, `file:line`, and a **disposition** from the closed enum |
| `design_properties` | intentional behaviour, confirmed as intended | the evidence that it is intended (docs, a comment with a reason, a maintainer statement) |
| `unverified_assumptions` | not decidable from source | **the investigation you performed** *and* the evidence that would settle it |
| `coverage_gaps` | not analyzed, or analyzed without a verdict | why, and the recommended action |

`unverified_assumptions` is the one auditors skip, and it is the most honest field in the report: deployed TLS,
reverse-proxy behaviour, IdP policy, browser specifics, production secrets and runtime config are **not in the
repo**. Naming them explicitly — with what you did try — is coverage information. Silently folding them into
`tested_not_vulnerable` is a false clearance; silently folding them into `coverage_gaps` loses the fact that
you investigated. Empty findings are never proof of complete coverage.

## Reused knowledge base

Three layers, in the order an auditor consumes them:

1. **`reference/ecosystems/*`** — framework defaults, version cutoffs, non-finding lists and `rg` seeds for
   the stack in front of you. Load every file matching the scope (routing table in
   `reference/ecosystems/README.md`); `graphql.md` and `jwt.md` are additive and load alongside the language
   file. This is what makes a verdict *correct for this codebase* rather than correct in general.
2. **`reference/SINK_CATALOG.md` + `reference/SOURCE_TO_SINK.md`** — the language-agnostic sink taxonomy and
   the slot model. These say what a sink *is* and which defense its slot needs.
3. **`plugins/pentest/skills/pentest/attacks/**`** — the pentest plugin's attack catalog, reused for payload
   shapes and bypass context (e.g. `injection/sql-injection/`, `client-side/xss/`, `server-side/ssrf/`).
   Auditors read the relevant quickstart/cheat-sheet for witness payloads and sink awareness — but the
   **verdict** is always derived from the code, not from payload success.

Keep them in their lanes: a stack-specific, version-dependent, verdict-time fact belongs in
`reference/ecosystems/`; generic sink taxonomy belongs in `SINK_CATALOG.md`; payloads belong in the pentest
catalog. When an audit teaches you a new recurring false positive for a stack, add it to that stack's
`## Safe or non-reportable forms` — it is the cheapest false-positive control in the plugin.
