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
variants) are caught instead of missed.

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
utilities never wired to a route. Report internal-only flaws as informational, not as primary findings.

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
  `v-html`, `| safe`, `mark_safe`, `bypassSecurityTrust*`) is used on the tainted value.

When uncertain whether input is reachable or a helper sanitizes correctly, **downgrade confidence**
rather than dropping or over-claiming. Record the assumption in `notes`.

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
`probable` to `high` and can attach a runtime evidence snippet. Absence of live access never lowers a
code-derived verdict — the code trace stands on its own. Never run destructive payloads.

## What every auditor emits

Each auditor writes findings to `outputs/{engagement}/findings/finding-{NNN}/` per
`reference/REPORT_CONTRACT.md` and appends to its activity log
`outputs/{engagement}/activity/{agent}.log` (NDJSON). It also records **negative results**
(vectors analyzed and confirmed safe) so coverage is provable and re-testing is avoided.

## Reused knowledge base

The `pentest` plugin's attack catalog is reused for payload shapes, sink lists, and bypass context:
`plugins/pentest/skills/pentest/attacks/**` (e.g. `injection/sql-injection/`, `client-side/xss/`,
`server-side/ssrf/`). Auditors read the relevant quickstart/cheat-sheet for witness payloads and
sink awareness — but the **verdict** is always derived from the code, not from payload success.
