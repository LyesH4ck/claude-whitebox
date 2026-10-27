---
name: codeaudit-diff
description: Incremental white-box audit of a change — the files a diff touched plus one import hop — reusing the repository's existing baseline (recon, threat model, context file, previous report) and reporting only what the change introduced. For a pull request, a branch, or uncommitted work; a full engagement is /codeaudit:codeaudit.
disable-model-invocation: true
allowed-tools:
  - AskUserQuestion
  - Read
  - Write
  - Task
  - TaskOutput
  - SendMessage
  - Bash
  - Glob
  - Grep
---

Output the following banner verbatim:

```
============================================================
[CODE AUDIT — DIFF MODE]
============================================================
```

A full engagement runs to completeness over the whole repository. This command runs to completeness over
**a change**: the source files a diff touched, plus the files that import them (where a changed helper
becomes reachable) and the files they import (what a changed handler now reaches). It reuses the
repository's standing baseline where one exists, verifies every finding, and reports **net-new** findings by
fingerprint against the previous report — so a reviewer sees what this change introduced, not the backlog.

## Step 1 — What changed

Ask, via AskUserQuestion: **"What should the audit cover?"**
- **Diff to a base ref** — then a plain prompt: "Base ref (e.g. `origin/main`)" → `ref`
- **Uncommitted changes** — working tree + untracked files → `--working`
- **Staged changes** — index vs HEAD → `--staged`
- **An explicit file list** — then a plain prompt for comma-separated paths → `--files`

Resolve `repo` (the git work tree of the current directory: `git rev-parse --show-toplevel`, or ask) and
`out_of_scope` (reuse `.codeaudit-scope.json` when present, else ask with 'none' as the default). Then:

```bash
CA="${CLAUDE_PLUGIN_ROOT:-}"; [ -f "$CA/preflight.mjs" ] || CA="$(ls -d ~/.claude/plugins/cache/*/codeaudit/*/ 2>/dev/null | sort -V | tail -1)"; CA="${CA%/}"; [ -f "$CA/preflight.mjs" ] || CA="plugins/codeaudit"
node "$CA/preflight.mjs" --repo "{repo}"                      # exit 2 = stop, as in a full engagement
python3 -I "$CA/tools/diff-scope.py" --repo "{repo}" {--ref {ref} | --working | --staged | --files a,b} \
        --out-of-scope "{out_of_scope}" --write "outputs/{engagement}/plan/_diff-scope.json"
```

`engagement` is `diff-<short-sha-or-'working'>-<YYYYMMDD>`. The tool writes `plan/_diff-scope.json` — the
changed files, their importers, their imports, and the union as `scope_files` / `scope_dirs` — and prints
it. Exit `1` means no in-scope source file changed: say so and stop. Echo the scope to the operator: changed
count, hop count, the directories.

## Step 2 — The standing baseline

Look for what the repository already has, in this order, and say what you found:
- **`{repo}/.codeaudit-context.md`** — read it; pass it to every agent below (`reference/PROJECT_CONTEXT.md`).
- **The most recent full engagement** of this repo under `outputs/*/`: one whose `codeaudit-report.json`
  has `repo == {repo}`, taken by `date`. From it reuse `recon/sink-inventory.json`, `recon/architecture.md`,
  `recon/threat-model.json` (when present) and the report itself as `previous_report`. Copy nothing;
  reference the paths.
- **`{repo}/.codeaudit-accepted.json`** as `accepted_file` when present.

**When there is no previous engagement**, dispatch the **code-recon** agent via `Task` on `scope_dirs` only
(`focus` = the directories from `_diff-scope.json`, `classes` = all seventeen), then run
`tools/recon-coverage.py` with `--out-of-scope` set to everything **outside** `scope_dirs` — the gate must
not fail on the rest of the repo. Skip the threat-modeler: a model built from a slice is worse than none,
and the context file carries the operator's intent. Note `threat_model: none (diff mode without a prior
engagement)` for every brief.

**When the previous baseline is older than the change** (its commit is an ancestor of HEAD — it always is in
a PR), it may name routes that no longer exist and miss ones the change added. That is acceptable for a
diff: the auditors are scoped to `scope_files` and trace the code as it is now; the baseline is context,
not a filter. Say so in the report's `coverage_gaps` when the changed set adds a new route family.

## Step 3 — Audit the slice

Invoke the **audit-planner** via `Task` with the baseline paths and this brief: "Scope is `scope_files`
from `plan/_diff-scope.json` — plan auditors for every class whose sinks, surfaces or seeds touch those
files; record under `skipped` every class with no surface **in the slice** (not in the repo). One wave;
shard nothing." Validate the plan as in a full engagement; an empty plan is valid only when every class is
`skipped` with a reason.

Dispatch every planned auditor in one parallel `Task` message, with the Step 6.4 brief of
`/codeaudit:codeaudit` plus two lines: **"Your scope is the file list in `plan/_diff-scope.json`: trace every
source→sink path that starts, passes through, or ends in one of those files — reading outside the list is
expected, filing outside it is not"** and **"a path that exists unchanged outside the slice is not this
audit's finding; note it under `coverage_gaps` as pre-existing if you meet one."** Run the completeness
loop of Step 6.5 over the slice (skipped registers included), then `tools/reconcile.py` restricted to the
slice's sources. Skip the adversarial sweep — its job is the plan's blind spot over a whole repository.

Then Step 6.5c on **every** finding (a diff set is small): dispatch the **finding-verifier** via `Task` in
batches of six, with the context file and the threat model when one exists. Spot-check every refutation.

## Step 4 — Report what the change introduced

```bash
python3 -I "$CA/tools/aggregate.py" "outputs/{engagement}" --write --meta outputs/{engagement}/plan/_meta.json \
        --relations outputs/{engagement}/plan/_relations.json --verified-min low \
        {--previous "{previous_report}" when a previous engagement exists} {--accepted "{accepted_file}" when present}
python3 -I "$CA/tools/render.py" "outputs/{engagement}" --pr-comment
```

With `--previous`, every finding is `new` or `persisting` by fingerprint and `pr-comment.md` lists only the
**new** ones (accepted risks and refuted findings never appear); without one, it lists every open finding
and says so. `render.py` writes the comment only when there is something to say — a green run leaves no
`pr-comment.md`, which is the signal a CI step can key on. `_meta.json` carries `mode: "diff"`, the `ref`,
and `scope: { code_paths: <scope_files count>, diff_scope: "plan/_diff-scope.json" }`.

Tell the operator, in this order: the verdict line (**N new finding(s) introduced by this change** /
**no new findings** — with persisting and refuted counts), the path of `pr-comment.md` when written, and the
path of `report.md`. Then run Step 6.7 of `/codeaudit:codeaudit` (carry forward into the context file) — a
diff that established a design property or a version-gated rule-out should not have to establish it again.

## What this command does not do

It does not replace the full engagement: a change can only be judged against a baseline, and the baseline
is what `/codeaudit:codeaudit` builds. It does not post to GitHub — `pr-comment.md` is a file; a workflow
posts it from a job that runs no PR code (the two-job pattern: analyse without write, comment without
code). And it never widens its own scope: a finding whose path lies entirely outside `scope_files` is a
coverage note for the next full engagement, not a result of this one.
