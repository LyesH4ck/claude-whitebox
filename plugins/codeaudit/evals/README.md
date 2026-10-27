# codeaudit evals — measuring recall and precision instead of guessing

Every change to this plugin's rules is a bet: it should raise recall (catch a bug that was being missed)
without costing precision (report something that is not a bug). Nothing here measured that, so each change
was argued rather than tested. These fixtures are the instrument.

## The shape of an eval

A **fixture** is a tiny repository with a **known planted bug** and — just as importantly — a **known safe
sibling** next to it: the same kind of code, correctly defended. A scenario that only plants a bug measures
recall and rewards a run that reports everything. The safe sibling is what makes the measurement two-sided,
and `judge.test.mjs` enforces that every scenario has one.

A **scenario** (`scenarios/*.eval.json`) states what the fixture plants and what a report about it must and
must not say.

```jsonc
{
  "name": "csrf-state-changing-get",          // must equal the filename
  "given": "one line: what this fixture plants",
  "fixture": "fixtures/csrf-state-changing-get",
  "classes": ["access-control"],              // which classes to select when running the audit
  "rationale": "which audit error this catches, and why the naive read gets it wrong",

  "should_find":    [ { "cwe": "CWE-352", "path": "server.js",
                        "evidence_contains": ["/api/email", "samesite"], "required": true } ],
  "should_not_find":[ { "path": "server.js", "evidence_contains": ["display-name"] } ],
  "should_rule_out":[ { "disposition": "guard_present", "evidence_contains": ["nosniff"],
                        "required": false } ],
  "must_not_contain": ["django", "flask"]
}
```

| Assertion | Satisfied when | Failure means |
|---|---|---|
| `should_find` | ≥ 1 finding matches every stated criterion | **false negative** — the bug was missed |
| `should_not_find` | **no** finding matches | **false positive** — a safe case was reported |
| `should_rule_out` | a `tested_not_vulnerable` entry matches | the safe case was never *recorded as checked* |
| `must_not_contain` | the term appears nowhere in the report | **hallucination** — something not in the fixture |

**Positive and negative assertions match against different text, on purpose.** `should_find` and
`should_rule_out` search the full narrative — every finding field plus its `description.md`.
`should_not_find` searches only the finding's **identity**: title, class, CWE, slot, source, sink, location.
A negative asks *"was a finding filed against the safe sibling?"*, which is a question about what was
reported — not about what the write-up discusses. The plugin's own rules **require** contrastive reasoning
(`prior_art` must say why the version-fixed pattern is not a finding), so a correct report names the safe
sibling while filing nothing against it. Searching the narrative for a negative scored that discipline as a
false positive and punished the audit for explaining itself.

**Negative terms are linted.** `loadScenario` rejects a `should_not_find` / `must_not_contain` term that is
under 4 characters, or that is a report-contract enum value present in nearly every finding
(`none`, `high`, `admin`, `query`, `open`, …). Both shipped in a committed scenario and silently inverted it:
`"alg"` matches the word *algorithms*, and `"none"` is the `privilege_required` value of every
unauthenticated finding. Pick a term that can **only** appear if the thing you are forbidding happened —
the safe function's own name is usually the right one.

**Do not ban a term the plugin's rules require.** `must_not_contain: ["CVE-2022-23540"]` looked like a
hallucination guard and was really a trap: the version rule *orders* the auditor to name the cutoff it
compared against. Reserve `must_not_contain` for things that cannot legitimately appear — another
ecosystem's library, a framework absent from the fixture.

`should_rule_out` is the assertion scrutineer's harness does not have, and it exists because of this
plugin's own evidence contract: *absent from the report* and *checked and ruled out* are different outcomes,
and only the second one proves coverage. Mark it `"required": false` while a fixture is young — a run that
reports neither the bug nor the rule-out is still failing on `should_find`.

