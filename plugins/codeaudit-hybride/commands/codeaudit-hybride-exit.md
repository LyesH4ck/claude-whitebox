---
name: codeaudit-hybride-exit
description: Close a codeaudit-hybride session — cancel any running Codex job, optionally delete the Codex threads persisted by the companion transport, mark the scope closed, and lift isolation.
disable-model-invocation: true
allowed-tools:
  - AskUserQuestion
  - Read
  - Write
  - Bash
---

## Step 1 — Locate the session

Read `.codeaudit-hybride-scope.json`. If absent: say there is no active hybrid session, output the
isolation-lifted block (Step 4) and stop. Else take `engagement` and `codex.transport`.

Resolve the bridge:
```bash
HB="${CLAUDE_PLUGIN_ROOT:-}"; [ -f "$HB/scripts/codex-bridge.mjs" ] || HB="plugins/codeaudit-hybride"
[ -f "$HB/scripts/codex-bridge.mjs" ] || HB=$(ls -d ~/.claude/plugins/cache/*/codeaudit-hybride/*/ 2>/dev/null | sort -V | tail -1)
BRIDGE="${HB%/}/scripts/codex-bridge.mjs"
node "$BRIDGE" status --out "outputs/{engagement}"
```

## Step 2 — Codex jobs and persisted threads

If `transport` is `companion` and any job has a thread (the companion persists task threads in
`~/.codex`, i.e. the audited code stays there), ask via AskUserQuestion:

"Delete the Codex threads this audit created from ~/.codex? (Recommended for client code)"
- "Yes — delete them (Recommended)"
- "No — keep them"

Then run (this also cancels every job still queued/running):
```bash
node "$BRIDGE" cleanup --out "outputs/{engagement}" [--delete-threads]
```
Report `cancelled`, `threads_deleted`, and any `threads_delete_failed` (with the error — tell the
operator to delete those manually with `codex delete <id>`). The `exec` transport is `--ephemeral`:
nothing to delete.

## Step 3 — Close the scope

Set `"status": "closed"` in `.codeaudit-hybride-scope.json`. If `outputs/{engagement}/report.md` does not
exist, warn that the run ended without a report (findings remain under `outputs/{engagement}/findings*`).

## Step 4 — Lift isolation

Output verbatim:
```
============================================================
[CODE AUDIT HYBRIDE — ISOLATION LIFTED]
All plugins, agents and skills are available again.
============================================================
```
