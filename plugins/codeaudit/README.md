# codeaudit — White-Box Source Code Security Audit

A Claude Code plugin that audits **source code** for security vulnerabilities through static
source-to-sink analysis, with optional live correlation. It is the white-box counterpart to the
`pentest` plugin: same orchestration model (the command owns dispatch, agents are single-purpose,
nesting is one level deep), but the target is a code repository instead of a live host.

The methodology is adapted from the Shannon white-box pipeline (architectural baseline → per-class
source-to-sink analysis → structured findings) and re-expressed as native Claude Code commands, agents,
and skills.

## Install

This plugin lives in the `claude-whitebox` marketplace alongside `pentest`. After adding the marketplace,
install `codeaudit`.

## Use

```
/codeaudit:codeaudit          # launch an audit (guided scope → plan → audit → report)
/codeaudit:codeaudit-scope    # pre-configure repo/scope without launching
/codeaudit:codeaudit-classes  # pre-configure which vuln classes to cover
/codeaudit:codeaudit-exit     # close the session, flush findings, lift isolation
```

You provide a **repository path** (and optionally a running URL for hybrid corroboration) and which of
the 10 vulnerability classes to cover. There is no time budget — the audit is bounded and runs until every
source→sink path in scope is analyzed, then stops (depth is an optional knob, default complete). It
produces
`outputs/{engagement}/report.md` + `codeaudit-report.json`, with per-finding detail (source→sink trace,
code snippet, remediation) under `outputs/{engagement}/findings/`.

## What it covers

Injection · XSS · Authentication · Access control (authz/IDOR/mass-assignment) · SSRF · Secrets ·
Cryptography · Vulnerable dependencies (SCA) · Security configuration. (OWASP A01–A10.)

## How it works

See [`docs/WORKFLOWS.md`](docs/WORKFLOWS.md) for the pipeline, and
[`skills/code-audit/`](skills/code-audit/) for the methodology:
- `SKILL.md` — the verdict process, confidence scoring, false-positive discipline
- `reference/SOURCE_TO_SINK.md` — slot taxonomy and defense matching
- `reference/SINK_CATALOG.md` — grep-able dangerous sinks by language
- `reference/REPORT_CONTRACT.md` — fixed deliverable schema & severity rubric
- `reference/OUTPUT_STRUCTURE.md` — working layout & per-finding format

## Authorized use only

For auditing code you own or are explicitly authorized to assess. Static analysis is read-only; hybrid
corroboration sends only benign, non-destructive witness requests to a target you have authorized.
