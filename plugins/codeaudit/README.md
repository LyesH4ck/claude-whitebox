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
  `dotnet`, plus additive `graphql`, `jwt` and `iac` for Terraform/Docker/Kubernetes/GitHub workflows, and
  `other` — threat highlights without version cutoffs — for Rust, Elixir, Swift, Dart, Lua, Clojure, Erlang,
  Crystal, Apex, mobile and serverless). `SINK_CATALOG.md` says what a sink *is*; these say what it
  *means* in this framework at this version — which is what most XSS and authz verdicts actually turn on.
  `node.md` and the catalog also carry the **fail-open and bypass shapes** — decisions, not sinks, that a
  trace-reader skims past (a flag read as a truthy string, a cron secret that disables itself when unset,
  spread order on a write) — ported from deepsec's matcher catalogue (see `NOTICE`).
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
python3 -I tools/recon-coverage.py outputs/<engagement> --repo <repo>   # Step 6.2: route-shaped files vs recon's inventory → missed families
python3 -I tools/reconcile.py outputs/<engagement>                 # Step 6.5: enumerated vs verdicted sources → uncited residue
python3 -I tools/aggregate.py outputs/<engagement> --dry-run       # Step 6.6: parse everything, print contract deviations
python3 -I tools/aggregate.py outputs/<engagement> --write --relations plan/_relations.json --meta plan/_meta.json
python3 -I tools/render.py    outputs/<engagement>                 # report.md + exec-summary / remediation-plan / csv / sarif
```

`recon-coverage.py` is the check on the check: `reconcile.py` proves every source recon enumerated got a
verdict, and says nothing about the files recon never enumerated — a family of routes nobody is sent to is
not reported missing, it is simply absent. The gate lists every tracked source file with a route-shaped
marker for its language and compares it with recon's handler inventory; a directory of three or more such
files with none covered, or under half covered overall, sends recon back on the residue before the threat
model and the planner inherit the gap. `reconcile.py` turns an auditor's "complete" into a proof or a list of
files for a follow-up (expanding path aliases declared in evidence files). `aggregate.py` de-duplicates, gates on confidence, applies the
`privilege_required` caps, splits the four evidence arrays, merges relations and the two permitted
orchestrator adjustments, and records every malformed input as a `contract_violations` entry instead of
normalising it away. `render.py` renders the fixed report template plus the operator extras from one
`codeaudit-report.json` and a `plan/_narrative.json` the orchestrator writes — so the five deliverables can
never disagree. Tests: `node --test plugins/codeaudit/tools/tools.test.mjs`.

Two inputs make successive audits of one repository comparable:

```sh
python3 -I tools/aggregate.py outputs/<engagement> --write --previous outputs/<older>/codeaudit-report.json \
                                                           --accepted /path/to/repo/.codeaudit-accepted.json
```

Every finding carries a **fingerprint** — a hash of class, sink file, sink and source expressions and slot,
with no line number in it — so it survives unrelated edits and id renumbering. `--previous` tags each finding
`new` or `persisting` (with `first_seen`) and lists what was not re-found as a list to verify, never a list
of fixes. `--accepted` reads the operator's `.codeaudit-accepted.json` (fingerprint + reason + who + when):
an accepted risk stays listed, keeps its rating, leaves the tally, and becomes a SARIF suppression. An
acceptance is never inherited from an older report — the file is the only authority.

## The project context file

`{repo}/.codeaudit-context.md` is the operator's standing statement about a repository — what it does, its
auth primitives by name, its trust boundaries, the wrappers a generic auditor would not know to look at, and
the *Known non-findings* already decided. The threat-modeler seeds it on the first run; the operator edits it;
every later run reads it (recon, threat model, every auditor, the verifier — never the blind-dig sweep) and,
at the end, **proposes** what it established as new *Known non-findings* lines that the operator approves
before `tools/context.py apply` merges them. A line there is a hypothesis with provenance: an auditor cites it
only after confirming the current code still matches it. Format and rules in
`skills/code-audit/reference/PROJECT_CONTEXT.md`; the preflight validates the file when `--repo` is given.

## The second opinion (finding-verifier)

After the sweep and before aggregation, every `high`/`critical` finding (every finding, on a small set) goes
to a **finding-verifier**: a fresh agent that gets the claim and nothing else, rebuilds the path from the
sink, hunts the guard the filer missed, checks git history, and writes a cited verdict next to the claim.
`confirmed` keeps the finding, `uncertain` holds it at `probable`, and `refuted` — only with a disposition
and the `file:line` that discharges it — moves it to *Vectors Tested — Not Vulnerable* and lists it under
`refuted[]` so the removal is visible. An uncited refutation is downgraded to `uncertain`; the orchestrator
spot-checks every refutation of a serious finding and can reinstate one with a recorded reason. This is the
pass where most false positives of a static audit die, and it costs one read-only agent per six findings.

## The skipped register

Before announcing, every auditor answers one question in writing: *did I decline, refuse, stop partway or not
reach any file in my scope?* The answer is `SKIPPED: none` or `SKIPPED: <n>` with one `[skipped] path — why`
line per path in its evidence file. The aggregator surfaces them as `skipped_paths`, the report prints them as
their own section, the orchestrator re-dispatches on them, and the preflight blocks an auditor prompt that
stopped asking. It exists because the failure it catches is silent in the worst direction: an auditor that
refuses a file still says `complete`, and the report then prints "all in-scope sources traced" over code
nobody read.

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
