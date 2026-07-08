# Code-Audit Output Structure

The working layout written during an audit by the auditor agents and aggregated by the
`/codeaudit:codeaudit` command. The final deliverable shape (`codeaudit-report.json` + `report.md`) is
defined in [`REPORT_CONTRACT.md`](REPORT_CONTRACT.md).

```
outputs/{engagement}/
├── activity/                       # NDJSON logs, one per agent
│   ├── codeaudit-orchestrator.log
│   ├── code-recon.log
│   └── {class}-auditor.log
├── recon/                          # code-recon baseline (the foundation)
│   ├── attack-surface.md           # entry points, sources, sinks, trust boundaries
│   ├── architecture.md             # stack, frameworks, data flows, security mechanisms
│   └── sink-inventory.json         # machine-readable: sinks by class (file:line) + entry_points[] (route↔source map for endpoint resolution)
├── plan/
│   ├── deployment-plan.json        # which auditors, against which components
│   └── audit-plan.md               # human narrative of the plan
├── findings/
│   └── finding-{NNN}/
│       ├── description.md          # REQUIRED — details, trace, impact, remediation
│       ├── snippet.txt             # the vulnerable code at the sink (with file:line header)
│       ├── trace.md                # full source→sink hop list with file:line each hop
│       ├── poc.md                  # OPTIONAL — witness payload / repro idea (no live exec required)
│       └── corroboration.txt       # OPTIONAL — live witness result (hybrid mode only)
├── codeaudit-report.json           # ALWAYS — fixed machine schema
└── report.md                       # ALWAYS — consolidated human report
```

## Activity Log (NDJSON)

**Location**: `outputs/{engagement}/activity/{agent}.log` — one JSON object per line.

**Orchestrator**:
```json
{"timestamp":"2026-06-18T10:00:00Z","agent":"codeaudit-orchestrator","phase":"init","repo":"/src/acme","result":"started"}
{"timestamp":"2026-06-18T10:02:00Z","agent":"codeaudit-orchestrator","phase":"recon","action":"baseline-complete","sources":48,"sinks":21}
{"timestamp":"2026-06-18T10:05:00Z","agent":"codeaudit-orchestrator","phase":"planning","action":"plan-ready","auditors":7}
{"timestamp":"2026-06-18T10:35:00Z","agent":"codeaudit-orchestrator","phase":"audit","action":"auditors-complete","findings":16}
```

**Auditor**:
```json
{"timestamp":"2026-06-18T10:10:00Z","agent":"injection-auditor","action":"recon","sources_to_trace":12}
{"timestamp":"2026-06-18T10:12:00Z","agent":"injection-auditor","action":"trace","source":"req.query.sort","sink":"userRepo.ts:130","slot":"SQL-keyword"}
{"timestamp":"2026-06-18T10:13:00Z","agent":"injection-auditor","action":"verdict","finding":"finding-001","verdict":"vulnerable","confidence":"high"}
{"timestamp":"2026-06-18T10:20:00Z","agent":"injection-auditor","action":"safe","vector":"login username param","reason":"parameterized via prepared statement"}
```

## description.md template (per finding)

```markdown
# [{vuln_class}] {title}

**Severity**: {critical|high|medium|low|informational}
**Confidence**: {high|probable|unconfirmed}
**OWASP**: {Axx:2021 ...}   **CWE**: {CWE-xx}   **CVSS**: {score, optional}
**Reachable**: {externally_reachable}

## Location
`{file}:{line}`

## Source → Sink
- **Source**: {param} in `{query|path|header|cookie|json|form}` (`{file}:{line}`)
- **Path**: {hop → hop → sink}
- **Sink**: {sink call} (`{file}:{line}`), slot `{slot_type}`
- **Endpoint** (when resolvable): {METHOD} {path} — resolved from recon `entry_points` (the Step 6.6
  aggregator copies this into `codeaudit-report.json` `endpoint` for the pentest hybrid handoff; omit if the route is dynamic)

## Why it is vulnerable
{Plain-language: the tainted value reaches a {slot} slot with {no defense | wrong defense | defense
nullified by post-sanitization concat at file:line}.}

## Code
```{lang}
{short snippet at the sink}
```

## Impact
{What an attacker achieves on a network-reachable path.}

## Remediation
{Specific, idiomatic fix for this stack — e.g. "use parameterized query / allowlist the column".}

## Witness payload (optional)
`{payload}`  — structure-influence probe for the exploit/validation phase. Not executed during a
static audit; in hybrid mode a single benign corroboration may be attempted.
```

## Rules

- **Always log**: every trace and verdict to the activity log.
- **Always cite**: `file:line` for source, every hop, and the sink.
- **Always record negatives**: safe vectors → `tested_not_vulnerable`.
- **No theoreticals as confirmed**: a finding without a complete code trace is `unconfirmed` and goes in
  coverage gaps.
- **Git-tracked only**: flag tracked files; untracked secrets are informational.
