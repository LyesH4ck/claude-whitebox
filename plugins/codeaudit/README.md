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
the 17 vulnerability classes to cover. There is no time budget — the audit is bounded and runs until every
source→sink path in scope is analyzed, then stops (depth is an optional knob, default complete). It
produces
`outputs/{engagement}/report.md` + `codeaudit-report.json`, with per-finding detail (source→sink trace,
code snippet, remediation) under `outputs/{engagement}/findings/`.

## What it covers

**Core 10 (OWASP A01–A10):** Injection · XSS · Authentication · Access control (authz/IDOR/mass-assignment) ·
SSRF · Secrets · Cryptography · Vulnerable dependencies (SCA) · Security configuration · Logging & sensitive
data exposure.

**Extended 7 (design/logic & modern surfaces):** Business logic (state-machine skip/replay, business races,
numeric/temporal abuse) · Feature abuse & data leakage (export=exfil, import injection, search/enumeration
oracles, webhook SSRF) · Data isolation & lifecycle (multi-tenant, cache/index ACL drift, soft-delete
bypass, stale authz) · Client-side (DOM XSS, DOM clobbering, prototype pollution, postMessage/CORS,
service-worker, XS-Leaks, clickjacking) · HTTP protocol (request smuggling/desync, cache poisoning/deception,
host-header trust) · AI/LLM (indirect prompt injection, tool-arg→sink, confused-deputy agency, MCP identity) ·
Resource exhaustion & availability (ReDoS, decompression amplification, query fan-out, pre-auth work
imbalance, quota-accounting gaps).
The planner skips any class with no surface, so extended classes cost nothing on a codebase that lacks them.

## How it works

The pipeline is **recon → threat model → plan → auditors → completeness loop → adversarial sweep →
aggregate**. Two of those exist to catch the audit's own mistakes rather than the code's:

- **threat model** (`recon/threat-model.json`) — the security contract: who the attacker is, which parameters
  they control, what the project promises and explicitly does not, which design controls exist and **what
  each one assumes**. Every auditor cites it when it rules a sink out, which turns "looks fine" into a
  claim that can be inherited, argued with, and overturned.
- **adversarial sweep** — two agents that audit what the plan decided *not* to look at: one digs into a
  directory no auditor was scoped to, deliberately **without** the model, recon or existing findings so it
  cannot inherit their blind spot; the other takes an exclusion the audit itself made and tries to refute it.

See [`docs/WORKFLOWS.md`](docs/WORKFLOWS.md) for the full pipeline, and
[`skills/code-audit/`](skills/code-audit/) for the methodology:
- `SKILL.md` — the verdict process, confidence scoring, false-positive discipline, the mandatory
  fail-open question on security-decision code, the circular-finding test (precondition subsumes
  conclusion), and the prior-art + prevalence gate that decides slip-vs-convention before write-up
- `reference/SOURCE_TO_SINK.md` — slot taxonomy and defense matching
- `reference/SINK_CATALOG.md` — grep-able dangerous sinks by language
- `reference/ecosystems/` — **per-stack framework defaults, versioned CVE cutoffs with their preconditions,
  explicit non-finding lists, and `rg` seeds** (`node` · `python` · `php` · `ruby` · `java-jvm` · `go` ·
  `dotnet`, plus additive `graphql` and `jwt`). `SINK_CATALOG.md` says what a sink *is*; these say what it
  *means* in this framework at this version — which is what most XSS and authz verdicts actually turn on.
  `code-recon` resolves the applicable files and pins the versions once, into `sink-inventory.json`'s
  `ecosystems[]`; every auditor loads from there.
- `reference/REPORT_CONTRACT.md` — fixed deliverable schema & severity rubric
- `reference/OUTPUT_STRUCTURE.md` — working layout & per-finding format

## Before you launch

```sh
node plugins/codeaudit/preflight.mjs --repo /path/to/target
```

Zero tokens, deterministic. It checks the plugin's own integrity — mount paths resolving **from your launch
directory**, dispatched agents existing, enums agreeing across files, the `_safe` heading contract, artifact
producers — and whether the target is auditable (git-tracked, lockfile per ecosystem). Exit `0` clean, `1`
warnings, `2` stop.

It exists because the plugin is markdown and its failures are silent: an auditor whose mount path does not
resolve gets no methodology, no report contract and no ecosystem files, proceeds anyway, and writes a
confident report. `/codeaudit:codeaudit` runs it at Step 6.0 before dispatching anything.

## The mechanical half (tools/)

Three zero-dependency Python scripts the orchestrator runs by path (`$CA/tools/…`), each born on a real
engagement where its absence cost a result:

```sh
python3 -I tools/reconcile.py outputs/<engagement>                 # Step 6.5: enumerated vs verdicted sources → uncited residue
python3 -I tools/aggregate.py outputs/<engagement> --dry-run       # Step 6.6: parse everything, print contract deviations
python3 -I tools/aggregate.py outputs/<engagement> --write --relations plan/_relations.json --meta plan/_meta.json
python3 -I tools/render.py    outputs/<engagement>                 # report.md + exec-summary / remediation-plan / csv / sarif
```

`reconcile.py` turns an auditor's "complete" into a proof or a list of files for a follow-up (expanding path
aliases declared in evidence files). `aggregate.py` de-duplicates, gates on confidence, applies the
`privilege_required` caps, splits the four evidence arrays, merges relations and the two permitted
orchestrator adjustments, and records every malformed input as a `contract_violations` entry instead of
normalising it away. `render.py` renders the fixed report template plus the operator extras from one
`codeaudit-report.json` and a `plan/_narrative.json` the orchestrator writes — so the five deliverables can
never disagree. Tests: `node --test plugins/codeaudit/tools/tools.test.mjs`.

## Measuring it

[`evals/`](evals/) holds fixtures with a **known planted bug and a known safe sibling next to it**, plus
JSON assertions and a zero-dependency judge. Every change to the plugin's rules is a bet that recall goes up
without precision going down; this is what makes that bet checkable instead of arguable.

```sh
# audit a fixture, then judge the report it produced
node plugins/codeaudit/evals/judge.mjs \
  --scenario plugins/codeaudit/evals/scenarios/csrf-state-changing-get.eval.json \
  --report   outputs/<engagement>/codeaudit-report.json
```

CI runs `judge.test.mjs` (semantics + scenario/fixture contract guards) at zero token cost; the model-backed
audit half is deliberately manual, because an expensive non-deterministic run makes a flaky gate nobody
trusts. See [`evals/README.md`](evals/README.md) to add a fixture.

## Authorized use only

For auditing code you own or are explicitly authorized to assess. Static analysis is read-only; hybrid
corroboration sends only benign, non-destructive witness requests to a target you have authorized.
