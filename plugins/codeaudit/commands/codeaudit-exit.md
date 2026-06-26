---
name: codeaudit-exit
description: Close code-audit session — summarizes findings, ensures outputs are saved, lifts isolation, resets scope/class profile to pending, and prompts for /clear
disable-model-invocation: true
allowed-tools:
  - AskUserQuestion
  - Read
  - Write
---

Output the following closing banner verbatim:

```
============================================================
[CODE AUDIT SESSION CLOSING]
============================================================
```

## Step 1 — Identify Engagement

Use AskUserQuestion to ask:

"What is the engagement name for this session? (the name used in outputs/{name}/ — check your audit
summary or activity logs)"

Store the answer as {engagement_name}.

## Step 2 — Findings Review

You MUST complete this step before the summary. Do not skip it even if the folder appears empty.

Read all files matching `outputs/{engagement_name}/findings/finding-*/description.md`, and
`outputs/{engagement_name}/codeaudit-report.json` if it exists. If nothing is found, record
"No findings documented in outputs/{engagement_name}/".

From the files: count findings by severity (Critical, High, Medium, Low, Info) and note each title.

## Step 3 — Notes Flush

You MUST complete this step before the summary. Check whether any findings or notes exist in the current
conversation context but are NOT yet written to disk (a drafted finding without a `description.md`,
analysis discussed but unsaved, activity not appended). If so, write it now:
- Findings → `outputs/{engagement_name}/findings/finding-{NNN}/description.md` (next sequential number)
- Activity → `outputs/{engagement_name}/activity/`
- Report (if complete) → `outputs/{engagement_name}/codeaudit-report.json`

If nothing is pending, continue.

## Step 4 — Session Summary

Output:

```
============================================================
AUDIT SUMMARY — {engagement_name}
============================================================
Repository:   {repo_from_report_or_logs}
Findings:     Critical: N | High: N | Medium: N | Low: N | Info: N
Top findings: [up to 3 highest-severity findings, one line each, with file:line]
Outputs:      outputs/{engagement_name}/
============================================================
```

If `codeaudit-report.json` was found, use its data; otherwise use the findings files; if nothing was
found, set counts to 0, repo to "unknown", note "No findings documented."

## Step 5 — Isolation Lift

Output verbatim:

```
============================================================
[CODE AUDIT MODE — ISOLATION LIFTED]

The code-audit session isolation constraint is now removed.
You may use agents and skills from all plugins again.
Normal operating mode restored.
============================================================
```

## Step 6 — Scope and Classes Reset

Try to Read `.codeaudit-scope.json`. If it exists, write it back with `"status": "pending"` and all other
fields unchanged, so a future `/codeaudit:codeaudit` asks whether to reuse it rather than assuming it is
live.

Try to Read `.codeaudit-classes.json`. If it exists, write it back with `"status": "pending"` and all
other fields unchanged.

## Step 7 — Close Message

Output:

```
Code audit session closed. Audit outputs remain in outputs/{engagement_name}/.

Run /clear to fully reset the context window before starting a new audit or switching tasks.
```
