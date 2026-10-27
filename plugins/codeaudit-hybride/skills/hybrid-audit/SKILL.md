---
name: hybrid-audit
description: Dual-engine (Claude + Codex) white-box audit rules for codeaudit-hybride — role split, blind parallel detection, deterministic reconciliation, cross-verification, confidence calibration, and the additive report-contract fields. Read by the /codeaudit-hybride:codeaudit-hybride orchestrator. The per-path verdict methodology itself is codeaudit's code-audit skill, unchanged.
---

# Hybrid Audit (Claude + Codex)

`codeaudit-hybride` runs the **unchanged** `codeaudit` pipeline (recon → planner → auditors →
completeness loop) and layers a second engine on top. It does not fork codeaudit's agents or its
methodology: Codex receives the *same* `SKILL.md`, `SOURCE_TO_SINK.md` and class rules as Claude's
auditor, inlined into its prompt by `codex-bridge.mjs`.

## Why this shape (evidence, not taste)

- No public benchmark ranks Claude vs Codex **per vulnerability class** for white-box detection, so a
  class-routing split ("injection → Codex") would be a guess.
- What the literature does support: models of similar strength catch **different subsets** of bugs
  (union ↑ recall, ↓ precision), and an independent second pass that **tries to refute** recovers the
  precision.
- codeaudit's own history: splitting sinks between agents (0.1.9 `owned_sinks`) **lowered** recall.
  So Codex never gets a *share* of the scope — it gets the **same** scope, blind.

Hence: **split roles, not scope.**

| Stage | Claude | Codex |
|---|---|---|
| recon, planning | `codeaudit:code-recon`, `codeaudit:audit-planner` | — |
| detection | `codeaudit:*-auditor` (all selected classes) | blind twin on the `codex.classes` subset, same scope/shard |
| reconciliation | extracts `hybrid/claude-index.json` | — (`reconcile.mjs match`, deterministic) |
| verification | `finding-verifier` on Codex-only findings + safe overturns | refutes Claude-only findings (`verify`) |
| FN hunting | — | re-reads Claude's `_safe-*.md` (`safe-review`) |
| adjudication, report | orchestrator | — |

## Independence rules (blindness)

- A Codex detection job never sees Claude's results, and vice versa: separate trees
  (`findings/` vs `findings-codex/`), the Codex prompt forbids reading `outputs/`, and the
  `codex-auditor` forwarder never reads code or findings.
- Verifiers are not told which engine produced a finding (`reconcile.mjs` strips it).
- Codex is **always read-only** (`task` without `--write` / `exec -s read-only`). Nothing in this plugin
  may pass `--write`.

## Reconciliation (deterministic — `reconcile.mjs match`)

Pair a Claude finding with a Codex finding when: same class **family** (`xss`≈`client-side`,
`access-control`≈`data-lifecycle`), same normalized sink file, `|Δ sink line| ≤ tolerance` (default 3),
and compatible slot families (`SQL-*` never pairs with `CMD-*`). Score = Δline (+2 if slot labels differ
within the family, +1 if source lines differ); greedy one-to-one on the lowest score. Unpaired findings
become `claude_only` / `codex_only`; Claude findings of classes Codex did not run are `single_engine`.

## Calibration (deterministic — `reconcile.mjs finalize`)

A refutation counts only **with a code citation** (`sanitizer_file:line`); without one it is `uncertain`.

| Situation | agreement | confidence | action |
|---|---|---|---|
| detected by both | `both` | max of the pair | keep (Claude id canonical, Codex id merged) |
| one engine + other **confirmed** | `cross-verified` | detector's | keep |
| Claude-only + Codex uncertain/missing | `single` | Claude's (it passed codeaudit's bar) | keep |
| Codex-only + Claude uncertain/missing | `single` | capped at `probable` | keep |
| one engine + other **refuted with citation** | `disputed` | capped at `probable` | **adjudicate** |
| class not run by Codex | `claude-engine-only` | Claude's | keep |
| safe verdict overturned by Codex + Claude confirmed | `safe-overturned` | Codex's | keep (new finding) |
| overturn refuted by Claude (cited) | `overturn-rejected` | — | record as disputed-safe (appendix) |
| overturn unverified | `overturn-unverified` | — | `coverage_gaps` |

**Adjudication** (orchestrator, per `adjudicate` row): open the cited sanitizer line and apply codeaudit's
guard rules (same variable? correct for the slot? not nullified later?). If the refutation holds → move
the finding to `tested_not_vulnerable` with `"refuted by <engine> at <file:line>, adjudicated"`.
Otherwise keep it as `disputed`, confidence `probable`, and quote both arguments in its description.
**Never drop a finding silently.**

## Failure handling

- A Codex job that errors/times out is **not** a class coverage gap (Claude covered the class) — record it
  under `coverage_gaps` as `"second-engine gap: codex <mode> for <class> did not complete"`, and mark the
  class's Claude findings `claude-engine-only` for that scope.
- Codex unavailable at preflight → ask the operator (continue Claude-only / abort). Never degrade silently.

## Report contract — additive fields

Deliverables are codeaudit's (`codeaudit-report.json` + `report.md`, same schema, so the pentest handoff
keeps working) plus these **additive** fields:

- per finding: `detected_by` (`["claude"]`, `["codex"]`, `["claude","codex"]`), `agreement` (table
  above), `verification` (`{by, verdict, citation, argument}` or `null`), `merged_ids` (Codex ids merged
  into a `both` finding), `overturns` (safe ref, for `safe-overturned`).
- top level `hybrid`: `{ codex_model, codex_effort, transport, dual_classes, stats (from
  calibration.json), codex_jobs: {collected, errored}, disputed_safe: [...] }`.
- `report.md` gains a **Hybrid analysis** section: agreement table, the Codex-unique findings kept, the
  disputed items with both arguments, and the second-engine gaps.

**`privilege_required` on Codex-only findings.** codeaudit's contract requires `privilege_required` on every
finding and uses it to cap severity, so a `codex_only` finding cannot enter `codeaudit-report.json` without
one. `codex-detect.schema.json` accepts it (optional, same closed enum) — when Codex supplies it, carry it
across unchanged; when it does not, the **orchestrator derives it at adjudication** from the finding's own
trace, exactly as it already adjudicates a disputed sanitizer citation. Do not default it to `none`: `none`
is the least-constrained value and the one that permits `critical`, so guessing it inflates severity on
precisely the findings that had the weakest provenance. If the trace does not establish the principal, keep
the finding and record the unresolved privilege in `coverage_gaps`.

Apply the severity caps **after** calibration, not before: calibration decides the confidence and the
agreement class, the caps then bound the severity. A Codex-only finding is already capped at `probable`
confidence; the privilege cap is independent of that and applies on top.
