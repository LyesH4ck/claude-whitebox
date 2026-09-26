# Measuring codeaudit-hybride

Public benchmarks do not answer "is Claude + Codex better than Claude alone on *our* pipeline, per
class?". Existing benchmarks measure other things: secure code *generation* (Endor Labs / SusVibes),
exploit *reproduction* (CyberGym), or they do not evaluate both engines (VulnGym, RealVuln). This
protocol answers the question on our own pipeline before any per-class routing decision is made.

## Corpus (ground truth required)

- Intentionally vulnerable apps with published answer keys: OWASP Juice Shop, NodeGoat, WebGoat, DVWA.
- Real advisories: repositories from VulnGym (184 advisories / 23 repos, annotated entry points and
  traces) and RealVuln, checked out at the vulnerable commit.
- The internal 1,133-sink Django codebase already used to tune codeaudit (known criticals).

Keep a `ground-truth.json` per repo: `[{ class, sink_file, sink_line, cwe }]`.

## Configurations (same commit, same classes, same depth)

| id | run |
|---|---|
| A | `/codeaudit:codeaudit` (Claude-only baseline) |
| B | Codex detect only (`findings-codex/` of a hybrid run, before verification) |
| C | hybrid, union without verification (`both + claude_only + codex_only`) |
| D | hybrid, full (after cross-verification + safe-review + adjudication) |

## Metrics (per class and overall)

- recall, precision, F1 and F3 (recall-weighted, as in RealVuln) against ground truth, using the same
  matching rule as `reconcile.mjs` (same file, |Δline| ≤ 3, compatible slot);
- **unique contribution**: true positives found only by Claude / only by Codex;
- verification quality: share of `refuted` verdicts that were right (true negatives removed) vs wrong
  (true positives lost after adjudication);
- safe-review yield: overturns confirmed that are true positives;
- cost: tokens (Claude + Codex, `tokens used` in `codex/exec/*.log` or companion logs), wall-clock.

## Decision rules

- Keep Codex on a class only if D improves that class's F3 over A by a margin worth its cost.
- Consider **routing** a class to one engine only if that engine dominates it on recall *and* precision
  across ≥ 3 repos. Never route by public leaderboard numbers.
- If the cross-verification wrongly removes true positives (after adjudication), tighten the refutation
  bar before widening `codex.classes`.
