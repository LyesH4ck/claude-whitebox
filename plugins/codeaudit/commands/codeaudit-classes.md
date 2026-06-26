---
name: codeaudit-classes
description: Define or update the vulnerability class profile for a code audit — saves the selected classes to disk without launching an audit. Lets the operator scope the audit to specific OWASP domains.
disable-model-invocation: true
allowed-tools:
  - AskUserQuestion
  - Read
  - Write
---

Output the following banner verbatim:

```
============================================================
[CODE AUDIT CLASS PROFILE]
============================================================
```

## Step 1 — Detect Existing Profile

Try to Read `.codeaudit-classes.json`. If it exists and is valid JSON, store `existing_classes` and
`existing_status`, set `has_existing = true`, and output:

```
============================================================
EXISTING CLASS PROFILE FOUND
============================================================
Classes: {comma-separated existing_classes}
Status:  {existing_status}
============================================================
```

Otherwise `has_existing = false`.

## Step 2 — Select Classes

Use AskUserQuestion with **multiSelect: true**:

"Which vulnerability classes should the audit cover? (Select all that apply — leaving all unselected
defaults to all ten.)"

Present exactly these options (multi-select):
- "Injection — SQLi, NoSQLi, command, LFI/RFI, SSTI, XXE, path traversal, deserialization"
- "XSS — reflected, stored, DOM, framework escape hatches"
- "Auth — password storage, sessions, JWT, reset flows, MFA, enumeration"
- "Access control — function-level authz, IDOR, privilege escalation, mass assignment"
- "SSRF — outbound requests, webhooks, URL-import"
- "Secrets — hardcoded credentials, keys, tokens"
- "Crypto — weak algorithms, RNG, TLS verification, password hashing"
- "Dependencies — vulnerable & outdated components (SCA)"
- "Configuration — headers, CORS, cookies, debug mode, defaults"
- "Logging — sensitive data in logs/telemetry/error responses, missing audit logging, log injection (A09)"

Map the selected labels to these class keys: `injection`, `xss`, `auth`, `access-control`, `ssrf`,
`secrets`, `crypto`, `deps`, `config`, `logging`. If none selected, set all ten. Store as `classes`.

## Step 3 — Save

Write `.codeaudit-classes.json` with `"status": "pending"`:

```json
{
  "classes": {classes array},
  "status": "pending"
}
```

## Step 4 — Confirm

Output:

```
Class profile saved to .codeaudit-classes.json (status: pending): {comma-separated classes}.
Run /codeaudit:codeaudit to launch the audit.
```
