# Project Context — `.codeaudit-context.md`

A short, operator-owned statement of what a repository is, who it trusts, and what has already been decided
about it. It lives at the **root of the audited repository**, is committed, and survives engagements — the
threat model lives in one `outputs/{engagement}/` and dies with it; this file is what the *next* audit starts
from. Fifty to one hundred and twenty lines. Written once by the threat-modeler when it is absent, edited by
the operator, grown at the end of every run from what the run established.

It is the cheapest false-positive control the plugin has: a re-audit that re-derives "the admin router is
intentionally unauthenticated behind the VPN" has spent an agent on a question the operator answered a
quarter ago, and may answer it differently.

## Format (the headings are a contract)

```markdown
# Audit context — {project name}
<!-- codeaudit-context v1 — operator-owned. Agents propose additions; only the operator merges them. -->

## What this codebase does
One paragraph: what it is, who calls it, what it protects. No architecture tour.

## Auth shape
3–5 bullets naming the real primitives by their public names — the session middleware, the authz guard,
the token verifier, the role model. No line numbers (they rot); names and files are enough.

## Trust boundaries and adversaries
3–5 bullets: which inputs are attacker-controlled and which are operator-controlled, which components are
outside the trust boundary, which adversary is explicitly out of scope (and why).

## Project-specific patterns to flag
3–5 bullets: the internal helpers, wrappers and conventions a generic auditor would not know to look at —
the custom query builder, the hand-rolled signature check, the "internal" header the gateway strips.

## Known non-findings
- [by_design] {what} — {why it is intended} ({evidence: doc, comment, decision})
- [accepted-risk] {what} — {why accepted} ({who, when, tracker})
- [version-gated] {pattern} — safe at {package version} (lockfile pin); re-verify on upgrade
```

## Rules

- **Operator-owned.** The threat-modeler **seeds** the file when it is missing (Step 6.2b), stamping a
  `<!-- seeded by codeaudit threat-modeler on {date}; review before relying on it -->` line under the
  header. Nothing else writes to it unprompted: at the end of a run the orchestrator **proposes** additions
  (`tools/context.py propose`) and merges them only after the operator approves (Step 6.7).
- **Budget.** 40–120 lines, 10 000 characters. Verbose context dilutes every prompt it is injected into; the
  test for a line is "what would an auditor get wrong without it?", not completeness.
- **Names, not line numbers.** Line numbers rot between engagements; public names (`requireUser`,
  `TenantScopedRepo`, `X-Internal-Auth`) do not.
- **What it is to an auditor.** Operator statements are **`documented` provenance** — the threat-modeler lifts
  them into the model with `source: ".codeaudit-context.md:<line>"`. A *Known non-findings* line is a
  `by_design` / `accepted-risk` / `version-gated` **hypothesis**: an auditor cites it in a rule-out only
  after re-verifying that the current code still matches it (the guard still exists, the pin is still below
  the cutoff). A stale rationale whose guard has since been removed does not rule anything out — and the
  auditor says so, which is how the file gets corrected.
- **What never goes in.** Findings, severities, remediation, secrets, absolute paths, generic CWE boilerplate
  the built-in references already cover.
- **Who reads it.** `code-recon` (orient), `threat-modeler` (first, as the highest-authority written source
  after `SECURITY.md`), every class auditor and the `finding-verifier` (path in the brief). **Not** the
  `blind-dig` adversarial sweep — its isolation is the method, and this file encodes prior decisions.
- **Validation.** `preflight.mjs --repo <repo>` warns when the file exists but is missing a heading, exceeds
  the budget, or still carries seed placeholders. `tools/context.py check <file>` does the same from the shell.

## `tools/context.py`

```sh
python3 -I "$CA/tools/context.py" check   <repo>/.codeaudit-context.md
python3 -I "$CA/tools/context.py" propose outputs/<engagement> --context <repo>/.codeaudit-context.md   # → plan/_context-additions.md
python3 -I "$CA/tools/context.py" apply   outputs/<engagement> --context <repo>/.codeaudit-context.md   # appends the approved additions
```

`propose` reads `codeaudit-report.json` and turns three things into *Known non-findings* candidates, skipping
any already present: every `design_properties` entry, every `accepted-risk` finding (with its reason), and every
`tested_not_vulnerable` entry whose disposition is `by_design` or whose detail cites a lockfile pin. `apply`
appends them under the section, idempotently, and never touches the other sections.
