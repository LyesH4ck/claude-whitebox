---
name: codeaudit-scope
description: Define or update code-audit scope — saves scope to disk without launching an audit. Can be run before or during an audit. Collects repo path, focus/out-of-scope paths, optional live URL, optional audit depth, and deliverable formats.
disable-model-invocation: true
allowed-tools:
  - AskUserQuestion
  - Read
  - Write
  - Bash
---

Output the following banner verbatim:

```
============================================================
[CODE AUDIT SCOPE DEFINITION]
============================================================
```

## Step 1 — Detect Existing Scope

Try to Read `.codeaudit-scope.json`. If it exists and is valid JSON, store: `existing_repo`,
`existing_engagement`, `existing_focus`, `existing_out_of_scope`, `existing_target_url`,
`existing_depth` (default `"Thorough"`), `existing_output_formats` (default `[]`), and
`existing_status`. Set `has_existing_scope = true`. Otherwise `has_existing_scope = false`.

## Step 2 — Show Existing Scope (if present)

If `has_existing_scope = true`, output:

```
============================================================
EXISTING AUDIT SCOPE FOUND
============================================================
Repository:   {existing_repo}
Engagement:   {existing_engagement}
Focus paths:  {existing_focus}
Out-of-scope: {existing_out_of_scope}
Live URL:     {existing_target_url or "none"}
Depth:        {existing_depth}
Status:       {existing_status}
============================================================
```

If `existing_status` is `"active"`, warn: "An audit appears to be active. Changing the repository now
starts effectively a new audit — consider a new engagement name to keep outputs separate."

## Step 3 — Collect Scope

Ask each free-text field as a plain prompt (NOT AskUserQuestion), one at a time, offering the existing
value as the default when present:

1. "Repository path — absolute path to the source code to audit" → `repo`
2. "Engagement name — used as outputs/{name}/" → `engagement`
3. "Focus paths — directories/files to prioritize, or 'all'" → `focus`
4. "Out-of-scope — paths to exclude, or 'none'" → `out_of_scope`
5. "Live correlation URL — a running instance to optionally corroborate against, or 'none'" → `target_url` (null if 'none')

A code audit runs to completeness (every source→sink path in scope), so there is **no time budget**.
Depth is optional and defaults to `Thorough` (complete). Only if the operator wants a lighter pass, ask
via AskUserQuestion (Quick / Standard / Thorough (default)) → `depth`; otherwise set `depth = "Thorough"`.

Then AskUserQuestion with **multiSelect: true** for deliverable formats (Executive summary / Remediation
plan / CSV findings table / SARIF / PDF render) → `output_formats`.

## Step 4 — Validate & Save

Verify the repo exists: `test -d "{repo}" && echo ok || echo missing`. If missing, warn and ask the user
to re-enter the path (repeat Step 3.1). Note git status: `test -d "{repo}/.git" && echo git || echo no-git`.

Write `.codeaudit-scope.json` with `"status": "pending"` (this command saves scope but does not launch):

```json
{
  "repo": "{repo}",
  "engagement": "{engagement}",
  "focus": "{focus}",
  "out_of_scope": "{out_of_scope}",
  "target_url": {target_url or null},
  "depth": "{depth or "Thorough"}",
  "output_formats": {output_formats array},
  "status": "pending"
}
```

## Step 5 — Confirm

Output:

```
Audit scope saved to .codeaudit-scope.json (status: pending).
Run /codeaudit:codeaudit to launch the audit, or /codeaudit:codeaudit-classes to pick vuln classes first.
```