Criteria are **a minimum bar**, not an exact-match list: extra findings never fail a scenario unless they
match `should_not_find` or `must_not_contain`. That keeps evals stable as the plugin legitimately improves.
Unspecified criteria are not constraints. Available keys: `vuln_class`, `cwe`, `slot_type`,
`privilege_required`, `path` (suffix or substring), `title_contains`, `min_severity`, `evidence_contains`.

**Write specific evidence terms.** `evidence_contains` is a case-insensitive substring match over every
narrative field plus the finding's `description.md`. A bare number is a bad term — `9` matches a line number
or a CVSS score. `9.0.2` or `samesite` is a good one.

## Running

The judge is **deterministic and never runs an audit**. Run the audit yourself, then judge its report:

```sh
# 1. audit a fixture (the slow, model-backed half — you drive this)
/codeaudit:codeaudit        # repo: plugins/codeaudit/evals/fixtures/<name>, classes: the scenario's "classes"

# 2. judge the report it produced (fast, free, repeatable)
node plugins/codeaudit/evals/judge.mjs \
  --scenario plugins/codeaudit/evals/scenarios/<name>.eval.json \
  --report   outputs/<engagement>/codeaudit-report.json
```

`--findings-dir` defaults to `findings/` beside the report, so `description.md` bodies are searched for
evidence terms automatically. `--json` emits the machine-readable verdict. Exit code: `0` pass, `1` at least
one assertion failed, `2` harness error.

CI runs `judge.test.mjs`, which pins the judge's semantics and validates every committed scenario and
fixture. It costs no tokens. The model-backed half is deliberately manual: an audit run is expensive and
non-deterministic, and pretending otherwise in CI would produce a flaky gate nobody trusts.

## Why JSON and not YAML

This repo's test harness is zero-dependency `node --test`, and Node has no built-in YAML parser. A
hand-rolled one would be a bug farm sitting underneath the thing that is supposed to catch bugs. JSON is
uglier and unambiguous; the `rationale` field carries the prose that YAML comments would have.

## Adding a fixture

1. `fixtures/<name>/` — the smallest tree that makes the bug real, plus the safe sibling. Keep it under a
   few hundred lines; an eval that takes twenty minutes to audit will not be run.
2. `fixtures/<name>/README.md` — **required**, and it must read like a **real project's** README: what the
   service does, how to call it. Nothing about bugs.
3. `answers/<name>.md` — **required**, and it is where the planted true positive and safe sibling are
   named. **Keep the answer key out of the fixture tree.** Inside it, both halves of the measurement are
   void: `should_find` passes because the README names the bug, and `should_not_find` passes because a
   `// SAFE:` comment is exactly what the report contract accepts as a `by_design` rule-out — and the
   `threat-modeler` is explicitly instructed to read `README*` first, so the leak is guaranteed rather than
   incidental. `judge.test.mjs` greps the fixture for `VULNERABLE` / `SAFE:` / `planted` and fails on a hit.
4. `scenarios/<name>.eval.json` — assertions plus a `rationale` naming the audit error it catches.
5. `node --test plugins/codeaudit/evals/judge.test.mjs` — the contract guards check all of the above.

Make the safe sibling genuinely tempting. The useful fixtures are the ones where the naive read gets it
wrong: a strict upload filter that still serves SVG inline, a missing `algorithms` option that is harmless on
the pinned version, a `require()` whose precondition already grants the effect.

## Current fixtures

| Fixture | Plants | Catches |
|---|---|---|
| `csrf-state-changing-get` | state-changing GET under `SameSite=Lax`; sibling POST with Origin + token | finding a SameSite cookie and stopping — Lax still sends on GET navigation |
| `upload-svg-inline` | `.svg` served inline from the app origin; sibling served `attachment` + `nosniff` | judging an upload at the filter instead of at the serving response |
| `jwt-version-gate` | `jwt.decode()` claims deciding a role; sibling `verify()` without `algorithms` on 9.0.2 | reporting the version-fixed pattern, missing the one no upgrade fixes |
| `circular-precondition` | `require()` from a request param; sibling from an operator-owned plugin dir | filing a circular finding whose precondition already grants the effect |
