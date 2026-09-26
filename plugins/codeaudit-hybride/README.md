# codeaudit-hybride — Claude ⇄ Codex white-box audit

A dual-engine variant of [`codeaudit`](../codeaudit/). It runs the **unchanged** codeaudit pipeline
(Claude: recon → planner → auditors → completeness loop) and adds **Codex** as:

1. a **blind twin detector** on the same scope as each selected Claude auditor (never a share of it);
2. a **cross-verifier** that tries to refute the findings only Claude reported, while a Claude
   `finding-verifier` does the same for findings only Codex reported;
3. a **false-negative hunter** that re-reads Claude's `_safe-*.md` verdicts.

Reconciliation and confidence calibration are **deterministic scripts**, so the result is reproducible
and measurable. See [`skills/hybrid-audit/SKILL.md`](skills/hybrid-audit/SKILL.md) for the rules and
[`docs/BENCHMARK.md`](docs/BENCHMARK.md) for how to measure whether it pays off.

## Requirements

- The **`codeaudit`** plugin (same marketplace). codeaudit-hybride reuses its agents, methodology and
  report contract and never modifies it.
- **Codex CLI** logged in (`codex login`).
- Recommended: OpenAI's **codex-plugin-cc** (background jobs, status, cancel):
  ```
  /plugin marketplace add openai/codex-plugin-cc
  /plugin install codex@openai-codex
  /codex:setup
  ```
  Without it, the bridge falls back to `codex exec --output-schema` (the operator is asked first).
- Node.js ≥ 18.18.

## Use

```
/codeaudit-hybride:codeaudit-hybride        # launch (guided scope → plan → dual audit → report)
/codeaudit-hybride:codeaudit-hybride-exit   # cancel Codex jobs, delete persisted Codex threads, lift isolation
```

Scope lives in `.codeaudit-hybride-scope.json`. An existing `.codeaudit-scope.json` can be imported
(read-only). The launch explicitly asks whether **sending the audited code to OpenAI is authorized** for
the engagement. The answer "No" stops the run and points to `/codeaudit:codeaudit`.

## Layout

```
agents/codex-auditor.md        forwarder: one Codex job via the bridge, parseable STATUS (reads no code)
agents/finding-verifier.md     Claude adversarial verifier (cited refutations only)
commands/codeaudit-hybride.md  orchestration = codeaudit's steps + hybrid deltas
scripts/codex-bridge.mjs       the only door to Codex: preflight/start/wait/collect/repair/cancel/cleanup
scripts/reconcile.mjs          match / safe-input / overturn-input / finalize (deterministic)
prompts/*.md                   detect, verify, safe-review, repair templates
schemas/*.json                 Codex output contracts (also enforced by --output-schema in exec mode)
tests/*.test.mjs               node --test plugins/codeaudit-hybride/tests/*.test.mjs
```

Engagement output adds `findings-codex/`, `codex/` (jobs ledger, prompts, raw answers, results) and
`hybrid/` (claude-index, reconciliation, verify inputs/outputs, calibration, adjudication) next to
codeaudit's usual tree. The deliverables keep codeaudit's schema (`codeaudit-report.json` + `report.md`)
with additive `detected_by` / `agreement` / `verification` fields and a top-level `hybrid` block.

## Safety

- Codex is **always read-only**: the bridge never passes `--write`, and `exec` runs with
  `-s read-only --ephemeral`.
- The companion's job state is pinned inside the engagement directory (`codex/companion-data/`). Its
  task threads persist in `~/.codex` until `/codeaudit-hybride:codeaudit-hybride-exit` deletes them.
- Disable codex-plugin-cc's stop-review-gate during audits. Preflight warns if it is enabled.

## Authorized use only

For code you own or are explicitly authorized to assess, including authorization to process it with
OpenAI in addition to Anthropic.
