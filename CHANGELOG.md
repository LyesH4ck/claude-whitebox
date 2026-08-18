# Changelog

All notable changes to `claude-whitebox` are documented here.

---

## [2.4.57] — 2026-08-18

Four fixes, every one of them found by running 2.4.49 against a live 16-hour engagement
(`snapeda-testing-2026-08-v2`: 1525 routes, 846 params, 74 adjudicated findings) and then measuring the
result. Nothing here comes from reading the code.

### Fixed — tool resolution picked a 7-version-stale copy, silently

The engagement ran from `/home/cbailleux/Audit/Pentest/…`, not the repo. Every agent's resolver was
`plugins/pentest` (relative — misses) then `ls -d ~/.claude/plugins/cache/*/pentest/*/ | sort -V | tail -1`,
which resolved to a **2.4.49** cache from six days earlier. So the run executed `sqli-detect` with **0 of the
3 timeout guards**, the pre-fix `reconcile-inventory`, the pre-fix `authz-matrix`, and reported
`coverage.mjs is NOT shipped` — all correct statements about the path it had resolved. Meanwhile `/plugin`
displayed 2.4.56, because that screen shows the version the marketplace *offers*, not the one installed
(`claude plugin list` shows the truth).

Guessing the install path by sorting directory names is not resolution. All 16 agents now consult
`~/.claude/plugins/installed_plugins.json` → `installPath` — the path the harness actually loaded — then
`known_marketplaces.json` → `installLocation`, and only then fall back to the cache glob.

**Step 6.1 now logs provenance** as its first act: resolved root, resolved version, the version the
marketplace offers, and whether `coverage.mjs` is present. If resolved ≠ offered it sets `stale: true` and
**stops** — a run attributed to the wrong build invalidates every conclusion drawn from it. One NDJSON line
that would have turned a day of misattribution into a minute.

### Fixed — the NDJSON mandate was aimed at last run's offender

2.4.56 put the explicit "log NDJSON" block only in `business-logic-tester`, because that is where v1's prose
logs were. In v2 the prose moved to `injection-tester`: five free-text logs (`w1d04-sqli-*`) plus 49
locator-less lines, making the entire SQLi effort unmeasurable. Patching the agent that failed last time does
not generalise. All **nine** testing agents now carry the mandate, with the cost stated plainly: a prose log
means everything you tested counts as untested, and a family you cleared cannot be reported
`tested_not_vulnerable` because it has no denominator.

### Fixed — `by_family` invented ~50 families out of agent names

`coverage.mjs` fell back to the agent name when a log line had no `type`, producing rows like
`w1-d01-pentester-executor: 13/846` that buried the real gaps. Families are now matched against a known
vuln-class list (longest-match, so `nosqli` is not swallowed by `sqli` and `sqli-time-based` folds onto
`sqli`); anything unrecognised is `unclassified`. On the real run this collapsed ~50 rows to 7 — and made the
actual signal legible: **`xss: 1/846`, `ssti: 0/846`** next to `sqli: 303/846`.

### Added — `--ground-truth` / `--urlconf`: the number discovery-based coverage cannot produce

`discovered` counts what recon FOUND; it cannot know what recon MISSED. The engagement's own orchestrator
walked every `include()` in the Django URLconf and got **862 patterns against a `surface-map.json` of 247** —
a 3.5x under-count invisible to any discovery-based metric. `coverage.mjs` now accepts an external true count
(`--ground-truth N`) or parses Django route declarations (`--urlconf a.py,b.py`, skipping `include()`
delegations and comments), reports `endpoints.discovery_shortfall`, and re-states coverage against the true
denominator.

The comparison sits on **endpoints**, not routes: a URLconf pattern declares a path, while `routes` fans that
path out per HTTP method (~1.8x on this target). Comparing the two would have hidden a real shortfall behind
an apples-to-oranges win. Against the v2 corpus the union of sources reaches 1272 paths vs 862 — shortfall
correctly reported as 0, not invented.

6 regression tests added (T-C15…T-C19). Full plugin suite: 95/95 green.

---

## [2.4.56] — 2026-08-17

### Fixed — executors did not log WHAT they tested, so coverage was unknowable on every engagement

Replaying all 11 archived engagements through `coverage.mjs` produced **zero exact figures**: 195
`action:"test"` lines across them carry no `endpoint`/`url`/`route`/`target` at all, and 23 executor logs are
free text rather than NDJSON. A test line with no locator is unattributable *by construction* — no tool can
map it back to a route — so `coverage.tested` was structurally unmeasurable and every ratio was a floor.

The root cause was in the agent files themselves: **39 of 53 log examples shipped without a locator**, and
agents copy the example. All 31 examples in the nine testing agents now carry `endpoint` (`"METHOD /path"`)
and, for param-driven families, `param`.

- **The locator rule is now normative** in `docs/reference/OUTPUT_STRUCTURE.md`: any line whose `action` is
  `test`/`experiment`/`verify`/`exploit` MUST carry `endpoint`, plus `param` for injection, reflected XSS,
  SSRF, mass-assignment and path traversal. It also states why relying on a `target` from a distant Phase-1
  recon line does not work — a test line usually acts on a different route, and nothing links the two.
- **NDJSON is mandated where it was being ignored.** `business-logic-tester` gets an explicit block with
  worked examples: five of its executor logs in a real engagement were prose (`=== BLT dispatcher-guard
  integrity ===`, `[1] action=… ON->OFF->ON clean`) and their entire contribution was invisible. The
  narrative belongs in the finding markdown, not the log.
- **`coverage.mjs --lint`** (exit 4) fails when the logs cannot support an exact figure, naming the offending
  files and pointing at the rule. Wired into `commands/pentest.md` Step 6.7 so the caveat reaches the report
  at write time instead of being discovered months later. `REPORT_CONTRACT.md` documents exit 3 (not
  measurable) vs exit 4 (floor only).

This is the change that makes every other coverage improvement measurable: until a test line names its route,
adding testers or raising the quota produces no observable difference.

Full plugin suite: 90/90 green.

---

## [2.4.55] — 2026-08-17

### Fixed — `coverage.mjs` parser gaps found by replaying all 11 archived engagements

Two ways the tool read real work as "tested 0" — a parser failure that looks exactly like a coverage gap,
which is the one confusion this tool exists to prevent:
- **Scheme-less locators.** Executors log `target: "app.example.com/api/v1/x"` without `http://`. Whole
  executors read as having tested nothing. Now parsed as host + path.
- **Test lines with no endpoint.** Dozens of `action:"test"` lines carry no `endpoint`/`url`/`route`/`target`
  at all. Crediting them would over-count; dropping them silently under-counts. They are now counted as
  `evidence.activity.untraceable_test_lines`, they set `lower_bound: true`, and they emit their own caveat.

### Baseline across all 11 archived engagements — no coverage figure is currently trustworthy

| engagement | params | routes | floor cause |
|---|---|---|---|
| snapeda-testing-2026-08 | 8/125 | 9/116 | 5 free-text logs · 51 untraceable test lines |
| moncompteformation-gouv-2026-07 | 2/13 | 4/12 | 51 untraceable |
| demo-achilles-2026-07-tax | 0/47 | 0/141 | 46 untraceable |
| demo-achilles-2026-07-pph21 | 0/0 | 0/107 | 45 untraceable |
| cdc-net-2026-07 | 0/13 | 0/5 | 18 free-text logs · 2 untraceable |
| 5 others | — | — | not measurable: no `inventory/`, or non-standard filenames |

**Zero of eleven produce an exact figure.** The blocker is not the tool: executors do not log WHAT they
tested. `action:"test"` without a locator is unattributable by construction, so `coverage.tested` is
structurally unknowable today and every ratio above is a floor. Fixing the executor log contract (one
mandatory `endpoint` field per test line) is now the highest-value change in the plugin — it is what makes
every other coverage improvement measurable.

The 5 unmeasurable engagements are correct refusals, not failures: they carry no `inventory/` at all, or
ad-hoc filenames (`CONSOLIDATED-inventory.json`, `param-inventory-bola.json`) predating the canonical layout.

Full plugin suite: 87/87 green.

---

## [2.4.54] — 2026-08-17

### Added — `coverage.mjs`: the report's denominator is now arithmetic, not a prompt instruction

Validated against a real engagement (`snapeda-testing-2026-08`). That report shipped with **no `coverage` key
at all**, while `tested_not_vulnerable` stated *"Injection: SQLi/ES/NoSQL/OS-command/SSTI across all reachable
parameterized sinks"* — on the strength of **3 `sqli-detect` runs against 125 discovered parameters**. Nothing
in the artifact let a reader see that. The coverage block is the plugin's own anti-false-negative guard, and
asked of a model in prose it simply was not produced.

`node coverage.mjs --in outputs/{engagement}` reads `inventory/` + `activity/` (no network, no mutation) and
emits the contract's `coverage` object plus ready-to-paste `suggested_coverage_gaps`. On the real engagement:
`parameters 8/125 (6%)`, `routes 9/116 (8%)`, `sqli-detect ran on 3/125`.

It is built to avoid inventing gaps as carefully as it is built to expose them — the two errors are symmetric:
- **Recon is not testing.** `inventory-*`, `business-modeler`, `crud-exerciser`, `form-driver` and the
  orchestrator are excluded from `tested`; only `action: test|experiment|verify|exploit|probe|…` lines count.
- **Unmeasured ≠ zero.** No executor log at all → `ok:false`, exit 3, no published figure. No log line carried
  a host → `hosts.tested: null, unmeasured: true` rather than a fabricated `0/1`.
- **Free-text logs make the figures a FLOOR.** Five `exec-blt-*` logs in the real engagement are prose, not
  NDJSON, so their work is invisible to any parser. `coverage.lower_bound: true` and a caveat naming the files
  is emitted *before* any ratio, so a logging bug is never read as a coverage gap.
- **Routes ≠ endpoints.** Routes are `(method, normalized path)`, endpoints are distinct paths — a multi-verb
  API is not overstated by testing one verb.
- The `sqli-detect-*.json` file count is cross-checked against the parameter corpus separately: one file per
  parameter actually run is the hardest coverage signal available, harder than a self-declared log line.

`commands/pentest.md` Step 6.7/1b now runs the tool instead of describing the computation, and requires the
denominator to be carried into every param-driven `tested_not_vulnerable` entry ("no signal on 8/125
parameters probed", not "across all reachable parameterized sinks"). `REPORT_CONTRACT.md` is updated to match,
including a HYBRID rule: state which basis covers what ("28/125 by code review, 8 probed, 89 untested") so a
reader can tell a code-reviewed sink from a probed one from an untouched one.

### Fixed — `reconcile-inventory.mjs` met a fourth param-inventory shape in the wild

The same real engagement's `param-inventory.json` carried **nine** top-level keys and three param-carrying
arrays at once (`parameters` flat rows, `params`, and `endpoints` rows with their own `params[]`), hand-merged
by the business-modeler. Replaying the gate over it confirms the 2.4.52 fix holds: shape detected as
`object.endpoints`, all nine keys preserved, `endpoints` merged 20 → 114. Pre-2.4.52 this file became `[]`.
Test T-S5 pins that exact shape. `coverage.mjs` unions **every** param-carrying key rather than picking one,
since picking one is how a denominator silently shrinks.

Also observed in that run and worth stating plainly: `reconcile-report.json` recorded
`"method": "manual (script absent)"` — the model hand-wrote the artifact because it could not resolve the
script, and reported 9 merged routes where the real tool finds 52. The 2.4.53 `$PR` resolver addresses the
cause; `coverage.mjs`'s `evidence.inventory_sources` now makes the discrepancy visible after the fact.

Full plugin suite: 85/85 green across 12 files.

---

## [2.4.53] — 2026-08-17

### Fixed — stale instructions the plugin never deleted, still contradicting the live ones

Across 49 versions each refactor added the new rule but left the old one in place. An agent reads both and
picks one. Seven contradictions removed at the source rather than patched in two places.

- **`skills/pentest/SKILL.md` carried a second, obsolete engagement lifecycle.** Its Phases 1–6 told the
  reader to deploy executors and **recursively spawn** more (impossible — subagents cannot spawn subagents),
  and its Phase 6 moved **`findings/`, `activity/` and `reconnaissance/` into `processed/`**, demanding that
  `ls outputs/{engagement}/` show ONLY `report/` and `processed/`. `pentester-executor` mounts this file for 9
  of its 12 categories, so an executor could relocate the exact tree `commands/pentest.md` Step 6.7 was about
  to read. Phases 1–6 and the matching "Output Organization Rules (PHASE 6)" are **deleted**, replaced by an
  authoritative-source table (lifecycle → `commands/pentest.md`; deliverable → `REPORT_CONTRACT.md`; live
  layout → `docs/reference/OUTPUT_STRUCTURE.md`) and an explicit "never reorganize the engagement directory".
- **The destructive block itself is now gated.** `skills/pentest/reference/OUTPUT_STRUCTURE.md`'s migration
  script is a post-delivery packaging pass, but nothing said so — and its
  `mv *SUMMARY*.md *CHECKLIST*.md *.md processed/intermediate-reports/` is a blanket glob that sweeps up
  **`report.md`**, a required deliverable, along with the drafts. Added a precondition check
  (`pentest-report.json` + `report.md` must exist), an explicit "never run this as a subagent", and an
  exclusion loop that keeps `report.md` where it belongs.
- **"Stop when exploitation is confirmed"** (`agents/pentester-executor.md`) directly contradicted the
  dispatcher's time contract ("Do NOT exit early after a single confirmation if budget remains"). The generic
  executor covers ~30 categories, so this was systematic under-execution. Replaced with the escalation rule.
- **`skills/common-appsec-patterns/SKILL.md` says "delegate ALL testing, your ONLY tool is Task"** — and is
  mounted by 7 leaf testers that have no `Task` tool. Added a scope header at the top: those rules address the
  dispatching session; a subagent takes the methodology and executes the testing itself.
- **`csp-bypass-tester` used `browser_console_messages()` as its execution oracle** — the anti-pattern
  `xss-tester.md` bans by name. An `alert()` is a dialog, not a console message, so a real bypass read as a
  clean policy; worse, console output usually means the script was BLOCKED. Both sites now use a
  `window.__cspbypass` beacon read back via `browser_evaluate` (the correct pattern was already 10 lines above
  in the same file). Its "No CSP Present → high impact" also contradicted the contract rubric ("Low — missing
  headers") — now Low, escalating only when chained to a confirmed injection point.
- **`business-modeler` claimed "read-only, no state-changing requests"** while its learning pass deliberately
  sends out-of-order / reused-id / out-of-bounds requests. Reframed as *non-mutating*: probes whose expected
  outcome is a rejection are allowed; a probe that would SUCCEED and change state is deferred to the
  `business-logic-tester` under the write gate (`{probe: "deferred-to-tester"}`).
- **`csrf-tester` Phase 1 — the pass that runs WITHOUT write authorization — fired 9 bare `curl -X POST`**,
  including at `/transfer` and `/admin/action`, to learn status codes. Now `OPTIONS`, which answers the same
  question (does the route exist, does it take a write verb) and mutates nothing.

### Fixed — `environment` was a hard gate that no command ever wrote

Six sites gate state-changing testing on `.pentest-scope.json` `environment` (`crud-exerciser` Phase 0,
`form-driver` Phase 0, `commands/crud.md` Step 2, `pentest.md` 6.3b, `recon.md` Step 6b). The only occurrence
of the key in the whole plugin was a log line — no producer. The gate always fell to its unknown branch. Both
scope-writing flows now ask for it (staging / demo / dev / prod, defaulting to `"unknown"`) and persist it.

Relatedly, `commands/pentest.md` Step 2's inline scope write omitted `transport` and `rules_of_engagement`,
so choosing "Enter new scope" silently **dropped** the operator's Burp proxy and their standing
write-authorization. It now reads the existing file first and carries through every key it did not collect.

### Fixed — the knowledge base resolved only by accident of working directory

The `.mjs` tools have a repo-then-cache resolver; the ~34 distinct markdown mounts across 16 agents did not —
they are bare `plugins/pentest/…` paths that resolve only from a repo checkout, and break on the
marketplace-only install `INSTALL.md` recommends. Worse, three paths (`../docs/reference/REPORT_CONTRACT.md`,
`…/OUTPUT_STRUCTURE.md`, `…/TEST_PLAN_FORMAT.md`) were `../`-relative from a command/agent file and resolved
from **no** working directory at all. All 16 agents now carry the `$PR` resolver before their first Read, with
an explicit `kb-missing` log so a tester running without its payload files is visible rather than silently
under-testing. The three `../docs/` paths are fixed.

`pentester-executor` Phase 0 gets two further repairs: `{skill}` was an unbound placeholder (the dispatch
never passes it) — it now falls back to `skills/pentest/SKILL.md` and logs; and "read the quickstart and
cheat-sheet referenced in SKILL.md" pointed at an index that references no attack files — replaced by a
deterministic `ls` of the category directory, with a `payloads/*` fallback for the ~12 categories that ship no
quickstart, and a coverage gap when the directory is absent.

### Fixed — `/pentest:pentest-exit` could not run its own teardown

`allowed-tools` was `[AskUserQuestion, Read, Write]`, but Step 6 is
`kill "$(cat …/oast/client.pid)"` and Step 2 globs `findings/finding-*/`. The only documented OAST teardown
was unrunnable, leaving an interactsh client alive after every engagement. Added `Bash` and `Glob`.

Full plugin suite: 75/75 green (no behavioural code changed in this release — the `.mjs` layer is untouched).

---

## [2.4.52] — 2026-08-17

### Fixed — the deterministic layer broke the rule it enforces on the agents: a failed run looked like a clean one

The plugin's own bar is "an endpoint that was never executed can never be `tested_not_vulnerable`". The `.mjs`
tools violated it: a transport failure returns `{status: 0, len: 0, ms: <elapsed>}`, and nothing downstream
checked `status`. Four consequences, all of which made a broken run indistinguishable from a good one.

**`sqli-detect.mjs` — a dropped request read as a 20-second delay (structural FALSE POSITIVE).**
`send()` returns the elapsed time on abort, and the `--time-bypass` oracle compared `r.ms` without checking
that a response arrived. The abort fires at `max(--timeout, 20s)`, clearing the `>= 13s` threshold →
`verdict: LIKELY SQLi`, exit 0, against a target that never answered. `--time-bypass` is recommended precisely
when a WAF is suspected — i.e. exactly when requests get dropped. Both time oracles (`sleep3/6`, WAF-bypass)
now require `status !== 0`, and dropped probes are surfaced in a new `timed_out[]` (a coverage gap for that
oracle, never a negative). `transport_errors[]` does the same for the differential probes. Regression test
T-L1 reproduces the original repro with a stub that accepts the connection and never responds.

**`sqli-detect.mjs` — two dead baselines compared "stable".** `{status:0,len:0}` equals `{status:0,len:0}`, so
a wholly unreachable endpoint looked stable, scored `no signal`, and returned `ok: true` / exit 0 — which
`injection-tester` maps to `tested_not_vulnerable`. Now: `ok: false`, exit 3, no `verdict` emitted at all
(there is nothing to conclude). `agents/injection-tester.md` gains an explicit "check the exit code and the
health fields BEFORE reading `verdict`" rule.

**`authz-matrix/run.mjs` — a dead run printed a compliant matrix.** `succeeded()` maps `status: 0` to
`observed: 'deny'`, which MATCHES an expected-deny and renders as `ok` — so an unreachable target produced
`candidates: 0`, exit 0. Now tracks `transport_errors` and `identities_failing_own_requests` (expected-allow
but observed-deny = that identity's session is dead, so every `deny` it produced is meaningless), marks those
cells `⚠️ unmeasured` in the markdown instead of `ok`, warns above the table, and exits 3 when *every* cell
failed. `--dry-run` is exempt (it sends nothing by design — B5 keeps its per-cell degradation).

**`reconcile-inventory.mjs` — it destroyed the parameter corpus right before planning.** `param-mine.mjs`
writes an OBJECT (`{ok, base, endpoints, params, pairs}`); the gate read only the bare-array shape, found
nothing, skipped the merge, then rewrote the file as `[]` — while reporting `ok: true, orphans: 0`. (With
orphans present it instead threw a TypeError on `paramInv.push`.) The gate now detects all three shapes in the
wild (bare array · `{endpoints}`/`{param_inventory}` wrapper · param-mine's `{pairs}` keyed by `methods[]`),
indexes rows under either the `method` or `methods[]` convention, appends new rows in the file's own
convention, and **re-wraps exactly as found** so sibling keys survive. An unrecognized shape is now REFUSED
(`ok: false`, exit 3, file untouched) rather than overwritten.

**Consumers now branch on the exit code, not on the file existing.** The `[ -f "$X" ] || echo "NOT FOUND"`
idiom followed by an unconditional `node "$X"` never branched. All three reconcile call sites
(`commands/pentest.md` 6.3.6, `commands/recon.md`, `commands/crud.md`) are real `if/else` blocks that capture
`$?` and emit a `GAP …` line when the corpus was not reconciled.

### Fixed — the coverage calculation read a glob that matches nothing

`commands/pentest.md` Step 6.7/1b computed `tested` from `activity/exec-*.log`. No agent writes that: every
agent writes `activity/{agent-name}.log` (`OUTPUT_STRUCTURE.md`, `pentester-executor.md:155`). The one
deterministic anti-false-negative measurement in the report was therefore always reading an empty set. Now
resolves `activity/*.log` minus `pentester-orchestrator.log` and `inventory-*.log` (discovery is not testing),
with an explicit `(host, normalized_path)` join key — and if the resolved list is empty while executors were
dispatched, it emits "executor activity logs missing — coverage could not be computed" rather than reporting
`tested: 0` as a result about the target.

14 regression tests added (T-L1…T-L3, T-S1…T-S4, T-H1…T-H3, plus the earlier T-X set). Full plugin suite:
75/75 green across 11 files.

---

## [2.4.51 / pw 0.2.20] — 2026-08-17

### Fixed — the only agent that WRITES to the target was the only one not given `out_of_scope`

`out_of_scope` appeared **zero** times in `agents/crud-exerciser.md`, and neither dispatch site passed it
(`commands/pentest.md` 6.3b, `commands/recon.md` Step 6b) — while every read-only agent received it. The
crawler's sole boundary was `crawl-write.mjs`'s `--scope`, a **registrable-domain suffix** allow-list
defaulting to the start host's domain: `inScope()` matched `host === s || host.endsWith('.' + s)` with no
deny-list and no path component. So an ARMED run (`--submit --marker`) would fill and submit forms on any
sibling subdomain of the target — a third-party IdP, a shared SSO host, a prod twin — none of which the
operator ever named, and all of which they may have explicitly excluded. The read-only `crawl.mjs` had the
same allow-only model, so excluded hosts also entered the recon corpus.

**Fix — a real deny-list, enforced in three places (`crawl-write.mjs`), plus capture-level in `crawl.mjs`:**
- New `--exclude` on both crawlers: comma-separated entries, `/`-prefixed ones matched as **path prefixes**,
  the rest as **host suffixes**. **Deny beats allow**, so it overrides the registrable-domain allow-list.
  `inScope(host)` → `inScope(host, pathname)` at all 7 call sites, so path exclusions actually bite.
- **Crawl frontier** — an excluded route is never harvested (`collectRoutes`) nor enqueued (seed routes).
- **Hard pre-submit gate** — placed before `commitSubEntities()`, not at the terminal submit, because the
  sub-entity Saves are real writes too. Refuses the whole armed pass and records a `blocked` entry with the
  reason. This is the only defence when an SPA `pushState`es onto an excluded route (no document fetch to
  intercept) — covered by test T-X2b, with T-X2c as the control proving the gate is what blocked.
- **Wire-level abort** — `ctx.route()` aborts requests to excluded hosts/paths, since a browser-driven
  crawler cannot know a button's target before it fires. Installed **only** when `--exclude` is passed, so
  the default crawl keeps its un-intercepted network path (test T-X5).
- An excluded form no longer reaches the `form-driver` AI tier: `blocked` growing used to read as
  "submit-no-write" and dispatch the AI driver at the very form the gate refused (test T-X3).
- The deny is never silent: `out_of_scope_blocked {count, samples}` in the output and in `totals`, so an
  empty result over an excluded area reads as "not tested (out of scope)", never "tested, nothing there".

**Plumbing** — `out_of_scope` now flows to the write path: dispatched by `commands/pentest.md` 6.3b,
`commands/recon.md` Step 6b and `commands/crud.md`; `agents/crud-exerciser.md` gains a mandatory Phase-0
translation step (host → bare entry, path → keep the `/`) and logs the resulting `exclude` value;
`agents/form-driver.md` (hand-driven, so no flag protects it) must re-check the page URL before every submit;
`agents/inventory-javascript-mapper.md` passes `--exclude` to `crawl.mjs`.

7 regression tests added (T-X1…T-X5, T-X2b/c). Full stealth suite: 52/52 green.

---

## [2.4.50] — 2026-08-17

### Fixed — `/pentest:pentest` ran its whole recon wave and its testers UNAUTHENTICATED

`/pentest:pentest` collected credentials in Step 2 (`scope.auth`) and passed them to the *planner*
(`- Auth: {auth}`), but never turned that free-text string into a live session before the producers ran.
The only bootstrap lived in Step 6.3.5 — **after** the recon wave (6.3) and **after** the CRUD exercise
(6.3b), both of which are its consumers. Three concrete breaks:

- **Recon dispatched anonymously.** Step 6.3 passed exactly four things: target, engagement, out-of-scope,
  `mks_active`/`mks_url`. None of the five `inventory-*` agents reads `.pentest-identities.json` on its own,
  so `inventory-javascript-mapper`'s auth self-test + cookie-injection path (Phase 0, gated on "if the
  engagement supplied auth") never fired, and `crawl.mjs` ran without `--cookie`/`--state` — authenticated
  data POSTs came back 401 and the surface map covered the public app only, while looking green.
- **Executors dispatched anonymously.** Step 6.5 enumerated target/surfaces/out-of-scope/MKS/OAST/proxy and
  omitted the session — yet the same block already assumed "executors replay live session tokens through
  this hop". `injection-tester`, `xss-tester`, `csrf-tester`, `csp-bypass-tester`,
  `prototype-pollution-tester` and `pentester-executor` have zero references to `.pentest-identities.json`
  or `scope.auth`, so they tested the login wall. The BOLA corpus `.pentest-authz-requests.json` seeded by
  `crud-exerciser` was likewise never handed to `idor-bola-tester`.
- **6.3b referenced identities that did not exist yet**, since 6.3.5 had not run.

Every sibling command already did this correctly (`/pentest:recon` Step 3, then `sql`/`xss`/`ssrf`/`idor`/
`crud` reuse the file) — the monolithic entry point was the outlier, which is why the gap stayed invisible
to operators who start from `/pentest:recon`.

**Fix** — the machinery was present but misplaced, so it was moved and wired, not rewritten:
- New **Step 6.2b — Session / authentication**, right after pre-flight and before every producer: reuse
  behind the Session Freshness Gate (`session-check.md`), else mint from `scope.auth` via the
  `authenticating` skill, else ask the operator for a raw `Cookie:`/`Authorization:` header — and **probe it
  once** before proceeding. Declining sets `session_active = false` and records a blocking coverage gap.
- Steps **6.3**, **6.3b** and **6.5** now pass `session_headers` + `identities_path` explicitly, each with
  the reason it matters (the js-mapper's crawler forwarding; the testers' lack of self-service).
  6.5 additionally passes `.pentest-authz-requests.json` + the identity set to `idor-bola-tester`.
- **Step 6.3.5** no longer re-mints the primary session — it now only tops up the B/second-org identities
  the differential invariants need, and logs `differential_capable`.
- **Step 6.7** coverage pass emits `coverage.authenticated` plus a blocking gap when the run was
  unauthenticated, and a "single identity" gap when cross-identity oracles were degraded.

---

## [2.4.48] — 2026-07-13

### Added — `/pentest:crud` folds its discoveries into the canonical corpus (reconcile pass)
`/pentest:crud` is a pure producer (crawler only — no `inventory-surface-analyzer`, no planner), so its write
routes previously landed only in `crud/*.json` + `route-ledger.jsonl` and never in `param-inventory.json`.
New Step 3.5 runs the deterministic `reconcile-inventory.mjs` gate after the crawl, merging every sidecar-only
route into the canonical corpus (append-only ledger + param-inventory union, idempotent) so the next brick
(`/pentest:idor|sql|xss`) reuses the full write surface. No surface-map re-synthesis here (no analyzer in this
command) — a later `/pentest:recon` / `/pentest:pentest` reconcile folds them into `surface-map.json`. Generic.

---

## [2.4.47] — 2026-07-13

### Fixed — recon data-leak: a discovered high-risk route lost before reaching the testers
Root-cause fix for an architecture defect an engagement exposed: `crud-exerciser` discovered an interaction-only
write endpoint, wrote it to its private `crud/*.json` sidecars, but the synthesis (`inventory-surface-analyzer`)
had already run in parallel from a pre-crud state — the route stayed orphaned, untested, absent from the report
(silent false negative + surface under-estimation). Deep cause: sidecars as source of truth + non-barrier
synthesis + no reconciliation + consumers not reading the union. This is a data-pipeline/orchestration fix only —
no vulnerability-testing logic changed.

- **C1 — canonical corpus mandate.** `crud-exerciser`, `business-modeler`, `inventory-javascript-mapper`,
  `inventory-api-discovery`, and `pentester-executor` now carry a non-negotiable clause: every route/param
  discovered MUST be appended to `inventory/route-ledger.jsonl` (append-only) + merged into
  `inventory/param-inventory.json`, in addition to any sidecar. A datum living only in a sidecar is treated as LOST.
- **C2 — synthesis is a BARRIER.** `commands/pentest.md`: the recon-wave `inventory-surface-analyzer` pass is now
  explicitly PROVISIONAL; the authoritative surface is (re-)synthesized only after ALL producers (recon wave +
  `crud-exerciser` + `business-modeler`) complete.
- **C3 — re-synthesis on late discovery.** New reconcile gate (below) re-dispatches `inventory-surface-analyzer`
  whenever a producer finished after the provisional synthesis (`pentest.md` Step 6.3.6, `recon.md` Step 6c).
- **C4 — deterministic reconciliation gate.** New **`inventory-reconcile/reconcile-inventory.mjs` (+test)**: just
  before planning it unions every agent output (corpus + `route-ledger.jsonl` + `crud/*.json` + `oast/map.jsonl` +
  `param-inventory*.json`) against `surface-map.json`, MERGES each orphan into the canonical inventory (append-only
  ledger + param-inventory union, idempotent) and writes `reconcile-report.json` (`{merged, orphans[], counts}`).
  Wired into both orchestration commands before planning.
- **C5 — consumers read the UNION.** `pentester-orchestrator` (and executors) now plan/read off
  `route-ledger.jsonl` + every `param-inventory*.json`, not just the curated `surface-map.json`.
- **C6 — gateway-prefix routes are first-class.** `inventory-surface-analyzer` dedup key `(host, normalized_path)`
  is locked: an app-host gateway-prefixed route and its direct-host sibling (often different API version/params)
  stay DISTINCT — `normPath` collapses only id segments, never strips a prefix nor folds a version.
- **C7 — authenticated crawl self-test, no silent static fallback.** `inventory-javascript-mapper` gains a
  BLOCKING Phase 0: prove the browser is authenticated via a RECON-discovered identity probe (generic — not a
  hardcoded auth path); on failure apply standardized parent-domain cookie injection; on repeated failure FAIL
  LOUDLY to the orchestrator. Falling back to static bundle analysis and presenting it as complete is forbidden.
  Full-session network capture → `inventory/observed-requests.jsonl` + a mandatory grid/list interaction matrix
  (mount→scroll→filter→sort→row-group) made explicit.
- `REPORT_CONTRACT.md` extended (additively): `discovered` is the reconciled surface; un-mergeable orphans feed
  `coverage_gaps`.
- Tests: +4 reconcile (orphan-merge, C6 distinct gateway/direct routes, mapped-not-orphan, idempotency). Full
  pentest .mjs suite 65/0. Fully generic (0 engagement tokens; genericized two pre-existing example leaks in
  touched files).

---

## [2.4.46] + playwright [0.2.19] — 2026-07-12

### Added — second-order (write→read) taint primitive: stored-XSS reachability + confirmation
Closes the biggest remaining XSS gap: a form value that resurfaces via a DIFFERENT endpoint (list, detail,
export, admin panel). The agent path could not do this reproducibly — it had to GUESS which read endpoint
surfaces the stored value. Built as a GENERIC primitive so the same write→read map serves stored XSS, stored
SQLi/SSTI, and object-exposure (IDOR) questions.

- **New `plugins/playwright/stealth/marker-propagation.mjs` (+test).** crawl-write already writes MARKER-tagged
  values + captures the write requests; this closes the loop. Two levels of proof: **reachability** (deterministic,
  no browser) — search already-captured HAR bodies and/or live-fetched read endpoints for the marker; a canary
  carrying metachars (`PENTEST7<'">`) is classified un-encoded/injectable vs HTML-encoded/inert and by context
  (html-text / attribute / js / url), and the page's sinks are flagged. **Execution** (`--render`) — render each
  read endpoint in the stealth browser with the `window.__xh` beacon exposed (same edge-triggered oracle as
  `domxss-detect`); a value crawl-write stored as a beacon payload that EXECUTES on render → `STORED XSS
  CONFIRMED`, reproducibly. Emits `marker-propagation.json` (`verdict`, `reachable_sink`, `surfaced_at[]` with
  per-endpoint context/encoding/sink/execution). READ-only — the state-changing writes remain crawl-write's
  (already hard-gated staging/demo + RoE).
- **`xss-tester` agent:** the stored-XSS phase replaced the guess-the-endpoint, `alert()`+console approach with
  the deterministic crawl-write(write canary/beacon)→marker-propagation(find+confirm) handshake.
- **`injection-tester` agent:** second-order note now points at the same primitive to locate the read endpoint a
  stored payload lands on, then run `sqli-detect.mjs` there.
- Tests: +4 (static-HAR raw-vs-encoded classification, not-observed, render+beacon confirmed execution,
  encoded-render negative control). Stealth suite 45/0 — no regression. Fully generic (0 engagement tokens).

---

## [2.4.45] — 2026-07-12

### Added — deterministic DOM-XSS coverage (source→sink static inventory)
Completes the DOM-XSS reproducibility work: 2.4.44 made the per-URL *verdict* deterministic (`domxss-detect.mjs`);
this makes *which pages/sources get tested* deterministic too, so coverage no longer drifts with the agent's
ad-hoc choices — the second structural cause of "found one scan, missed the next".

- **New `plugins/pentest/skills/pentest/attacks/client-side/dom-based/domxss-sources/domxss-sources.mjs` (+test).**
  A zero-dep static scanner: it reads JS + HTML bodies from the crawl HAR (recordHar embeds every response body)
  and/or a directory, inventories DOM-XSS **sources** (`location.hash/search`, `window.name`, `postMessage`,
  `document.referrer/cookie`, generic URL reads) and **sinks** (`innerHTML`/`outerHTML`, `document.write`,
  `insertAdjacentHTML`, `eval`/`Function`, string `setTimeout`, jQuery `html()`/`append()`, React
  `dangerouslySetInnerHTML`, Vue `v-html`, Angular `[innerHTML]`, JS-URL navigation), and emits a reproducible
  `domxss-worklist.json`: `{sources_present, sinks_present, detectable_sources, manual_review_sources, worklist:[
  {url, sources[], priority}]}`. One worklist entry per in-scope document × the sources the code actually reads;
  pages that co-locate a source and a sink are ranked `high`. Scope-filtered; `referrer`/`cookie` are separated
  as manual-review (the backbone can't set them).
- **`xss-tester` agent:** the DOM-XSS phase now builds the worklist from the recon HAR **first** (`domxss-sources`,
  resolved repo-then-cache), then runs `domxss-detect.mjs` over **every** worklist entry (high-priority first)
  with that entry's sources — coverage derived from the app's own code, not guessed.
- Tests: +3 (directory scan with source→sink co-occurrence + priority, manual-vs-detectable source separation,
  HAR parse with in-/out-of-scope attribution). Fully generic (0 engagement tokens).

---

## [2.4.44] + playwright [0.2.18] — 2026-07-12

### Fixed — DOM-XSS detection was not reproducible across scans
A DOM-XSS confirmed in one scan could be missed in the next. Two structural causes: (1) the confirmation oracle
was `browser_console_messages()` after an `alert()` payload — but `alert()` is a **dialog**, not a console
message, so an executing payload was seen one run and gone the next; and (2) DOM-XSS was driven **only** by the
LLM agent (no deterministic backbone, unlike SQLi's `sqli-detect.mjs`), so which sources/payloads got tried
drifted between runs.

- **New deterministic backbone `plugins/playwright/stealth/domxss-detect.mjs` (+test).** For each DOM source
  (`hash`, `search`, `postmessage`, `name`) it injects a **fixed** canonical payload whose handler calls a
  Playwright `exposeFunction` binding (`window.__xh`). The binding firing is an **edge-triggered proof of
  EXECUTION** (never reflection) — no dialog, no console scraping, no read race (the callback is awaited with a
  timeout, after a settle). Dialogs are auto-dismissed and counted so an `alert()`-ish sink can't hang the run.
  Encoded reflection can never fire the binding → zero false positives. Reuses `newStealthContext` (proxy,
  `--state`/`--cookie` auth, `--header`, `--insecure`), same shape as `crawl.mjs`. Emits `domxss-detect.json`
  (`verdict`, `confirmed_sources[]`, per-source `executed`/`evidence`). Same URL → same verdict every run
  (proven by a repeated-run determinism test).
- **`xss-tester` agent:** DOM-XSS now runs `domxss-detect.mjs` **first** as the mandatory backbone (resolved
  repo-then-cache), before any manual probing. The hand-driven fallback oracle switched from
  `alert()`+`console_messages()` to an execution beacon (`onerror=window.__xh=…` → `browser_evaluate`) after a
  settle, with `browser_handle_dialog` armed. A Critical Rule now documents the `alert()`≠console pitfall.
- Tests: +4 (hash/search/postmessage/name sinks confirmed via the beacon, encoded-reflection negative control,
  cross-run determinism). Stealth suite 41/0 — no regression. Fully generic (0 engagement tokens).

---

## [2.4.43] + playwright [0.2.17] — 2026-07-12

### Fixed — recon HAR was never flushed (regression in 2.4.42 / pw 0.2.16)
The 2.4.42 backstop wired `recordHar` and emitted `completeness.capture_source: browser-crawl+har`, but the owned
crawlers only called `browser.close()`. Playwright flushes a `recordHar` HAR on **context** close (`ctx.close()`),
**not** on `browser.close()` — so the HAR file was never written despite the harness claiming it was. The Phase-1
complete-traffic backstop was silently a no-op for `crawl.mjs` / `crawl-write.mjs` (the MCP-config HAR was
unaffected — the MCP server closes its own context).

- **`crawl.mjs` / `crawl-write.mjs`:** hoisted the context to an outer `let browser, ctx;` and the `finally` now
  closes the context **before** the browser (`if (ctx) await ctx.close(); if (browser) await browser.close()`),
  so the per-session HAR is actually flushed to `<out>/har/`.
- Verified end-to-end against a local fixture: the HAR now persists both the page load and an interaction-triggered
  read XHR (`GET /api/items?name=widget`), matching `raw-traffic.jsonl`. Stealth suite 37/0 — no regression.

---

## [2.4.42] + playwright [0.2.16] — 2026-07-12

### Fixed — recon capture pipeline: no in-scope request silently dropped
Interaction-triggered READ XHRs (a picker-select firing `GET …/inventories?name=<item>`, a row-drill
`GET …/{id}`, a tab-open lazy load) traversed the proxy but were recorded in NO recon inventory — the
id/filter-bearing requests most useful for BOLA/injection were structurally missing. See
`plugins/playwright/stealth/PATCH-NOTES-5.md` for the full change→root-cause map.

- **Phase 1 — complete-traffic backstop.** `recordHar` added to `playwright-mcp-stealth.config.json`
  (`browser.contextOptions`) so EVERY MCP-driven agent auto-records a full HAR with zero per-agent code, and to
  `browser.mjs::newStealthContext` (`harPath`) so the owned crawlers flush a per-session timestamped HAR. New
  **`har-import.mjs`** folds a HAR into the inventory in the same `op-signature` shape (header VALUES never
  persisted — secrets), and **`observed-merge.mjs`** unions every capture source (crawl+HAR+Burp+widgets+
  raw-traffic) into `observed-requests.jsonl`, the ground-truth corpus.
- **Phase 2 — reconciliation.** `crawl.mjs` emits `raw-traffic.jsonl` + a `completeness` block;
  `inventory-surface-analyzer` gains a reconciliation phase that diffs the corpus vs the curated map and promotes
  **`unmapped_observed`** (on the wire, absent from the map) to first-class surface; `surface-map.json`/
  `recon-manifest.json` carry `completeness` (declares how partial the map is). `recon.md` wires the HAR ingest +
  corpus merge; `discovered` downstream = the corpus.
- **Phase 3 — interaction depth.** `crawl.mjs::exerciseView` gains a read-only picker-select / row-drill /
  disclosure engine (ported from `crawl-write`'s primitives), bounded by per-type caps + an external-rail guard,
  and **never submits** — so READ recon now fires and captures the interaction-triggered reads itself.
- **Phase 4 (optional, documented, not shipped):** an owned mitmproxy superset (also captures curl-based tester
  traffic); `observed-merge --extra` already accepts a mitmproxy JSONL. Burp REST for proxy history is a dead end.
- **Secrets:** HARs / corpus / raw-traffic gitignored (`*.har`, `**/har/`, `observed-requests.jsonl`,
  `raw-traffic.jsonl`); HAR paths per-session unique.
- Tests: +har-import (incident + secret-scrub), +observed-merge (union corpus), +crawl interaction (picker/
  row-drill in read recon). Stealth 37/0, har-import+observed-merge 3/0, crud-merge 8/0 — no regression; existing
  artifact schemas unchanged.

---

## [2.4.41] + playwright [0.2.15] — 2026-07-12

### Added — two-tier CRUD crawler: deterministic backbone + AI form-driver handoff
The deep-CRUD limitation (the single most complex real form not completed purely generically) is now handled by a
two-tier handoff instead of being a dead end.

- **Tier 1 — `crawl-write.mjs` emits `forms_to_drive[]`** (`+ forms-to-drive.json`): armed-only, a form-region the
  deterministic filler DETECTED but did not complete is flagged on two independent triggers — `submit-no-write`
  (clicked submit, captured no write — any form) and `picker-first` (a picker + a create-hint primary action never
  driven to a write). Each entry carries `{route, url, reason, detected:{pickers, primary_action, candidate_actions},
  background_writes}` (the load-time telemetry/preview writes the driver must NOT count as creates). Proven live on
  the heavy Vuetify form.
- **Tier 2 — new `form-driver` agent** (`agents/form-driver.md`): adaptive AI driver for ONE flagged form —
  same hard Phase-0 gate (env + RoE), authenticated+proxied browser via `addCookies`, picks a VALID counterparty,
  commits sub-rows before the parent submit, applies the persistence oracle (a 2xx is not a create), and returns
  seeds in the backbone's exact shape (`actions[]`/`session_writes[]`/`findings[]`) with a hard `crud-merge`
  contract (bare-label owner, real `created.id`, `mutation` flag). Parallelizable per form.
- **Orchestration** — `crud-exerciser.md` Phase 3 and `commands/crud.md` wire the handoff: after the backbone run,
  read `forms-to-drive.json` and drive each flagged form (inline or by fanning out `form-driver` subagents), then
  merge. The crud summary now reports "complex forms driven by AI".
- Agent count 19 → **20** (docs/CLAUDE.md + READMEs en/fr/zh).
- Tests: +3 (`forms_to_drive` emission; no emission in dry-run; a no-picker gated form flagged via submit-no-write).
  Stealth suite 36/0, crud-merge 8/0, all green.

---

## [2.4.40] + playwright [0.2.14] — 2026-07-12

### Added / Fixed — crawl-write.mjs patch #4: reach & engage real SPA forms (G1 seeds, G2 picker) + regressions
With auth unblocked (patch #3), this patch makes the harness able to REACH create views on a micro-frontend
launcher and ENGAGE picker-first forms, and fixes two residual regressions. See `stealth/PATCH-NOTES-4.md`.
Genericity preserved (`--seed-route` is operator input). **Live-validated authenticated.**

- **G1 — `--seed-route <route>` (repeatable) / `--seeds <file>`.** Operator-supplied create routes are resolved,
  scope-checked, and enqueued FIRST in the BFS frontier — the reliable way to reach a create view on a launcher
  with no crawlable `<a href>`. Emits `seed_routes`. **Live:** the seed page is now reached (`pages_visited 1→2`).
- **G2 — picker-first / multi-step forms.** A shared `PICKER_SEL` broadens picker recognition (Vuetify
  v-autocomplete/v-select, Material mat-select, ARIA comboboxes, typeaheads); after a valid option is selected the
  step loop re-introspects and commits the revealed rows; `pickSubmit` no longer grabs a sub-entity Save, and the
  parent submit is re-picked after the rows commit (it is often disabled until then). Unit-proven (T-G2-picker).
- **bug#1** — `idFromUrlChange` restored to the `positive` signal: a create proven only by navigating to `/…/{id}`
  (POST 200, no id/Location) is `created` again, not `blocked`.
- **bug#2** — read-POSTs classified `mutation:false` producer-side: a GraphQL query (`{query}` non-mutation, or a
  `/graphql` terminal) and an ag-grid list POST (`filterModel`/`startRow`/`rowGroupCols`/`sortModel`) are never
  seeded as mutations.
- The shared `non-persist-tokens.mjs` set was restored to full breadth (incl. activity/log/count/list): the
  create oracle's positive-override makes it safe, and it correctly marks a telemetry POST (e.g. an activity-log
  200) as a non-mutation for session-write seeding — a mis-seed the live run caught.
- `crud-exerciser.md` documents the **two-tier model** (authenticated mapper = reliable; deep CRUD = best-effort
  via seed-routes + picker recognition) and `--seed-route` usage.
- Tests: +T-G1-seed, T-G2-picker, T-bug1, T-bug2 (+ telemetry classification); stealth 33, crud-merge 8, all green.
  **Honest status:** the authenticated mapper tier is solid and live-proven; the deep-CRUD tier reaches create
  views and drives generic picker forms, but the single most complex real form is not yet completed purely
  generically (heavy mount + dependent interactions) — the machinery is unit-proven.

---

## [2.4.39] + playwright [0.2.13] — 2026-07-11

### Fixed — crawl-write.mjs patch #3: authenticated-browser blocker (P0) + patch #2 over-correction (P1) + hygiene (P2)
A 3-reviewer review + an authenticated live run found the reason patches #1/#2 could never be validated on a
real target, plus false negatives from patch #2. See `stealth/PATCH-NOTES-3.md`.

- **P0 [BLOCKING] — cookie auth via `ctx.addCookies`, not `extraHTTPHeaders`.** A manual `Cookie` header is
  dropped by the browser on HTTPS-through-a-proxy and never populates `document.cookie`, so a SPA's client-side
  auth guard redirected to login — the harness never reached authenticated forms. `browser.mjs` now injects
  `--cookie` as real cookies on the registrable domain (IP/localhost → exact domain); `extraHTTPHeaders` keeps
  `--header` only; `--state` unchanged. Same fix in `crawl.mjs`. **Live-proven:** authenticated app routes
  reached (`data_endpoints 1→15`), no login fallback. Unblocks the whole plugin in browser mode.
- **P1/F1 — the non-persistent denylist is ADVISORY.** The submit now COLLECTS every mutating write and a strong
  positive signal (201 / Location / URL→detail / non-echoed id) OVERRIDES the token (a real 201 on a
  `…/validation`-named path is a create again, not `blocked`); the token is terminal-segment-only and the lottery
  tokens (check/list/activity/log/track/trace/count/health) were removed.
- **P1/F2 — reject an echoed id only when AUTH-PRINCIPAL.** Patch #2 rejected any request-echoed id → legit
  client ids (UUID/idempotency key/low-int collision) lost → empty BOLA corpus. The echo set is now restricted to
  values sent under `company/tenant/owner/user`-type keys; resource ids are kept.
- **P1 — session-writes filtered by FORM, not token.** The harness tags each session write with a `mutation` flag
  (method+status+form); `crud-merge` seeds only mutations (a GraphQL/ag-grid read-POST is no longer replayed).
- **P1/G4-sel** — a sub-entity Save must sit in a genuine repeated group (`<li>`/`<tr>` with a sibling, or a
  repeat-classed element with a same-class sibling); a lone `ag-row`/`form-row`/`flex-row` no longer qualifies.
- **P2** — `NON_PERSIST_TOKENS` extracted to `non-persist-tokens.mjs` (no more crawl-write/crud-merge drift);
  `findId` reads `{data:[{id}]}` arrays; `commitSubEntities` re-queries handles after each commit (Vue/React
  re-render / sequential row revelation) with signature dedup (no amplification).
- Tests: +P0 cookie (document.cookie discriminator), T-P1-F1, T-P1-F2, T-P2-array, crud-merge mutation flag; all
  suites green (stealth 29, crud-merge 8). Deepest nested-form end-to-end completion remains best-effort; the
  generic machinery is unit-proven and now runs authenticated.

---

## [2.4.38] + playwright [0.2.12] — 2026-07-11

### Fixed — crawl-write.mjs patch #2: adversarial-review correctness fixes (F1–F5)
A 3-reviewer adversarial review of the G1–G6 patch found **3 critical correctness defects** that poison the
downstream testers (idor-bola / injection) with phantom, wrong, or duplicated seeds, plus robustness gaps. Each
fix is red-before/green-after tested; genericity preserved. See `stealth/PATCH-NOTES-2.md`.

- **F1/F4 [CRITICAL] — G5 was not a persistence oracle.** It recorded a create on the FIRST 2xx non-GET write, so
  a preview/validation/telemetry 200 (or an ag-grid `count` POST) became a false `created` and `blocked` was
  unreachable. Now waits for a **candidate-create** write (`mutationWritePredicate` = POST/PUT/PATCH to a
  non-denylisted path) and requires a **positive persistence signal** (201 / `Location` / URL→detail / non-echoed
  response id) — else `blocked` with the read reason. Generic token denylist for non-persistent paths.
- **F2 [CRITICAL] — `findId` picked the wrong id.** It returned the first id at any depth, so `owner:{id:<company>}`
  yielded the auth principal id → crud-merge derived a cross-tenant GET/PUT/**DELETE** corpus. Now prefers a
  top-level (or `data`/`result`-wrapped) id, never descends into an auth-principal node, and rejects any value
  echoed from the request body.
- **F3 [CRITICAL] — G4 amplified writes.** `commitSubEntities` ran every step + a terminal ≥400 re-looped → sub-Saves
  clicked up to 4× (many objects/form). Now runs once per form (step 0); 4xx retries the parent only, 5xx stops.
- **G4-sel [MEDIUM]** — sub-entity container matched by word boundary (`\b(card|row|line|item|entry)\b`, not
  `[class*=]` which hit Tailwind `items-center`/`ag-row`/`inline`) and must not contain the parent submit.
- **F7/G3 [MEDIUM]** — blocking detection now covers a multilingual `<negation> … valid` (e.g. "non valide") AND
  inline validation (`aria-invalid`, `.v-alert`/`.mat-error`/error helper-text), not just an `invalid` toast.
- **bug#3 [MEDIUM]** — read-only discovery: the `openAddDialogs` guard ignores search-like fields (a list page's
  search box no longer blocks the +Add dialog), and the typeahead probe is scoped to the open overlay (an unscoped
  `input[placeholder*=search]` was typing into the page's own list-search box).
- **F5 [MEDIUM]** — `crud-merge.mjs` gains `--session-writes`: the intermediate/nested writes (`session_writes[]`)
  are seeded as extra BOLA/BOPLA requests, mutation-filtered (telemetry/preview/count/non-2xx/GET dropped);
  `actions[]` stays the primary source. `crud-exerciser.md` passes it and documents the new oracle.
- Fixed a latent TDZ bug (blocking-regex consts moved above the top-level-await block). Tests: +5 harness gap tests
  + F5 merge test; all suites green (stealth 23, crud-merge 8). **Authenticated live re-benchmark NOT run — the
  provided cookie is expired; a fresh operator cookie is required to re-validate the authenticated nested flow.**

---

## [2.4.37] + playwright [0.2.11] — 2026-07-11

### Fixed / Added — crawl-write.mjs SPA / micro-frontend nested-form support (G1–G6)
The `/pentest:crud` harness stalled on SPA / micro-frontend apps with nested forms (baseline on the demo
target: `pages_visited:2, forms_processed:1 (login only), created:0`). Test-driven from a reference crawler +
ground truth; each gap is a regression test in `crawl-write.test.mjs` (red before / green after), genericity
preserved (no target-specific selector in the harness). Live dry-run after: `pages_visited 2→6, forms 1→3`.

- **G1 — SPA route discovery.** `nextNavTarget` read only `a[href]` from the current page → stalled at 2 pages.
  Now `collectRoutes` harvests `routerlink`/`data-href`/`data-route`/`role=link` tiles, a **global BFS frontier**
  queue survives dead-end routes, and `mountSettle` waits for the micro-app to mount before introspecting.
- **G2 — formless form-regions.** `INTROSPECT` keyed on named `input/select/textarea` → 0 fields on a Vuetify/
  React region (no `<form>`, `role=combobox/textbox/spinbutton`, `contenteditable`, nameless). Now enumerates
  those, derives a name from `aria-label`/`placeholder`, tags each with `data-cx-field` for reliable locating,
  and fills `contenteditable`. `openAddDialogs` self-guards so it never fires a visible region's own submit.
- **G3 — validation-aware option selection.** `fillWidgets` took the first option; the first can be poisoned
  (blocking toast / inert submit). Now re-reads state after each pick and advances to the next option on a
  blocking error (`readToast`/`hasBlockingError`).
- **G4 — nested sub-entity commit order.** `commitSubEntities` clicks per-card/row Save buttons (create-hint,
  not the terminal submit, inside a `card/row/line/item/li/tr`) in DOM order before the parent's terminal action
  — the buyer→`POST /vendor`, line→`PUT /inventories/{id}` chain a linear wizard missed.
- **G5 — state-delta oracle (`200 ≠ created`).** A create is recorded ONLY on a real 2xx in-scope write; a
  submit that fired no 2xx write → `blocked[]` (`intent_blocked`) with the read toast reason, never a phantom
  `created`; a 4xx/5xx response is never a create.
- **G6 — intermediate writes + errors.** A session-wide `response` listener records every in-scope write
  (`session_writes[]` seeds, incl. intermediate sub-entity writes) and routes 4xx/5xx to `findings[]`
  (endpoint contract + server bug). New `session-writes.json` / `findings.json` outputs (additive; `crud-merge`
  still consumes `actions[]`/`intents[]` unchanged). `crud-exerciser.md` phases 2–3 document the new behavior.
- Tests: +5 gap tests (G1–G5), all `stealth/` suites green (18 assertions). See `stealth/PATCH-NOTES.md`.
  Live end-to-end completion of the deepest fully-nested form remains best-effort; mechanisms are unit-proven.

---

## [2.4.36] — 2026-07-11

### Fixed — adversarial multi-agent self-review of the plugin (prompts · code · orchestration)
From a 6-dimension review (find → adversarially-verify → synthesize); 21 raw findings, 3 refuted, 18 confirmed.
The theme was **incomplete propagation of good patterns already in-tree**, not conceptual gaps.

- **[HIGH] csrf-tester was the lone verification/safety outlier — now aligned with every sibling tester.**
  It confirmed CSRF on HTTP status alone (a 2xx/302 "success" is routinely a silent reject / redirect-to-login /
  no-op) and fired 5 real account mutations *before* its approval gate. Rewrote it around a **state-delta oracle**
  (re-read the field through a legitimate path; `before != after` is the only proof — else `probable`), a
  **Phase-0 RoE/env gate** (forge submits run only against a controlled test account, mirroring `crud-exerciser`),
  a **write ledger + revert**, and a reconciled confirmation bar (curl oracle confirms; `poc.html` is the
  cross-site repro artifact, not the proof — the agent has no browser).
- **[HIGH] idor-bola-tester ran its core authz-matrix engine via a bare path** — no repo-then-newest-cache
  fallback, so from a cache install the BOLA/BFLA oracle (the agent's whole purpose) silently no-op'd while the
  run reported complete. Ported the `injection-tester` resolver (`$AUTHZ_RUN`) + a coverage-gap-if-unresolved line.
- **[MEDIUM] `<playwright-plugin>` / `<pentest-plugin>` placeholders reached `node` verbatim** in
  `crud-exerciser`, `pentester-executor`, `inventory-javascript-mapper`, `recon.md`, and `pentest.md` — the
  write-surface/stealth harness chain failed on a cache install. Added repo-then-newest-cache resolver blocks
  (`$PW_STEALTH` / `$PENTEST_PLUGIN`) at first use in each.
- **[MEDIUM] authz-matrix `run.mjs` aborted the entire cross-identity replay** (even `--dry-run`) on a single
  host-less request with no `base_url` — an uncaught `TypeError` from `new URL()` outside the try/catch. It now
  degrades that one cell to `{status:0, error:'unresolvable URL …'}` and the run continues. Regression test added.
- **[MEDIUM] Flagship `/pentest:pentest` never exercised the write surface** — it deployed only the read-only
  inventory agents, silently dropping the BOLA corpus + write-body injection params (no coverage gap). Added a
  gated **Step 6.3b CRUD-exercise** sub-phase mirroring `/pentest:recon` Step 6b (RoE/env hard gate → deploy
  `crud-exerciser`, else record an explicit coverage gap).
- **[LOW] param-mine dropped single-char query params** (`?q=`, `?s=`) from the flat inventory (the `< 2` floor).
  Lowered the floor to 1 for `where === 'query'` only (body/shorthand keeps floor 2 as noise-guard). Test added.
- **[LOW] op-signature drift-guard was RED** — the vendored playwright copy had diverged from the canonical
  (added `safeDecode`/`collectParams`/`paramRows`). Re-synced byte-for-byte (canonical now carries the same
  functions); drift guard green.
- **Docs drift:** `HYBRID_HANDOFF_SPEC` header (PROPOSITION → IMPLÉMENTÉ), `TEST_PLAN_FORMAT` (deprecated
  "planner deploys / recursive spawning" → the planner/command split + quota model), `pentest-attacks` +
  `TEST_PLAN_FORMAT` (added business-modeler/-tester + idor-bola-tester), `WORKFLOWS` + `CLAUDE.md` (added the
  Step 6.3b CRUD + Step 6.3.4 hybrid-handoff lifecycle stages).
- **Self-review round (`/code-review` on the diff) — 3 regressions in the above fixes caught and closed:**
  (1) the new `$AUTHZ_RUN` / `$PW_STEALTH` vars were resolved in one Bash block but reused in a later one —
  shell state does not persist across Bash calls, so the second block ran `node ""`; every execution block is
  now **self-contained** (re-resolves in-block). (2) The single-char query floor was scoped to *all* `query`
  adds, letting the noise-prone global text scan leak `?e=` phantoms from minified ternaries — floor-1 is now
  confined to params pulled from a **real URL query string** (`force` flag), global scan keeps floor 2.
  (3) Resolvers now validate the **actual `.mjs` with `-f`** (not just the plugin dir) and all carry the
  coverage-gap guard uniformly (`pentester-executor`, `recon.md` no longer omit it).
- Tests: +4 regression assertions (single-char query floor, ternary-phantom rejection, host-less-URL non-abort,
  op-signature drift). All `.mjs` suites green (7 files, 54 assertions).

---

## [2.4.35] + playwright [0.2.10] — 2026-07-11

### Fixed — code-review of the 2.4.34 quick-wins (3 confirmed self-inflicted regressions)
- **Dead-link navigation starvation.** After D3 admitted hash/relative links, a dead SPA link whose click doesn't
  change the URL was never marked visited (only the *landed* page was), so it was re-selected every iteration and
  burned the whole `--max-views` budget — the opposite of D3's depth goal. Now the nav target is marked visited
  when SELECTED (a separate `processed` set dedups page-work), so a dead link is tried once and navigation moves on.
- **`--owner` bypassed the `labelish` guard.** `crud-merge` trusted `act.owner` verbatim, so a descriptive
  `--owner "alice (tenant 5)"` flowed into `run.mjs` where it never matches an identity label — silently degrading
  every BOLA row to "AUTHZ?" (the exact failure D2 meant to fix). Both `act.owner` and `act.identity` are now
  passed through `labelish`; a descriptive value degrades to null (safe fallback) instead of a false non-match.
- **Param-inventory merge dropped params on collision.** The `${method} ${endpoint}` merge kept the first row, so a
  widget-discovered param colliding with a crud CREATE on the same endpoint was dropped instead of unioned. The
  merge (and the intra-batch `--widgets` append) now UNION params by `in:name`.
- Tests: dead-link no-starvation, `--owner` labelish guard (descriptive→null / bare kept), widget↔crud param union.
  65 `.mjs` tests green.

---

## [2.4.34] + playwright [0.2.9] — 2026-07-11

### Fixed / Added — /pentest:crud crawler review quick-wins (stability · performance · depth · params)
From a multi-agent review of the whole `/pentest:crud` pathway (36 challenge-verified findings). The quick-wins pack:
- **D1 [depth/params, flagship] — capture request BODY params, not just query.** The read-side listener recorded
  only `{method,host,path,query}`, and the widget inventory hard-coded `in:'query'` — so ALL body params (nested
  JSON, GraphQL `variables`, form) were dropped, and body-only endpoints were filtered out entirely. It is the
  only param artifact produced in the default (dry-run) mode. Now captures `req.postData()`, folds JSON leaves via
  `flattenParams` (`in:json`) / form keys (`in:form`), keys endpoints by `normPath`, and dedups by
  `bodySignature` — reusing the vendored `op-signature.mjs` kernel (D6/D7). Typeahead-POST / ag-grid / GraphQL
  params are now inventoried.
- **D2 [params] — `--owner <label>`.** `owner` was hard-coded `null`, silently disabling the crud→idor BOLA
  foreign-data oracle (`run.mjs` gates it on a real owner). The tool now stamps `--owner` on every action/intent.
- **C1 [depth] — decoupled `--max-forms` from navigation.** `processedForms` was incremented on EVERY page
  (incl. formless), capping the crawl at ~6 views regardless of `--max-views=15`. Now `--max-forms` bounds
  submissions only (a page counts only if a form did real work); navigation is bounded by `--max-views`.
- **D3 [depth] — hash-router SPAs no longer collapse to one page.** `routeKey` used pathname only, so `/#/vendors`
  and `/#/customers` shared key `/` → the crawl stopped after one page. `routeKey` now includes a route hash
  (`#/…`), and `nextNavTarget` no longer pre-drops relative/hash hrefs (scope is checked on the resolved URL).
- **B1 [performance] — bounded `settle()`.** `networkidle(3000)+400ms` × ~80 widget settles/page made the crawl
  look stuck on chatty SPAs. Now `networkidle(800)+250ms` (a debounced typeahead XHR still dispatches in-window).
- **D4 [params plumbing] — `crud-merge --widgets <file>`.** The `widget-param-inventory.json` (produced even in
  dry-run) had no deterministic consumer. `crud-merge` now merges it (and runs without `--crud`).
- **D9 — fixed the dead `num()` ternary** (both branches returned `v`, so `salt` never varied a numeric field on retry).
- Tests: body-param (nested JSON `in:json`) capture, `--owner` stamping, `crud-merge --widgets` merge + the
  no-args error. 62 `.mjs` tests green.

---

## playwright [0.2.8] — 2026-07-11

### Fixed
- **`crawl-write.mjs` — the 0.2.7 generic completion was too aggressive and derailed real apps ("le crud exit").**
  The armed completion ran PAGE-WIDE: `pickSubmit` would take "the last non-cancel button" anywhere on the page
  (grabbing a nav/menu/logout button) and `fillWidgets` opened every dropdown on the page (nav/filters), so the
  crawl wandered off the create flow and captured little. Fixes:
  - **Scope all armed interaction to the open create dialog** (`[role=dialog]:visible`, mat-dialog, .modal, cdk
    overlay) when there is one — fill/submit/widgets operate inside it, never on page-level chrome.
  - **`pickSubmit` is conservative page-wide**: only a primary-styled or create-hinted button; the bare
    "last non-cancel button" fallback is gated to `allowLast` (true ONLY inside a dialog, where a footer holds
    just form actions). Label-agnostic where it is safe to be, not everywhere.
  - Added `logout`/`signout`/`menu`/`help` to the excluded-labels set (a "Logout" button matched neither
    destructive nor cancel before).
  - Regression test: a page with page-level Logout/Menu buttons + the dialog create flow — asserts the nav
    buttons are NEVER clicked and only the dialog's create fires.

---

## [2.4.33] + playwright [0.2.7] — 2026-07-10

### Added
- **`crawl-write.mjs` — generic "complete the form like a user, whatever the action is called".** The armed run
  no longer just fills a flat `<form>` and clicks a create-labelled button. It now, GENERICALLY (not per-app):
  opens the create dialog (via +add BUTTONS, not only links); fills native fields AND **drives custom
  dropdowns/typeaheads** (opens each, selects a valid option — so required custom selects are satisfied);
  **advances multi-step wizards** (`--max-steps`, re-introspecting each step); and clicks the final action
  **LABEL-AGNOSTICALLY** — it does NOT match the button's name (Save / Submit / Valider / Simpan / Kirim / 確定
  / …); it excludes cancel/back/close/destructive (multilingual) and takes the primary action, then captures the
  write. Per-step write-wait shortened to 5s so a wizard doesn't burn the full timeout per non-final step.
  - Test `crawl-write.test.mjs`: a stub with a page-level +add button → dialog → custom combobox → a Continue
    step → a `確定`/Cancel footer; asserts the flow opens, fills the widget, advances, and submits via the
    non-English primary (not Cancel), capturing a 2-step create.
  - `crud-exerciser` Phase 3 documents the generic completion.

---

## [2.4.32] + playwright [0.2.6] — 2026-07-10

### Added
- **`crawl-write.mjs` — read-only custom-dropdown / typeahead param discovery (`--widgets`, default ON).**
  Confirmed on a live target (a Vue `+add` dialog): the app's dropdowns are custom `<div role=combobox>`
  widgets, NOT native `<select>`, and they hide injectable params — typing in the buyer typeahead fires
  `GET /api/v1/vendor?…&keyword=…`, and picking an inventory item echoes its value into
  `GET /api/v1/inventories?…&name=<value>`. A path-crawl, a native-`<select>` scrape, AND a first-option pick
  all miss these. The new pass opens add-dialogs (via buttons, not just links) + ARIA/custom dropdowns, types a
  probe into any revealed search input, and selects a few options — capturing the option-driven data endpoints
  into `widget-param-inventory.json` (merged into `param-inventory.json` → fuzzed by `injection-tester`).
  - **READ-ONLY** (search/select never submit a form; it never clicks a button inside a `<form>`), so it runs
    even in dry-run and under a no-mutation RoE. Bounded by `--max-widgets` / `--max-options`.
  - `crud-exerciser` Phase 3 documents the pass + an MCP fallback for non-ARIA custom widgets.
  - Test `crawl-write.test.mjs`: a stub reproducing the Vue combobox→typeahead→`?keyword` /
    option-select→`?name` pattern; asserts both are inventoried.

---

## [2.4.31] — 2026-07-10

### Fixed
- **Wired the orphaned deep KB for the generalist-executor attacks (audit #3).** These comprehensive docs were
  named off-convention (not `*-quickstart`/`*-cheat-sheet`) and listed nowhere, so nothing reached them. Rather
  than load them into every sweep, added a **"deep reference" pointer in each sibling cheat-sheet** (which
  `pentester-executor` already reads by convention) → the deep doc, to be read at Phase-3 escalation:
  - `jwt-cheat-sheet.md` → `jwt_attack_techniques.md` + `portswigger_jwt_labs.md`
  - `http-request-smuggling-cheat-sheet.md` → `http-request-smuggling.md`
  - `api-testing-cheat-sheet.md` → `api-testing-comprehensive-guide.md`
  - `pentester-executor` Phase 2 now tells the agent to follow a cheat-sheet's deep-reference pointer when
    escalating (don't stop at cheat-sheet payloads for a non-trivial exploit).
- **Demoted `jwt_security_resources.md`** to a passive reference appendix (OWASP docs / advisories / tooling
  reading list) — superseded for exploitation by the two JWT technique/labs docs; explicitly kept OUT of the
  exploitation loop.
- Audit note: the `*-cheat-sheet` docs for ssrf/xxe/path-traversal/oauth/deserialization/race-conditions/web-llm
  were NOT orphaned — `pentester-executor` reaches them via its `quickstart.md`/`cheat-sheet.md` naming
  convention (an earlier over-flag, corrected).

### Fixed
- **Sibling-agent KB under-use (audit follow-up to the injection-tester fix).** Same pattern as 2.4.29, found
  across the tester agents:
  - **`xss-tester` never read `dom-based-vulnerabilities-complete.md`** (3249 lines — the largest doc in the
    repo, in its own DOM domain: source→sink map, PortSwigger DOM-XSS labs, Web Messages/`postMessage`, DOM
    Clobbering, prototype-pollution→XSS gadgets, advanced sink escalation). Now wired in as the DEEP reference,
    read at the DOM-XSS handling step (not wholesale during the sweep) so a non-trivial sink is exploited, not
    just confirmed with a quickstart payload.
  - **`prototype-pollution-tester` never read `prototype-pollution-cheat-sheet.md`** (1133 lines — exploitation
    payloads, gadget chains, bypass, per-library sinks). Now read once pollution is confirmed, to turn
    `Object.prototype` control into real impact (XSS/RCE via a gadget) instead of stopping at "pollution confirmed".
  - Audit note: the tool-path axis is clean (the `../skills/` bug was isolated to injection-tester +
    inventory-javascript-mapper, already fixed); `idor-bola-tester` correctly mandates its `run.mjs` backbone.
    Remaining orphaned comprehensive docs (`http-request-smuggling.md`, the JWT suite, `api-testing-comprehensive-guide.md`)
    are tracked separately — wire-or-archive decision pending.

### Fixed
- **`injection-tester` never consulted the SQLi knowledge base — only the quickstart + `sqli-detect.mjs`.** The
  comprehensive **`sql-injection.md`** (3038 lines: 18 worked PortSwigger labs + extraction techniques — UNION
  data-from-other-tables, schema/data enumeration, blind conditional/time retrieval, OOB exfil, second-order,
  stacked queries, filter-bypass) and **`payloads/blind.md`** were never referenced by the agent, so its
  exploitation was capped at what the detector alone surfaced. Now the agent is pointed at `sql-injection.md`
  as the DEEP exploitation reference (read the matching section during Phase 3 escalation, not wholesale during
  the sweep) and at `payloads/blind.md` for blind time/boolean/OOB payloads — with an explicit "`sqli-detect.mjs`
  DETECTS; these docs tell you how to EXTRACT" note. Complements the 2.4.27 CONFIRMED ≠ DONE escalation.

### Added
- **`sqli-detect.mjs` — unquoted numeric-context boolean for EVERY param.** The bare `<orig> AND 1=1` /
  `<orig> AND 1=2` differential is now sent for string params too (was numeric-only), catching a value that
  lands in an unquoted / identifier SQL context where the quoted payloads never break. (`num_expr_eq` arithmetic
  stays numeric-only.)
- **`sqli-detect.mjs --time-bypass` — heavy 15s WAF-evasion time payloads (opt-in).** Adds a stacked-subquery
  polyglot `(select(0)from(select(sleep(15)))v)…`, the keyword-avoiding `if(now()=sysdate(),sleep(15),0)` and
  `4*if(…)`, and XOR-wrapped single/double-quote context breaks `0'XOR(…)XOR'Z` / `0"XOR(…)XOR"Z`. A clean ~15s
  delay over a fast baseline is flagged `time-based` positive. **Short-circuits on the first confirming delay**
  (no DB hammering) and uses a >15s per-probe timeout so the sleep isn't aborted. Off by default (heavier on the
  DB); the `injection-tester` invokes it for WAF/filtered targets. New tests cover the bare-AND pass and the
  gated bypass detection.

---

## [2.4.27] — 2026-07-10

### Fixed
- **`injection-tester` under-executed SQLi (two root causes, from a live `/pentest:sql` miss).**
  1. **Broken tool path → silent hand-rolling.** Phase 2 referenced `sqli-detect.mjs` via `../skills/…`, which
     does not resolve from the engagement CWD, so the agent silently fell back to improvised `curl` probes —
     losing the identifier-context breakouts (`":<>` / `'":<>`) and the `queryLeak` detector, which downgrades a
     full query/schema disclosure to a bare "differential". Now the agent **resolves the tool robustly** (repo
     checkout, else the newest installed cache) and running `sqli-detect.mjs` on every parameter is **MANDATORY**
     — hand-rolled probes are explicitly not a substitute. Same broken `../skills/…` path fixed for
     `param-mine.mjs` in `inventory-javascript-mapper`.
  2. **"CONFIRMED = done" bias.** A controlled differential + sqlmap failing to build an oracle is the *expected*
     outcome in an identifier/`ORDER BY`/Hibernate context — not the finish line. Added an explicit **query &
     schema disclosure escalation** (force the ORM to re-emit its generated SQL via the structural breakouts,
     read the leaked schema + tenant clause, escalate against the revealed identifiers) and a **CONFIRMED ≠ DONE**
     critical rule, so the agent pursues disclosure instead of closing at "confirmed".

### Added
- **`/pentest:crud` — standalone launcher for the AI-piloted write-crawler.** Relaunch the CRUD crawl on its own
  (like `/pentest:idor|sql|xss|ssrf`) to test it. It deploys the **`crud-exerciser` agent**, which drives the
  Playwright MCP browser intelligently (reasoning about links/forms) with **`crawl-write.mjs` as its deterministic
  backbone**, to crawl the authenticated app, discover CREATE forms, and (armed) capture the write requests +
  created `{id}`s as BOLA/injection seeds via `crud-merge.mjs`. **It runs the crawler ONLY — no recon, no planner,
  no other agent** (an earlier draft's recon-preflight made it trigger `/pentest:recon`; removed — the crawler
  self-navigates, and the agent's recon ingest is now optional). **Hard-gated by `environment` +
  `rules_of_engagement`** and **defaults to dry-run** (discover + preview, submit nothing); it submits only when
  the RoE authorizes state-change and the operator confirms. Wired into the `/pentest:recon` hand-off and the docs
  command inventory (11 → 12).

---

## [2.4.24] + playwright [0.2.5] — 2026-07-10

### Added
- **`crawl-write.mjs` — gated interactive WRITE-mode exerciser** (the deterministic backbone of the
  `crud-exerciser` agent). It drives an authenticated app, **navigates breadth-first following the links it
  finds** (create-labelled first, then any in-scope internal link, up to `--max-views`; never a logout/delete
  link), discovers CREATE forms on every page, fills each field with marker-compliant, field-typed values,
  submits, and captures the real write request (method/host/path/body) + the created object `{id}`, with a
  one-shot validation retry. It emits `crud-exercise.json` straight into
  the existing pipeline — `crud-merge.mjs` then DERIVES the `{id}`-bearing GET/PUT/DELETE BOLA corpus and the
  injection body-field seeds, so **captured writes flow into `idor-bola-tester` / `injection-tester`**.
  - **Safety:** state-mutating, so it is double-armed — default is `--dry-run` (discovers/previews, submits
    NOTHING); it submits ONLY with both `--submit` and a non-empty `--marker` (every created value carries the
    marker); it only ever clicks a form's own create/save control and NEVER a delete/remove/bulk/reset control;
    CREATE only, capped per form. Honors the operator proxy.
  - `crud-exerciser` Phase 3 now uses it as the primary path (dry-run preview → armed run), keeping the MCP
    browser only as a fallback for exotic forms (wizards, rich editors, non-`<form>` widgets).
- Test suite `crawl-write.test.mjs` (real-browser stub app): dry-run submits nothing, armed run captures the
  marker POST + created id, unmarked submit refused, destructive-only control never clicked, a deep form
  reached only via a non-create link is found and submitted while the logout link is skipped, validation retry.

### Changed
- **CI now provisions the browser** — installs the stealth-probe deps + Chromium before `node --test`, so the
  browser-driven crawler suites (`crawl`, `crawl-write`) run in CI too.

---

## [2.4.23] + playwright [0.2.4] — 2026-07-10

### Added
- **`cve-tester` — mandatory Phase 2 → Phase 3 approval gate.** It was the only exploitation agent that
  flowed straight from Experiment into running adapted public PoC code (up to RCE) with no checkpoint. It now
  carries the same `APPROVAL GATE — Phase 2 → Phase 3` block as its peers (`csrf-tester` et al.): plan-level
  approval satisfies it under `/pentest:pentest`; standalone/interactive runs stop for explicit operator
  confirmation.

### Fixed
- **`authz-matrix` (`run.mjs`) — successful empty-body writes were misclassified as `deny`.** A cross-tenant
  `DELETE`/`PUT`/`PATCH` returning `204 No Content` (or an empty-body `200`) was scored `deny` and never
  flagged — precisely the destructive BOLA/BFLA the tool exists to surface. Success is now `2xx` regardless of
  body length for write methods; the `len > 0` guard is kept only for reads (GET/HEAD).
- **`authz-matrix` — `GET`/`HEAD` requests carrying a `body` threw and were swallowed as `{status:0}`** (→ a
  hidden `deny`). A body is now attached only for non-GET/HEAD methods.
- **`authz-matrix` — malformed/missing input JSON crashed with a raw Node stack trace** instead of the
  `{ok:false}` contract its siblings honor. Input parsing is now wrapped and exits `2` with a structured error.
- **`password_generator.py` — infinite loop on single-character pools.** `_remove_repeating_chars` /
  `_remove_sequential_chars` spun forever when the replacement pool offered no valid alternative (e.g.
  `no_repeating` + heavy `disallowed_chars`). Both now bail out to a best-effort password instead of hanging.
- **`password_generator.py` — post-processing could silently drop a required class.** `no_repeating` /
  `no_sequential` could overwrite the sole guaranteed char of a required class (breaking e.g. `require_special`);
  a new `_ensure_required_classes` pass re-injects any dropped class so the returned password still satisfies policy.
- **`param-mine.mjs` — ternary values leaked phantom params.** The key regex `/([A-Za-z_]\w*)\s*:\s*/` had no
  left boundary, so `cond ? enabled : disabled` emitted `enabled` as a fake body param, bloating the fuzz
  corpus. Anchored to an object-member boundary (`{`/`,`).
- **`hooks.mjs` (playwright) — WebSocket wrapper dropped the static ready-state constants.**
  `window.WebSocket.OPEN/CONNECTING/CLOSING/CLOSED` became `undefined` after injection (breaking
  `ws.readyState === WebSocket.OPEN` and making the wrapper fingerprintable); they are now copied onto the wrapper.
- **`credential_manager.py` — same-tick ID collision could silently overwrite an account.** The credential ID
  was a hash of `target:username:timestamp` only; a random nonce (`secrets.token_hex`) is now included.

### Changed
- **`burp-import` / `crud-merge` — scope inference now uses the most-frequent host**, not `items[0]` (which in
  a host-ordered Burp export is often an out-of-scope CDN/analytics host loaded first); emits `scope_source`.
- **`burp-import` / `crud-merge` — multi-part suffix regex tightened to a 2-letter ccTLD tail** (`co.uk`,
  `ne.jp`) so `go.com`-style hosts are no longer mis-split; form-key extraction anchored to a field boundary
  (not `filename="…"`) and URL-decoded; static assets excluded from the injection/fuzz corpus.
- **`crud-merge` — cross-identity owner is now a bare identity label only** (`labelish`) so `run.mjs`'s
  `id.label === req.owner` match holds, and `create` requests are de-duplicated by a body hash.
- **`password_generator.py` — uniform `require_*` semantics.** `require_lowercase`/`require_uppercase=False`
  now EXCLUDE the class (matching `require_digits`/`require_special`) instead of keeping it in the pool; the
  four flags now behave the same way.
- **`credential_manager.py` — documented the single-writer assumption** (atomic save, but the read-modify-write
  sequence is unlocked → last-writer-wins under concurrency).
- **`domain-assessment` / `pentester-executor` — scan results now write to `outputs/{engagement}/`**, not into
  the git-tracked `syn-scan.md` reference (which is now a read-only template); `Edit` dropped from
  `domain-assessment`'s tool grant (it was only used for that write).
- **op-signature drift guard hardened** — hard-fails (instead of silently skipping) when the sibling copy is
  missing in the monorepo layout, and a **mirror guard was added on the playwright side** so drift is caught
  from both directions.
- **`stealth/package.json` — removed the inert `version`** field (the package is `private`, never published).

### Infrastructure
- **CI added** (`.github/workflows/ci.yml`) — runs the `.mjs` (`node --test`) and Python tool suites on push/PR.
- **Root `package.json`** with `test` / `test:py` / `test:all` scripts wiring up the previously
  manual-only suites.

### Tests
- **End-to-end test suites for the two densest decision engines**, which previously had none — `authz-matrix`
  (`run.test.mjs`, stub-server matrix incl. an explicit B1 empty-body-write regression guard, GET-with-body,
  access-map unauth flag, malformed-input contract) and `sqli-detect` (`sqli-detect.test.mjs`, one stub per
  class: error-based, quote-balance, boolean-blind, baseline-subtraction no-false-positive, query-disclosure,
  time-based).
- **`param-mine.test.mjs`** (mining + the ternary phantom-param guard) and **`op-signature.test.mjs`** on the
  playwright side (behaviour + reverse drift guard).
- **Python suite expanded** (15 → 22) — `require_*` exclusion, required-class survival, single-tick ID
  uniqueness, and the previously untested `CredentialManager` mutators (list/delete/cleanup/update-metadata/export).
- **49 `.mjs` tests + 22 Python tests, all green.**

### Docs
- **README (en/fr/zh): corrected drifted counts** — codeaudit "12 auditors" → **10 auditor agents across 10
  OWASP domains** (+ `code-recon` baseline + `audit-planner`); pentest "18 agents" → **19**, and the previously
  undocumented **`crud-exerciser`** agent is now listed.
- **`BUSINESS_LOGIC_DETECTION_SPEC.md` marked ✅ implemented** — the three bricks (`business-modeler`,
  `business-logic-tester` + delta oracle, orchestration wiring) and the param-level recon gap (`param-mine`)
  are shipped; the doc was still labelled "backlog / proposition".

---

## [2.4.22] + playwright [0.2.3] — 2026-07-10

### Changed
- **Extracted the duplicated operation-signature/param kernel into a canonical `op-signature.mjs`** (the last
  code-review cleanup finding). `bodySignature` / `flattenParams` / `normPath` (+ private
  `VOLATILE`/`DISC`/`skeleton`/`salient`) were copied byte-for-byte in `crawl.mjs` and `burp-import.mjs`, and
  re-implemented as `leaves()` in `crud-merge.mjs` — a silent-drift hazard: a one-sided edit would make the same
  request hash differently across recon sources and double-count in the surface-analyzer union. Now one
  canonical module (`essential-skills/op-signature/`) imported by burp-import + crud-merge, and vendored
  byte-identical for `crawl.mjs` (cross-plugin imports aren't portable across the versioned cache dirs), guarded
  by a **drift test** that fails if the two copies diverge. Behavior unchanged; all suites green.

## [2.4.21] + playwright [0.2.2] — 2026-07-10

### Fixed
- **Multi-agent code review of the branch — 9 findings fixed (7 correctness/contract, 2 hardening), + tests.**
  - **BOLA oracle silently disabled for crud-seeded requests.** `crud-merge` emitted `owner` as a descriptive
    identity string, but `run.mjs` matches `owner === identity.label`; it now emits the bare **label** (the
    `crud-exerciser` records `owner`), re-enabling the foreign-data confirmation the whole feature exists for.
  - **`burp-import` aborted the entire import on a `%` in a form-body key** — `decodeURIComponent` is now
    guarded, one malformed body no longer kills the run.
  - **`password_generator` crashed** (`IndexError` on `_RNG.choice('')`) when `disallowed_chars` emptied a
    required class — now degrades (drops the class) before the all-empty guard.
  - **Stale coverage dedup key.** `pentest.md` Step 6.7 deduped static routes by `(host, method, path)`, but
    that file now carries `methods[]`; keyed by `(host, path)` fanning `methods[]`.
  - **GET-grid variants collapsed.** `bodySignature` (crawl + burp) now folds non-volatile **query** keys, so
    GET grids with `?filterModel`/`?sortModel` no longer merge into a single variant.
  - **Express bracket path param mislabeled.** `codeaudit-leads` Rails `params[:x]` branch now uses a lookbehind
    so `req.params['x']` is classified `path` (Express), not `query`.
  - `crud-merge`: dedup `seen` updated in-loop (no in-batch duplicates); host-less actions skipped (no
    malformed `https:///…`). Default scope is now public-suffix-aware (`app.x.co.uk` → `x.co.uk`, not `co.uk`)
    in crawl + burp.
  - +regression tests across all four tools (node 25/3/2, python 15). *(The op-signature-kernel duplication —
    a cleanup finding — is left for a follow-up `op-signature.mjs` extraction.)*

## [2.4.20] — 2026-07-10

### Changed
- **Unified the `static-routes.json` schema across the two static extractors.** The `inventory-javascript-mapper`
  Phase 3.5 output now uses the **same shape as `burp-import`'s `static_routes[]`**: `methods[]` (array, was a
  singular `method:"UNKNOWN"`), plus `write`, **`base_unresolved`** (the `${base}` var Layer C couldn't resolve
  — a host-less lead), `host`, `id_params`, `bola_candidate`, and a 3-tier `confidence` (method+host → high).
  Layer C guidance aligned to the conservative base→host resolution (only unambiguous + in-scope, never a
  first-wins global map that invents wrong hosts). `inventory-surface-analyzer` now merges the static sources
  by `(host, normalized_path)`, unioning `methods[]` and carrying `write`/`base_unresolved` — so the JS-mined
  write surface (from either the js-mapper or burp-import) flows to the testers as one consistent pool.

## [2.4.19] — 2026-07-10

### Added
- **`burp-import` Layer C — capture `${base}/fragment` template-literal writes.** Layer A/B only see path
  literals that start with `/`; a huge share of the write endpoints are `x.post(\`${baseUrl}/sale-invoices\`)`
  — the literal starts with `${…}`, so they were **completely missed**. Layer C captures those fragments (with
  the Layer-B method + `{id}`), roughly **doubling the statically-known write surface** (on the real 40 MB
  export: 38→~100 write routes, 90→~180 BOLA candidates — e.g. `POST /api/documents/{id}/esign/sign`,
  `DELETE /api/v1/documents/{id}`, `PUT|DELETE /api/v1/sale-invoices/{id}/custom-documents/{id}`).
- **Conservative base→host resolution.** The `${base}` var is resolved to a host **only when it is unambiguous
  (a single URL across all bundles) AND in-scope** — minified code reuses short var names for hundreds of URLs,
  so a first-wins global map produced confidently-WRONG hosts (react.dev, w3.org, …). Ambiguous/runtime-resolved
  bases stay `base_unresolved` (a lead the js-mapper AI resolves in-context) rather than a false host; noise
  fragments (`/{param}/…` suffixes without their base) are dropped. `static_routes[]` gain `host`,
  `base_unresolved`, and a 3-tier `confidence` (method+host → high). +Layer C tests.

## [2.4.18] — 2026-07-10

### Added
- **`burp-import` Layer B — HTTP method inference for JS-mined routes.** The routes mined from JS bundles were
  all `method: UNKNOWN` (Layer A = path only), so they were indistinguishable reads-vs-writes and unroutable to
  the testers. Layer B infers the method from the **call-site** (verb call `.post(`/`.delete(`, XHR
  `.open("POST",…)`, config object `fetch(url,{method:"X"})` / `axios({method})`) and extracts `{id}` path
  params → `bola_candidate`. On the real 40 MB export this surfaced **38 write routes and 90 BOLA candidates
  statically** — e.g. `PATCH /accounts/{id}/billing-info`, `DELETE /api/v1/documents/{id}`,
  `POST /api/documents/{id}/esign/sign` — so the write attack surface is known **without exercising it** (the
  coverage backstop to `crud-exerciser`'s depth). `static_routes[]` now carry `methods[]`, `id_params[]`,
  `bola_candidate`, `write`, `confidence`; sorted writes/BOLA-first. +Layer B test assertions.

## [2.4.17] — 2026-07-10

### Added
- **`crud-exerciser` agent — authorized interactive capture of the write surface** (the missing recon piece for
  create/edit functionality). Read-only crawling and JS-bundle mining discover *paths* but not the real write
  requests — those only exist when the action is performed. This new **state-changing, hard-gated** agent drives
  create/edit forms with the operator's session (generic — it *uses the app*), capturing the real write requests
  (method/host/body) and the **created object `{id}`s** as SEEDS for the testers. It is SETUP only — it does not
  judge BOLA (`200 ≠ BOLA` stays the tester's oracle).
  - **Hard gate:** deployed by `/pentest:recon` (new Step 6b) only when `rules_of_engagement` authorizes
    state-change. Action level by `environment`: `staging`/`demo`/`dev` → create + modify; `prod`/unset →
    create-only or skip. Creates **only marker-tagged** objects, **never touches another principal's data**, and
    **leaves objects marked** for operator verification (no auto-cleanup, per `crud/created-objects.json`); audits
    every state-changing action.
  - **`crud-merge.mjs`** (deterministic, tested) turns `crud-exercise.json` into the tester seeds: the BOLA
    corpus `.pentest-authz-requests.json` (the create + the derived `{id}`-bearing GET/PUT/DELETE, owner-tagged,
    split-host absolute URLs, auth stripped for `run.mjs` identity injection) and the write-body fields into
    `param-inventory.json` for `injection-tester`. The existing `idor-bola-tester` (multi-identity oracle +
    creation playbook) consumes it unchanged — no new BOLA brick needed.
  - Docs: pentest agent count 18→19; `/pentest:recon` Step 6b; ATTACK_INDEX helper note.

## [2.4.16] — 2026-07-09

### Fixed
- **Session Freshness Gate — stop silently reusing an expired session.** `/pentest:recon` Step 3 used to
  reuse a stored `.pentest-identities.json` identity **without asking or checking it**, so an engagement could
  run "green" while actually mapping/testing **unauthenticated** (every authed endpoint 401s → false
  negatives). New `essential-skills/methodology/session-check.md` defines the gate: **show** the session,
  **probe** a witness authenticated request (vs the unauth baseline), and offer **use / refresh / replace** —
  refusing to test authenticated on a STALE session unless the operator explicitly overrides (then it's a
  recorded coverage gap). Wired into `/pentest:recon` and all four bricks (`/pentest:sql|xss|idor|ssrf`); for
  `/pentest:idor` the gate runs **per identity** (a stale identity poisons the authz matrix — a `401` reads as
  "access denied" and hides a real BOLA). Pasted sessions are now stamped with an `added` timestamp so the
  gate can show their age.

## [2.4.15] — 2026-07-09

### Added
- **`burp-import` now mines the JS bundles too — the export carries two recon sources.** Beyond the observed
  request surface, it extracts routes from the **JS bundle response bodies** (Layer-A: URL-like path literals,
  dynamic segments → `{param}`) into `static_routes[]`. The `.js` in a Burp export are captured *authenticated*,
  so this recovers API routes declared in code but never navigated (`observed_live:false`) — usually the
  highest-value undiscovered surface (many with `{param}` → IDOR/BOLA candidates). `--bundles <dir>` dumps the
  authenticated bundles for the js-mapper's deeper pass; `--no-mine-js` skips mining. On a real 40 MB export:
  234 bundles → **251 new API routes** the crawl never saw (e.g. `/api/documents/{param}/esign/sign`,
  `/api/lead/{leadId}/collateral`). `.js` are no longer lumped into the skipped-assets bucket. +1 test assertion.

## [2.4.14] — 2026-07-09

### Changed
- **`/pentest:recon` now ASKS for a Burp deep-crawl export (Step 4b).** Previously the Burp-import path was
  documented but not prompted; recon now offers "do you have a Burp Save-items XML export?" and, given a path,
  runs `burp-import.mjs` and merges the result into the inventory (still running the static bundle extraction
  as a complement). Validated on a real 40 MB authenticated export (321 items → the ag-grid data POSTs and
  their body params, in 0.2 s).

## [2.4.13] — 2026-07-09

### Added
- **`burp-import` — use an authenticated Burp deep crawl as a recon source.** New
  `essential-skills/burp-import/burp-import.mjs` parses a Burp "Save items" XML export (base64 on or off) into
  the plugin's recon inventory — `endpoints[]` grouped by `(host, method, path)`, one variant per operation
  body-signature (same URL with different `filterModel`/`sortModel` = distinct surfaces; pagination collapses),
  flattened query+body `params`, and a `param_inventory` slice that drops into `inventory/param-inventory.json`.
  An authenticated Burp crawl is often a richer *observed* surface than a headless pass (it already solved auth
  and captured real POST bodies), so this makes it a drop-in source every targeted command reuses.
  - Dedup signature mirrors `stealth/crawl.mjs`, so Burp + browser-crawl sources merge cleanly; scope is a
    host-suffix allow-list (multi-host); static assets are skipped by default (`--assets` to include them).
  - Wired into `/pentest:recon` (new Step 4b): import if available, and **complement** — still run the JS
    mapper's static bundle extraction for routes declared in JS but never navigated (which even a deep Burp
    crawl won't have hit). Proven by `burp-import.test.mjs` (2 cases).

## [2.4.12] — 2026-07-09

### Added
- **Normalizer contract validation — `codeaudit-leads.mjs` now emits `warnings[]`.** A finding missing
  `id`/`vuln_class`/`source`, a `source` without `(file:line)`, an `endpoint.in` outside the enum, or an
  `owasp` not in `Axx:YYYY` form is surfaced as a warning (findings are still processed best-effort) instead
  of being silently coerced — making the one machine-read boundary from codeaudit auditable. On a real report
  this immediately flags the findings whose prose `source` lacks a `(file:line)` resolution key. +2 tests (24).

### Fixed
- **`injection-tester` now loads `param-inventory.json` in Phase 1 recon.** Phase 2 mandates the injection
  matrix over "every parameter from `param-inventory.json`", but Phase 1 only read `api-endpoints.json` — so
  nested body params (`filterModel.keyword`, `sortModel[].colId`, `startRow`) were never enumerated by the
  agent that tests them (a silent false negative on exactly the sinks the param-inventory exists to surface).
  Phase 1 now reads `param-inventory.json` (+ `crawl-endpoints.json`) and builds the test corpus as their
  union; an empty inventory is recorded as a coverage gap, not "no params".

### Docs
- **REPORT_CONTRACT: deterministic lead→finding merge.** Documented the `endpoint` object→string flattening
  (`{method,path}` → `"METHOD /path"`, keeping `param`/`in` in evidence) and the `owasp` full-form rule, so
  the static→live merge is reproducible instead of an ad-hoc per-run transform.
- **README FR + zh-CN**: added the `/pentest:recon` and `/pentest:ssrf` command sections (were English-only).

## [2.4.11] + playwright [0.2.1] — 2026-07-09

### Changed
- **One shared session config, set up once and reused by every brick.** `/pentest:recon` now offers a direct
  **"paste a session cookie / token now"** option (writing `.pentest-identities.json`), and `/pentest:sql`,
  `/pentest:xss`, `/pentest:ssrf` read that same shared config (offering the paste path when it is missing) —
  so you configure the session once, at recon time, and every targeted test reuses it. `/pentest:idor` already
  wrote `.pentest-identities.json`; it now states it is the shared store. (Previously `/pentest:recon` only
  pointed at the `authenticating` skill, and sql/xss read auth ad hoc from `.pentest-scope.json` — inconsistent.)

### Added
- **`crawl.mjs --cookie "<Cookie>"` / `--header "K: V"`** — paste a session directly instead of exporting a
  Playwright `storageState`; applied across all in-scope hosts/frames so the app session is sent even from a
  micro-frontend origin. `/pentest:recon` forwards the pasted session to the crawler.

### Fixed
- **`--no-grid` / `--no-headless` now actually work.** `crawl.mjs` and `probe.mjs` were missing
  `allowNegative: true` on `parseArgs`, so the documented negated boolean flags errored with
  `Unknown option '--no-…'`.

## [2.4.10] — 2026-07-09

### Added
- **`/pentest:recon` — standalone reconnaissance command.** Runs the full web-application-mapping (software
  catalog, directory scan, API discovery, JS/SPA route mapping incl. the interaction-driven `crawl.mjs`
  grid capture, param mining, surface synthesis) and **stops** — no planner, no exploitation. Writes the
  reusable recon baseline (`inventory/*.json`, `analysis/attack-surface.md`, `recon/recon-manifest.json`,
  `inventory/surface-map.json`, `inventory/param-inventory.json`) that the targeted-test commands reuse via
  their recon preflight. Handles the authenticated-vs-public surface choice up front (so the data POSTs behind
  login are actually mapped). This makes "run recon once, then unit-test each brick" a first-class workflow.
- **`/pentest:ssrf` — targeted SSRF launcher**, completing the per-brick unit-test set
  (`/pentest:sql|xss|idor|ssrf`). Deploys `pentester-executor` specialized for SSRF with a URL/host/param
  recon preflight and OAST as the primary blind-confirmation channel; enforces the "a 200 is not SSRF"
  verdict bar (server-issued callback / internal-metadata response / deny-vs-fetch differential).
- Docs: `CLAUDE.md` command count 9→11, and README command reference updated with both commands (the intended
  loop — `/pentest:recon` once, then `sql → xss → idor → ssrf` against that baseline).

## [2.4.9] + playwright [0.2.0] — 2026-07-09

### Added
- **`playwright/stealth/crawl.mjs` — interaction-driven recon crawler that fixes the "missed POST" gap.**
  A link/GET-only crawler and the `@playwright/mcp` `browser_network_requests()` summary both miss the data
  XHR/fetch traffic of modern SPAs (server-side ag-grid / datatables that fetch rows by POST with the grid
  state in the body). The new harness:
  - **Interaction-driven** — clicks in-scope SPA router-links (not `goto`) and exercises grids (scroll → load
    blocks, sort, filter, expand groups) so render-time POSTs actually fire.
  - **Body-level, all-frames capture** — context-level capture of every method WITH request bodies, on the
    main frame and iframes (fixes the frame-drop that lost micro-frontend traffic — `probe.mjs`'s in-page hook
    only ever read the top frame).
  - **Operation-signature dedup** — same URL with different `filterModel`/`sortModel`/`rowGroupCols` bodies is
    kept as distinct variants; volatile paging (`startRow`/`offset`/…) collapses, so a grid yields real test
    surfaces instead of one URL-deduped endpoint or 500 pagination dupes.
  - **Multi-host scope** — keeps any request whose TARGET host is in scope even when the page Origin is a
    different host/TLD (`--scope` is a domain-suffix allow-list, not the page origin). Carries an authenticated
    session via `--state` (Playwright storageState) so data POSTs don't 401 and get dropped.
  - Emits `crawl-endpoints.json` (endpoints grouped by host/method/path, one variant per body signature, with
    bodies + frames + flattened params) plus a `param_inventory` slice that drops into `param-inventory.json`.
  - Proven end-to-end by `crawl.test.mjs` (local ag-grid-SSRM fixture): 1 URL-deduped endpoint → 4 distinct
    operation variants, pagination collapsed, bodies captured, iframe request seen.
- `newStealthContext` gained additive `storageState` / `viewport` options (auth session + real viewport).

### Changed
- **`inventory-javascript-mapper` Phase 3 now routes server-side grids through `crawl.mjs`.** New step 1c
  documents that `browser_network_requests()` does not return POST bodies or iframe traffic, and mandates the
  owned crawl harness for grid views — merging its variant-level endpoints + `param_inventory` into the
  inventory so the previously-missed POST surfaces reach injection/BOLA testing.

## [2.4.8] — 2026-07-09

### Docs
- **INSTALL.md now says 64 attack categories** (was a stale 63) — matches the READMEs, `plugin.json`,
  `marketplace.json`, `SKILL.md`, and `ATTACK_INDEX.md`.
- **All three READMEs now describe both plugins above the fold.** The tagline and badges advertised only the
  pentest framework (18 agents / 64 categories), rendering the namesake white-box `codeaudit` plugin
  invisible on a repo literally called `claude-whitebox`. Broadened the EN/FR/zh-CN taglines to "white-box
  source-code audit + black-box penetration testing" and added `codeaudit` badges (12 auditors / 10 OWASP
  domains) alongside the pentest ones.
- **Reconciled the "Essential Skills (4)" count with the 5 on-disk subdirs.** The `64` per-domain breakdown
  still sums correctly (Essential Skills = the 4 attack-relevant helpers); `SKILL.md` and `ATTACK_INDEX.md`
  now note explicitly that `codeaudit-handoff` and `playwright-automation` are non-attack helpers excluded
  from the 64, so the headline count is verifiable against the tree.

## [2.4.7] + codeaudit [0.1.5] — 2026-07-09

### Fixed
- **Unified the generic-executor / planner agent IDs to kebab-case (dispatch consistency).** The two agents
  shipped a spaced Title-Case frontmatter `name:` (`Pentester Executor` / `Pentester Orchestrator`) while the
  filenames, the 28 other agents, and ~77 references (incl. `.pentest-attacks.json`, the Skill Coordinator
  Map, and the deployment-plan schema instruction) used kebab `pentester-executor` / `pentester-orchestrator`
  — an id that matched no registered agent. Renamed both frontmatter names to kebab and converted every
  remaining spaced reference across 8 files (H1 titles kept Title-Case, per the `xss-tester` convention), so
  a single identifier now flows config → coordinator map → deployment-plan `agent` → `Task` dispatch.
- **Fixed recon-inventory path drift in the targeted-test commands.** `/pentest:idor`, `/pentest:sql`, and
  `/pentest:xss` told the preflight to infer coverage from `outputs/{engagement}/recon/inventory/*.json`, but
  the inventory agents write to `outputs/{engagement}/inventory/*.json` (recon-manifest.json stays under
  `recon/`). The fallback globbed a never-populated directory and always concluded "no inventory", forcing
  needless re-recon. Corrected to `inventory/*.json`.
- **codeaudit 0.1.4→0.1.5 — `audit-planner` description no longer advertises "time allocation"**, which the
  audit workflow explicitly does not use ("completeness, not budget — no timer"). Now "in what order, by
  sink density", aligned with the completeness model.

### Added
- **Playwright-MCP browser-driver preflight (`pentest.md` Step 6.2).** The seven client-side agents depend on
  the `playwright` plugin's `mcp__plugin_playwright_playwright__*` tools, a dependency stated only in prose.
  The engagement preflight now verifies the MCP is reachable and, if not, warns loudly, sets
  `playwright_active=false`, and records a coverage gap — so a missing browser driver fails loud instead of
  silently degrading DOM/stored-XSS, CSP, prototype-pollution, and JS-route mapping to curl-only.

## [2.4.6] — 2026-07-09

### Fixed
- **`authenticating` Python tools hardened — 9 code-review findings + a stdlib test suite.**
  `password_generator.py`:
  - **CSPRNG.** All password material now comes from `secrets.SystemRandom()` (os.urandom-backed), not the
    predictable Mersenne-Twister `random` module — this is account-credential generation.
  - **`'character'` no longer forces a special char.** The hint scan matched the bare substring `'character'`,
    present in almost every "N characters" length hint, so it set `require_special=True` unconditionally and
    broke signup on sites that forbid specials. Now matches `special char` / `symbol` / `punctuation`.
  - **Length is clamped and validated.** An incoherent hint (min parsed above max) no longer overshoots max;
    a requested length shorter than the required character classes now raises `ValueError` instead of
    silently emitting a longer password (negative `remaining` → empty range).
  - **Consistent defaults.** `analyze_requirements` now defaults `require_upper/lower/digits` to `True`,
    matching `generate()`'s fallbacks and the convenience wrapper (was `False`, so the two paths disagreed).

  `credential_manager.py`:
  - **Atomic, private writes.** Saves go through `mkstemp` (created `0600` before any plaintext) + `os.replace`
    — closing the world-readable window of the old "open 'w' then chmod" and making writes crash-safe.
  - **Corrupt store is preserved, not silently wiped.** A JSON-decode error used to return `{}`, so the next
    save truncated real data; now the bad file is renamed `.corrupt` and a `ValueError` is raised.
  - **Reads no longer rewrite the file.** `get_credential` gained `mark_used=False` (opt-in) so a pure
    read/export stops rewriting the plaintext store on every lookup, and it now returns a `deepcopy` rather
    than a live alias into the in-memory store.
  - **`.gitignore` anchored to the store's own directory** (was always the CWD) and skipped outside a git
    work tree, so the ignore rule protects the real path and unrelated dirs aren't littered.
  - **Timezone-aware timestamps** via a `_utcnow()` helper (deprecated naive `datetime.utcnow()` removed).
  - Added `test_auth_tools.py` (stdlib `unittest`, 14 cases) covering every fix above.

## [2.4.5] — 2026-07-09

### Fixed
- **NoSQLi auth-bypass no longer confirmed on a bare HTTP 200.** `injection-tester`'s Phase-2 rule was
  "HTTP 200 with successful login response → NoSQLi confirmed", but many login APIs return 200 with an error
  body on failed auth. Now requires a **3-way differential** — wrong-creds baseline vs operator injection vs
  valid-creds baseline — confirming only when the injection yields the SAME authenticated artifact
  (`Set-Cookie` session / JWT / 302 into the app) as valid creds that the wrong-creds baseline does NOT.
  Pulls the Phase-4 `'token' in r.text` bar forward into the confirmation language.
- **Handoff correlator (voie B) now tolerates all three `params` shapes.** Recon producers emit `params`
  three ways — flat name array `["id"]` (surface-map / web-app), object array `[{name,in,sample}]`
  (param-inventory), and object keyed by location `{"path":["id"],"query":["fields"]}` (api-endpoints).
  `codeaudit-leads.mjs`'s `correlate` only handled the flat array: the object array made every `String(x)`
  become `"[object Object]"` (silent no-match) and the location-keyed object **threw** (dropped the finding
  to `malformed`). A new `paramNames()` normalizes any shape to a flat name list before matching. +4
  regression tests (22 total, all passing).

### Docs
- **`surface-map.json` is now a first-class recon contract (Format 6 in `RECONNAISSANCE_OUTPUT.md`).** It was
  the single most load-bearing recon artifact for the white-box→black-box handoff (`--surface`) and the Step
  6.7 coverage math, yet its schema lived only in the `inventory-surface-analyzer` prompt. Added its full
  shape plus a `params`-shapes reconciliation table (canonical = the `[{name,in,sample}]` object array;
  surface-map flattens to names by design) so producers and consumers code against one documented contract.

## [2.4.4] — 2026-07-09

### Fixed
- **XSS/CMDi detection discipline — closed four false-positive/negative gaps where the codified PoC or probe
  contradicted the repo's own "confirm, don't assume" rule.**
  - **XSS reflected PoC no longer confirms on substring reflection (false positive).** `xss-tester`'s `poc.py`
    asserted only `'onerror=alert' in r.text` — a safely HTML-encoded reflection (`&lt;img … onerror=alert…&gt;`)
    still contains that substring and was reported `VULNERABLE`. The PoC now asserts the payload reflects
    **UN-encoded** in an executable context (raw markup present AND its `html.escape()` form absent); a new
    Critical Rule states an encoded reflection is `tested_not_vulnerable`, with the Playwright console-alert +
    screenshot as ground truth.
  - **CMDi no longer confirmed on a single un-baselined timing (false-positive RCE).** Both the Phase-2 probe
    and `poc.py` required only one ~5s response (jitter / slow backend fake it). They now require a
    **baselined, scaling differential** — `sleep 0` control vs `sleep 5` stable over repeats, and `sleep 10`
    tracking ~2×. A bare time-blip with no scaling and no OAST hit is `probable`, not `confirmed`; the Critical
    Rule and the OAST/DNS callback (preferred, deterministic) are aligned to this.
  - **CMDi OOB probe now uses the real OAST payload.** The Phase-2 out-of-band probe referenced an undefined
    `BURP_COLLABORATOR_HOST` (dead since the OAST integration); it now allocates a unique `$PAYLOAD` from the
    OAST pool and correlates the callback in `oast/interactions.jsonl`.
  - **DOM-XSS curl-on-fragment check removed (false negative).** A `curl "…/#<img …>"` can never observe the
    payload — the `#…` fragment is not sent to the server. Replaced with the Playwright
    `browser_navigate(#payload)` + `browser_console_messages()` path.

## [2.4.3] — 2026-07-09

### Fixed
- **Hybrid handoff normalizer (`codeaudit-leads.mjs`) hardened — 4 review findings + the mandated e2e test.**
  The report is `UNTRUSTED DATA`; these close the gaps where a malformed or free-text report could crash the
  handoff or fabricate a misleading lead.
  - **No longer crashes on a bad `findings[]` element.** A `null` / non-object entry (hand-edited, truncated,
    trailing comma) used to throw an uncaught `TypeError` and produce **no** `exploitation-leads.json` at all —
    every valid lead in the same report was lost. Now such an element is skipped and counted in
    `totals.malformed` (never a silent drop), and the whole per-finding body is wrapped so one bad finding is
    counted, never fatal — the `{ok:true}` + leads contract always holds.
  - **No phantom `externally_reachable` leads.** The loose free-text fallback that grabs a trailing identifier
    from any `source` string is now flagged `low_confidence` and **no longer implies reachability** — only a
    resolved endpoint, a recognized framework accessor, or a whole-object binding does. Garbage/prose `source`
    text can no longer be promoted to a high-priority exploitation target.
  - **`in` enum honored on every field.** The top-level `lead.in` is now passed through `canonIn()` (was raw),
    and the fallback returns `in: null` instead of the out-of-enum string `'unknown'` — the lead's `in` is now
    always `query|path|header|cookie|json|form` or `null`, consistent with `endpoint.in`.
  - **`body.<field>` / `data.<field>` sources now parse as `json`.** code-recon's own "feeds" shorthand
    (e.g. `body.url`) previously fell through to the fallback and lost its injection location; two `\b`-guarded
    patterns now map it to `in: json` (the `\b` protects `formData.` / `metadata.`).
- **Added the end-to-end fixture test mandated by `HYBRID_HANDOFF_SPEC.md` §8 ("leçon SQLi").**
  `codeaudit-leads.test.mjs` (zero-dep, Node 18+, `node --test`) runs the real normalizer as a subprocess over
  synthetic reports: voie A / voie B resolution, per-framework accessor parsing, whole-object binding,
  non-routable classes, and a regression case for each of the four fixes above. 18 cases, all passing.

## [2.4.2] + codeaudit [0.1.4] — 2026-07-08

### Fixed
- **Hybrid handoff, final review pass.**
  - **Deliverability:** bumped **pentest 2.4.1→2.4.2** — the shared normalizer (`codeaudit-leads.mjs`) lives
    in the pentest plugin, so a codeaudit-only bump would not re-cache it on `/plugin marketplace update`.
  - **`in` enum enforced on output:** a resolved `endpoint.in` is now constrained to
    `query|path|header|cookie|json|form` (`unknown` no longer escapes into it; falls back to `query`).
  - **Fewer mislabels:** Spring `@RequestHeader` → `header` (was grouped as `path`); Rails `params[:x]`
    defaults to `query`, with `:id`-shaped names → `path` (was blanket `path`).
  - **codeaudit 0.1.3→0.1.4 — resolution made robust:** Step 6.6's endpoint match now keys on the source
    `file:line` (from the `source` string, not the sink `location`), omits on ambiguous/dynamic matches, and
    the `source` field rule now **requires** the `(file:line)` so the resolution key always exists.

## codeaudit [0.1.3] — 2026-07-08

### Fixed
- **Voie A now actually produces `endpoint` (was orphaned in 0.1.2).** The `endpoint`-resolution instruction
  lived only in the report contract, which the finding-authoring path never reached. Wired it to the real
  actors: `entry_points[]` is now a **required** code-recon output (with a completion check), and the
  **Step 6.6 aggregator** — the single writer of `codeaudit-report.json` `findings[]` — now reads
  `entry_points` and resolves each request-reachable finding's `endpoint` (matching the source name+file:line
  → entry point; `in`/`method`/`path` taken from it), adding `endpoint` to its field checklist. `OUTPUT_STRUCTURE`
  and the description.md template updated to carry `endpoint` + the source `in`.
- **Unified the `in` vocabulary** across code-recon, the report contract, and the pentest normalizer to the
  fixed enum `query|path|header|cookie|json|form` (was `body` on the codeaudit side vs `json` on the pentest
  side — same source yielded different `in` under voie A vs voie B). Pentest normalizer: Rails `params[:id]`
  → `path`; a codeaudit-resolved `endpoint` now implies `externally_reachable` (a live-routed finding is no
  longer buried when its source string can't be parsed).

## codeaudit [0.1.2] — 2026-07-08

### Added
- **Hybrid handoff, voie A — codeaudit now resolves the live endpoint per finding.** `code-recon` emits an
  `entry_points[]` route↔source map in `sink-inventory.json` (method + path + handler + each source's
  `{in, name, at}`), and the `codeaudit-report.json` finding schema gains an optional
  `endpoint { method, path, param, in }`, resolved from that map by matching the finding's `source` (omitted
  when routing is dynamic). The pentest hybrid handoff consumes it directly
  (`endpoint_resolution:"codeaudit"`) → far fewer `unresolved` leads; falls back to param correlation
  (voie B) when absent. See `plugins/pentest/docs/HYBRID_HANDOFF_SPEC.md`.

## [2.4.1] — 2026-07-08

### Fixed
- **Hardened the hybrid-handoff normalizer (code-review driven, re-verified end-to-end).**
  - `codeaudit-leads.mjs` `source` parser now handles **bracket notation** (`req.headers['x-api-key']`,
    `request.args['id']`), **whole-object bindings** (`req.body` → mass-assignment/deser, no garbage token),
    **Spring attribute forms** (`@RequestParam(value="q")` → `q`, not `value`), and **paren-less locations**
    (no longer captures a line number as the param).
  - Correlation now falls back to the **leaf** of a dotted param (`filter.keyword` → `keyword`), so nested
    body params resolve against the flat surface-map params.
  - `externally_reachable` is computed conservatively, and **non-request-reachable classes**
    (secrets/crypto/deps/config/logging) are segregated under `non_routable` instead of being stamped
    reachable and promoted as top-priority leads.
  - `commands/pentest.md`: fixed the business-modeler dispatch path (was still the phantom `codeaudit/`
    dir) and corrected the Step 6.3.4 data-flow note (the modeler reads the codeaudit report directly for a
    different extraction than the leads). `pentester-orchestrator.md`: a lead is routed only with a resolved
    endpoint; a reachable-but-unresolved lead is a coverage gap, not a blind deployment.

## [2.4.0] — 2026-07-08

### Added
- **Hybrid handoff — feed a `codeaudit` white-box report into `/pentest:pentest` as prioritized
  exploitation leads (MVP, voie B).** A new sub-phase **6.3.4** (hybrid mode, triggered when
  `outputs/{engagement}/codeaudit-report.json` or `--codeaudit <path>` is present) runs a deterministic
  normalizer (`codeaudit-handoff/codeaudit-leads.mjs`) that turns codeaudit findings into
  `analysis/exploitation-leads.json`: it parses the HTTP param/context from each finding's `source`, uses
  codeaudit's `endpoint` when present or correlates the param against the surface map, and ranks
  externally-reachable/high-confidence/resolved leads first. The `pentester-orchestrator` plans those leads
  **first** and passes each finding's `code_evidence` (source→sink, file:line, `slot_type`,
  `witness_payload`) to the matching executor as a **`code_hint`** for targeted (not blind) payload
  crafting. The report gains hybrid `provenance` (`static-only | live-only | both-confirmed`); a
  code-confirmed lead that can't be reproduced live stays `probable` + coverage gap, never
  `tested_not_vulnerable`. **Guardrail:** leads ADD to, never narrow, the black-box recon. Spec:
  `docs/HYBRID_HANDOFF_SPEC.md`. (Voie A — codeaudit emitting per-finding endpoints — is a follow-up.)

### Fixed
- **`business-modeler` codeaudit path** — pointed the white-box enrichment at the real
  `codeaudit-report.json` + `recon/` outputs instead of the non-existent `outputs/{engagement}/codeaudit/`
  directory.

## [2.3.2] — 2026-07-08

### Fixed
- **Made the 2.3.1 SQLi additions actually work and stop crying wolf (code-review driven, verified end-to-end).**
  - `sqli-detect` can now reach **nested / array JSON params**: pass the captured body as a `--body` template
    and target a path with `--param` (`rowGroupCols[0].id`). Previously `buildReq` built a flat single-key
    body, so the marquee ag-grid identifier vector was unreachable.
  - **Baseline subtraction** for the `error-based` and `query-disclosure` signals (same discipline as the
    quote/boolean/numeric signals): a DB error or SQL-looking snippet already present on the baseline is a
    property of the endpoint, not the parameter, and no longer fires — kills false positives on benign HTML
    (`<select>…</select>`, "from … where" prose) and on always-500 endpoints.
  - Tightened ORM error signatures to **error-shaped** patterns (not bare package names), tightened the
    query-disclosure regex to a real statement/Hibernate-alias shape, and bounded regex input.
  - Added a real **`structural-breakout`** differential signal (a breakout payload that changes a stable
    baseline) and a structured **`leaked_query`** output field feeding exploitation.
  - Reconciled the `injection-tester` reporting rule with Phase 4: a DB/ORM-error finding's `poc.py` asserts
    the reproducible error/disclosure (a valid executable PoC), so it is reportable without data extraction.

## [2.3.1] — 2026-07-08

### Changed
- **SQLi detection now catches ORM-wrapped errors and identifier-context injection.** `sqli-detect` gained
  (1) ORM/framework error signatures — Hibernate/JPA `SQLGrammarException` / `could not extract ResultSet`,
  Spring `BadSqlGrammarException`, JDBC, Django, Rails — so a database error wrapped by the ORM is no longer
  missed; (2) **structural / identifier-context breakout** probes (`":<>`, `'":<>`, `"}`, backtick) that
  reach column / `GROUP BY` / `ORDER BY` fields (e.g. ag-grid `rowGroupCols`/`sortModel`) which value-context
  quotes cannot; (3) **query-disclosure** detection — an error body echoing a generated SQL statement
  (Hibernate prints the query) is flagged as a high signal and CWE-209 disclosure.
- **A reachable DB/ORM error is never `tested_not_vulnerable`.** `injection-tester` and `REPORT_CONTRACT`
  now require any recognized DBMS/ORM error or query-disclosure to be reported as at least an
  informational/`probable` finding + coverage gap, even when sqlmap and manual value-context payloads fail —
  automated exploitation failure ≠ not vulnerable, and a leaked query reveals the columns to craft the
  injection.

## [2.3.0] — 2026-07-07

Business-logic detection, out-of-band confirmation, parameter-level recon, and adaptive authorization
testing. Headline: a whole class of logic flaws that endpoint-level testing structurally misses (no
injectable sink, a valid-looking `200` on every request) is now modeled and tested; blind vulnerabilities
are confirmable via a self-hosted OAST collaborator; recon inventories request parameters (not just
endpoints) so injection sinks on known endpoints are no longer missed; and a multi-identity authorization
engine adds first-class IDOR/BOLA/BFLA coverage. Also: a dedicated stealth Playwright MCP plugin, targeted
single-scope launchers, and a full SQLi detection matrix. (Bundled `codeaudit` plugin bumped to **0.1.1** —
auditor dispatch now runs **every planned wave**, not just wave 1.)

### Added
- **Dedicated business-logic detection.** Two new agents split modeling from exploitation. `business-modeler`
  is a read-only black-box modeler that explores the app (interaction-driven), extracts the rules it *appears*
  to enforce from observable signals only (client-enforced constraints, the cross-identity differential, the
  app's own rejection messages — never domain knowledge or code), and emits candidate invariants
  (`invariants.json`). `business-logic-tester` reads those invariants and, per-invariant (not per-endpoint),
  generates abuse cases from a domain-generic taxonomy, executes **stateful** multi-step sequences, and
  confirms each finding with a **state-delta oracle** (before/after — a `200` is never proof). Covers
  plan/role gating, workflow skip/replay, numeric/temporal/quota abuse, and idempotency/race hand-off, with a
  Phase 2→3 write gate. `business-modeler` runs after `inventory-surface-analyzer` and before the planner; in
  white-box/hybrid mode it also ingests `codeaudit` `code-recon` output. `business-logic-tester` is deployed by
  the `common-appsec-patterns` coordinator.
- **OAST (out-of-band) blind-vulnerability confirmation.** A new `oast` skill and `/pentest:pentest-oast`
  connect command drive a self-hosted [interactsh](https://github.com/projectdiscovery/interactsh) collaborator
  server. The command runs a live self-test (register → trigger → correlate) and writes `.pentest-oast.json`;
  a single long-lived client registers once, mints a payload pool, and streams decrypted interactions for the
  whole engagement. The `injection`, `xss`, `cve`, and `pentester-executor` agents allocate unique payloads and
  correlate callback hits to deterministically confirm blind SSRF, blind/OOB SQLi, blind OS-command injection,
  stored/blind XSS, XXE OOB, and Log4Shell-class RCE. OAST is optional — if unconfigured, agents skip OOB
  testing and record it as a coverage gap rather than fabricating findings. DNS/HTTP callbacks are preferred;
  HTTPS capture is best-effort.
- **Parameter-level reconnaissance (`param-mine`).** A new `essential-skills/param-mine` tool + wiring inventory
  request *parameters*, not just endpoints, so injection sinks on already-known endpoints aren't missed
  (post-mortem keystone). Paired with param-driven routing — every parameterized endpoint is now treated as an
  injection candidate — and an exhaustive crawl that sweeps HTTP methods, nested params, and interaction depth.
- **Adaptive multi-identity authorization testing.** A new `idor-bola-tester` agent and the deterministic
  `authz-matrix` cross-identity replay engine cover IDOR/BOLA (API1), BFLA (API5), and BOPLA/mass-assignment
  (API3) with an adaptive oracle (0/1/2/N accounts) and a strict `200 ≠ BOLA` verification bar. Adds an
  `access-map` mode for per-identity reach diffing (BFLA/missing-auth triage) and a `/pentest:idor` targeted
  launcher. Operator-authored `.pentest-identities.json` / `.pentest-authz-requests.json` root files supply
  sessions and the request corpus.
- **Targeted single-scope launchers.** `/pentest:xss` and `/pentest:sql` deploy the `xss-tester` /
  `injection-tester` agent directly against one scope (no full engagement), each with a capability-aware recon
  preflight that maps SPA routes so client-only views aren't missed.
- **Full SQLi detection matrix (`sqli-detect`).** Quote-balance, boolean, numeric, error-based, and time-based
  detection with anti-false-positive checks.
- **Dedicated stealth Playwright MCP plugin.** A standalone `playwright` plugin ships the MCP server with
  stealth-friendly defaults (real Chrome channel, headed, realistic UA/viewport, anti-automation flags) plus an
  Option B full-stealth standalone probe for WAF-gated testing. It is a dependency of the pentest plugin's
  client-side agents.
- **Provider-specific cloud references** for AWS, Azure, GCP, Docker, and Kubernetes.

### Changed
- **Quantified-coverage honesty gate in the report.** The report step now mandates quantified coverage and
  fails honesty checks that would let a run claim more surface than it actually tested.
- **Model-tiered agents** — recon agents and the `codeaudit` deps/secrets auditors are tiered to lighter models
  for cost/latency; injection finding IDs aligned across pentest/codeaudit.
- **Phase 2→3 approval gate extended to the dedicated testers** (not just the general executor).

### Fixed
- Engagement directories the pipeline actually uses are now created up front.
- Playwright MCP server start failure (`-32000` — `initScript` must be a file path) resolved; stealth /
  bot-detection guidance corrected and de-siloed.
- Path-traversal / LFI false negatives from shallow depth and split params fixed via an overshoot/depth-sweep
  rule.

---

## [2.2.6] — 2026-06-08

Engagement-driven improvement pass. Headline: a re-architecture so the multi-agent design actually
runs (orchestration could not delegate), a time-budget that is spent rather than merely capped, and a
fixed deliverable contract. Also: pre-flight reachability, coverage-gap escalation, launch-time
deliverable-format selection, inline Kali-server connect, false-positive mitigation, and a scope-
question UX cleanup.

### Fixed
- **Orchestration no longer collapses to a single generalist agent.** This harness allows only one
  level of subagent nesting, so the `pentester-orchestrator` — dispatched as a subagent — could not
  call `Task`/`AskUserQuestion` and silently fell back to one agent improvising the whole engagement
  via raw HTTP, with the specialized executors never running. **Re-architected:** the
  `pentester-orchestrator` is now a **planner** that reads scope + recon and writes
  `plan/deployment-plan.json` + `plan/test-plan.md`, and the `/pentest:pentest` command (running in
  the main session, which genuinely has `Task`) now owns dispatch — it deploys recon agents, invokes
  the planner, presents the plan, deploys the specialized executor agents in parallel, aggregates, and
  reports. The multi-agent design now actually runs.

### Added
- **Time-budget quota loop.** The command captures a start timestamp and parses the timing value into
  a budget treated as a **quota to spend, not a ceiling to stay under**. It checkpoints at ~50% and,
  while budget remains and the surface is not exhausted, dispatches escalation waves (authenticated
  re-test, vulnerability chaining, tool-confirming unconfirmed findings, broader payloads, and
  post-exploitation only when MKS is active + a CVE/RCE finding is confirmed). Finishing early now
  requires a logged `surface-exhausted` justification rather than being the default.
- **Pre-flight reachability check.** Before deploying anything, the command does a liveness +
  fingerprint request and aborts early with an actionable message if the target is down.
- **Coverage-gap escalation.** Suspected-but-unconfirmed findings (e.g. a DOM-XSS the first pass could
  not browser-confirm) are flagged in the plan with a `confirmation_tool` and get a dedicated
  escalation attempt with the right tool (Playwright) when budget remains — they are no longer left as
  footnotes.
- **`docs/reference/REPORT_CONTRACT.md` — a fixed deliverable contract.** Defines the
  `pentest-report.json` schema (engagement metadata, `findings[]` with confidence/status/owasp,
  summary counts, `tested_not_vulnerable`, `coverage_gaps`, `de_scoped_for_time`, `time_budget`), the
  **required** consolidated `report.md` template, a consistent severity rubric, and the OWASP Top-10
  (2021) mapping. Two runs now produce structurally identical deliverable sets; a run is incomplete
  without `report.md`.
- **Thoroughness ↔ time reconciliation.** The planner reconciles requested thoroughness against the
  time quota in the plan (breadth-first when tight) and records `effective_thoroughness` +
  `de_scoped_for_time`, so the report never claims "Full" while delivering "Medium".
- **Launch-time deliverable-format selection.** A multi-select question lets the operator request
  extra artifacts on top of the always-produced `report.md` + `pentest-report.json`: executive
  summary, remediation plan, CSV findings table, and PDF/DOCX renders. Stored as `output_formats` in
  `.pentest-scope.json`; the report step produces exactly those. PDF/DOCX render via pandoc and
  degrade gracefully to markdown with a warning if pandoc is unavailable.
- **Inline Kali-server (MKS) connect.** When no MKS is configured, `/pentest:pentest` now offers to
  connect one inline (URL prompt + `/health` check + writes `.pentest-mks.json`) instead of telling
  the operator to run `/pentest:pentest-kali` and relaunch.
- **False-positive mitigation.** The aggregation step runs a verification + de-duplication pass:
  findings on the same vuln-class/endpoint/parameter are merged, and a finding may only be labelled
  `confirmed` with reproducible evidence (executed PoC or deterministic request/response) — weaker
  signals are downgraded to `probable`/`unconfirmed` and surfaced as coverage gaps.
- **MKS resilience to a broken Kali server.** The plugin no longer trusts the server's `/health`
  verdict (some builds run their internal `which` probe as an argv list, which crashes and
  under-reports every tool as missing even when installed). Tool availability is now re-verified
  through the unaffected `/api/command` string endpoint, and the `mks` skill probes capability once and
  routes tool calls through `/api/command` when the structured `/api/tools/*` endpoints are broken —
  with a documented shell-injection caveat for that path. Connecting an MKS no longer falsely reports
  installed tools as missing, and engagements keep working against an affected server.

### Changed
- **Scope questions.** Target, engagement name, out-of-scope, time budget, and auth are now collected
  as free-text prompts (no canned `localhost`-style options that never fit real targets). Time is a
  single "time budget" quota field; thoroughness and deliverable formats are multiple choice. Applies
  to both `/pentest:pentest` and `/pentest:pentest-scope`. The `.pentest-scope.json` schema uses a
  single `timing` field plus a new `output_formats` array (legacy `window` is read for backward
  compatibility when present).
- `commands/pentest.md` — Step 6 ("Orchestrator Handoff") replaced by Step 6.1–6.7
  (Init → Pre-flight → Recon → Planning → Approval+Dispatch → Quota loop → Aggregate+Report).
  `allowed-tools` gains `TaskOutput`, `Bash`, `Glob`, `Grep` so the command can timestamp, monitor,
  aggregate, and write deliverables.
- `agents/pentester-orchestrator.md` — rewritten from coordinator to planner; `tools` reduced to
  `[Read, Write, Bash, Glob, Grep]` (removed the non-functional `Task`/`TaskOutput`/`AskUserQuestion`);
  added the deployment-plan schema, the thoroughness/time reconciliation rules, and a prominent
  explanation of the nesting constraint.
- `docs/WORKFLOWS.md`, `docs/CLAUDE.md`, `docs/reference/OUTPUT_STRUCTURE.md`, and
  `docs/reference/TEST_PLAN_FORMAT.md` updated to the command-owns-orchestration / orchestrator-as-planner
  model and to point at `REPORT_CONTRACT.md`.
- `skills/mks/SKILL.md` — added a capability probe, a layered fallback (structured → `/api/command` →
  local Bash), per-tool `/api/command` command strings, and `which`-based tool verification.
  `commands/pentest-kali.md` and the inline MKS connect in `commands/pentest.md` re-verify `/health`
  "missing" verdicts via `/api/command`.

### Version
- `plugin.json` and `marketplace.json` bumped to 2.2.6

---

## [2.2.5] — 2026-06-07

Third audit pass — full file-by-file read of every agent, skill, reference doc, and config.

### Fixes
- **Test-plan template** (`TEST_PLAN_FORMAT.md`) — replaced the fictional executor roster ("SQL Injection Executor", "XSS Executor", "Auth Bypass Executor", …) with the real agents (`injection-tester`, `xss-tester`, `csrf-tester`, `csp-bypass-tester`, `prototype-pollution-tester`, and `Pentester Executor` for the rest). This template feeds the plan the orchestrator presents to the operator
- **Reconnaissance output spec** (`RECONNAISSANCE_OUTPUT.md`) — rewritten to document the layout agents actually produce (`inventory/*.json` + `analysis/*.md`) instead of a `reconnaissance/assets/*.json` + `reconnaissance_report.md` layout no agent ever wrote; the main `pentest` skill's Phase 2/3 recon references were updated to match
- **Output-filename collision** — `domain-assessment` now writes `analysis/domain-attack-surface.md` and `analysis/domain-testing-checklist.md`, so it no longer overwrites the `inventory-surface-analyzer` files of the same name in full-scope engagements
- **csrf-tester** read the wrong recon file (`analysis/surface-analysis.md`); corrected to `analysis/attack-surface.md`
- **PATT_STANDARD.md** pointed at a nonexistent build-time path (`docs/superpowers/plans/…`); now points at the `patt-fetcher` agent's URL Map
- **password_generator.py** — type hints corrected from the builtin `any` to `typing.Any`
- **credential_manager.py** — class docstring corrected to state credentials are stored as plaintext JSON (gitignored, chmod 600) for disposable test accounts, rather than implying encrypted "secure storage"
- **pentester-executor.md** — the "Specializations" section no longer lists fictional separate agents ("SQL Injection Executor", "XSS Executor", …); it now describes the real model (one prompt-specialized `Pentester Executor` per attack type, with dedicated testers for common client-side/injection attacks)
- **Phase-6 packaging docs** — removed the stale `reconnaissance_report.md` (a file no agent produces) from `OUTPUT_STRUCTURE.md` and the main `pentest` skill, and aligned the `processed/reconnaissance/inventory/` example filenames to the real agent outputs (`subdomains.json`, `directories.json`, `api-endpoints.json`, …)
- **Stale methodology index** — `essential-skills/methodology/README.md` was a 1,067-line index of the project's old flat structure, with ~36 links to deleted/renamed files (`cross-site-scripting.md`, `network-attacks.md`, `wireless-attacks.md`, every `*-portswigger-labs-complete.md` / `*-resources.md`, etc.). Replaced with a concise, accurate methodology hub pointing to the real `attacks/<category>/` folders
- **Broken cross-references** — repointed 22 dead "see `X-portswigger-labs-complete.md` / `X-resources.md`" links across 14 attack-content files (web-application-attacks, burp-suite, oauth, csrf, cors, clickjacking, web-llm, cache-poisoning, command-injection, host-header) to the real sibling quickstart/cheat-sheet in each folder
- **Final link validation** — a project-wide check of every `[]()` markdown link caught 7 more stale same-directory links in `web-application-attacks.md` (`./sql-injection.md`, `./csrf-quickstart.md`, `./ssrf-*.md`, `./xxe-*.md`) now repointed to the real category folders, plus an agent reference to a non-existent payload file (`injection-tester` → `nosql-injection/payloads/bypass.md`, corrected to `mongodb.md`). **Zero broken markdown links or file references remain anywhere in the plugin** (verified programmatically)

### Version
- `plugin.json` and `marketplace.json` bumped to 2.2.5

---

## [2.2.4] — 2026-06-07

Second audit pass — full re-audit of every command, agent, skill, reference doc, and the README.

### Fixes
- **Install command** — README corrected to `/plugin install pentest@claude-whitebox`. The plugin is named `pentest`, so the previous `claude-whitebox@claude-whitebox` would not resolve and blocked new installs
- **Attack-category counts** standardized to **63 categories across 11 domains** in `plugin.json`, `marketplace.json`, the README, the main `pentest` skill, `ATTACK_INDEX.md`, and the orchestrator. Three figures had disagreed — "100+" (inflated), "9 categories/50+" (undercount that miscounted its own list), and "63". Also fixed the README's offsetting per-domain errors (injection was missing `file-inclusion`; ip-infrastructure wrongly counted the non-attack `reference/` folder)
- **Fictional agent mappings** in `ATTACK_INDEX.md` replaced — "SQL Injection Discovery Agent", "XSS Discovery Agent", "SSRF Discovery Agent", etc. now name the real agents (`injection-tester`, `xss-tester`, `csrf-tester`, `csp-bypass-tester`, `prototype-pollution-tester`, `pentester-executor`, `authenticating` skill)
- **Ghost slash-commands removed** — the `pentest` skill's "Integration" list (`/authenticating`, `/ai-threat-testing`, …) is now a "Related Skills" list of real skill names (no leading slash), with the nonexistent `/ai-threat-testing` noted as web-LLM content under API Security; the `authenticating` skill's "Commands" section and its README's fabricated `require('.claude/skills/authenticating')` programmatic API were replaced with an accurate "this is a skill, not a slash command or library" description
- **Stale branding** — removed "Transilience Community Security Tools" / "Transilience AI" references from the README (ownership is `Stickman230`, MIT)
- **Coordinator output blurbs** — `common-appsec-patterns` and `cve-testing` "Key outputs" listed nonexistent `reports/`, top-level `evidence/`, and `raw/exploits/` folders; aligned to the real live layout (`findings/finding-NNN/` with `evidence/` inside, `activity/` logs, root `pentest-report.json`)
- **Phase-6 report contents** — the main `pentest` skill's "Report folder contents" bullet omitted the primary `.docx` deliverable, contradicting its own diagram; reconciled to docx (+ optional pdf), json, README, appendix
- **Coordinator boilerplate** — removed the false "You only have read permissions on this current directory" line from all four skill coordinators (they delegate via the Task tool)
- **Per-attack file structure** — `ATTACK_INDEX.md` claimed each attack folder has `definition.md`/`methodology.md` (which do not exist); corrected to the actual `*-quickstart.md`, `*-cheat-sheet.md`, and `payloads/`

### Version
- `plugin.json` and `marketplace.json` bumped to 2.2.4

---

## [2.2.3] — 2026-06-06

Corrective pass — fixes broken connections, removes ghost components, and re-syncs documentation with the real architecture.

### Fixed
- `pentester-orchestrator` now declares `AskUserQuestion` in its tools list — its mandatory operator gates (Phase 0 scope, Phase 2 plan approval, Phase 4 findings confirmation) could not fire without it
- `.pentest-attacks.json` now carries a real `status` field: `/pentest:pentest-attacks` writes `status: "pending"` and `/pentest:pentest` sets it to `"active"` on use, mirroring `.pentest-scope.json`. Previously `/pentest:pentest-exit` reset a field that was never written and the README documented a non-existent field
- Broken `/OUTPUT.md` references corrected to `docs/reference/OUTPUT_STRUCTURE.md` in `web-application-mapping`, `domain-assessment`, and `cve-testing` skill coordinators (only `common-appsec-patterns` had been fixed in 2.2.2)
- Dead `/AGENTS.md` reference removed from `common-appsec-patterns`
- `pentest-attacks.md` confirmation text corrected — executors deploy during Phase 3 (Testing), not Phase 4 (Aggregate)
- Skill coordinators no longer point agents at the wrong `.claude/agents` path

### Changed
- `pentester-executor` — removed the ghost "Tools Framework" section and the `tools/{tool}/config.json` rule that referenced a non-existent `tools/` directory; MKS/Kali wiring left untouched
- `pentester-orchestrator` Delegation Pattern and Agent Selection now use real agent names (`injection-tester`, `xss-tester`, `csrf-tester`, `Pentester Executor`) instead of the fictional "SQL Injection Executor" / "XSS Executor" subagent types
- `docs/CLAUDE.md` rewritten to reflect the real architecture — 15 agents, 7 skills, 5 commands (previously claimed "3 agents" and linked a non-existent `PLANNING_WORKFLOW.md`)
- `docs/WORKFLOWS.md` rewritten to the current 0–6 engagement lifecycle (scope, MKS check, recon, plan + approval, testing, aggregate, conditional post-exploitation, report) with timing/thoroughness/attack-profile inputs and real agent names
- Both `OUTPUT_STRUCTURE.md` files now cross-reference each other with scope notes clarifying they describe sequential stages (live working layout → Phase 6 deliverable packaging), not competing schemas
- Removed non-existent OWASP ZAP integration references from `web-application-mapping`; documented only the tools actually used (ffuf, gobuster, nikto, dirsearch, feroxbuster)
- Dropped residual "bug bounty hunting" framing from the marketplace description and the `pentest` / `pentester-orchestrator` trigger lines

### Version
- `plugin.json` and `marketplace.json` aligned to 2.2.3 (were stale at 2.0.0)

---

## [2.2.2] — 2026-06-06

### Added
- `/pentest:pentest` now checks for a configured Kali server (`.pentest-mks.json`) before launching (new Step 4 — Kali Server Check)
  - If MKS is active: displays server URL and tool availability (nmap, gobuster, dirb, nikto, sqlmap, hydra, john, metasploit); asks "Use MKS tools / Skip MKS"
  - If MKS is not configured: prints a hint to run `/pentest:pentest-kali` and continues without it
  - `mks_active` and `mks_url` are propagated to the orchestrator handoff; orchestrator is instructed to skip Phase 0b (no redundant re-read)
  - When MKS is inactive, orchestrator is explicitly told not to activate Phase 5 post-exploitation
  - Engagement summary now shows `Kali Server:` row
  - Step numbering updated: Summary is now Step 5, Orchestrator Handoff is Step 6

### Changed
- `/pentest:pentest-exit` Step 6 (formerly "Scope Reset") is now "Scope and Attacks Reset" — also resets `.pentest-attacks.json` to `status: "pending"` on session close, mirroring the existing scope reset behaviour

### Fixed
- Broken reference `/OUTPUT.md` in `skills/common-appsec-patterns/SKILL.md` corrected to `docs/reference/OUTPUT_STRUCTURE.md`
- `reports/` output entry in `skills/common-appsec-patterns/SKILL.md` corrected — removed "bug bounty submissions" (non-existent output type); kept "Executive, technical reports"

### Removed
- HackerOne Hunter section from `docs/WORKFLOWS.md` — documented a `hackerone.md` agent that does not exist; orphaned ghost feature
- Bug Bounty visual workflow diagram from `docs/WORKFLOWS.md`
- `hackerone.md` dead reference from `docs/WORKFLOWS.md` Reference footer
- Empty `agents/reference/` directory — unreferenced scaffolding

### Documentation
- `README.md` brought up to date with the current architecture
  - Slash Commands section rewritten to document all five commands (`/pentest:pentest`, `/pentest:pentest-scope`, `/pentest:pentest-attacks`, `/pentest:pentest-kali`, `/pentest:pentest-exit`) — previously only two were documented
  - `/pentest:pentest` flow updated to reflect the current 7-step sequence including scope check, attack profile check, Kali server check, 7 scope fields, and correct step numbering
  - `/pentest:pentest-exit` flow updated to include the scope and attacks reset step
  - Added **Session State Files** section documenting `.pentest-scope.json`, `.pentest-attacks.json`, and `.pentest-mks.json`
  - Engagement Lifecycle diagram updated: added Phase 0b (MKS check) and Phase 5 (post-exploitation, conditional on MKS + RCE); added explanatory prose for conditional phases
  - Repository structure updated: added `docs/CLAUDE.md`, `docs/WORKFLOWS.md`, and `skills/mks/`; removed stale version annotation from `plugin.json` entry
  - Quick Start section updated to recommend `/pentest:pentest` as the entry point

---

## [2.2.1] — 2026-06-06

### Added
- **Timing field** on scope — max execution time for the pentest itself (not including report generation). Collected as Q6 in both `/pentest:pentest-scope` and `/pentest:pentest` new-scope flow.
  - Free-text input (e.g., `2h`, `8h`, `unlimited`)
  - Persisted to `.pentest-scope.json` as `"timing"`
  - Displayed in all scope/summary blocks and passed to orchestrator
  - Orchestrator instruction: stop active testing when the limit is reached and move directly to report
- **Thoroughness field** on scope — depth of testing. Collected as Q7 in both commands via a 4-option select.
  - **Light** — automated scans only, minimal payload set (top 5-10 per attack type), stop at first confirmed finding per category
  - **Medium** — standard coverage, common payloads + manual probing on interesting endpoints, one follow-up round (default/recommended)
  - **Deep** — extended payload sets, edge cases, multi-step attack chains, vulnerability escalation and chaining
  - **Full** — exhaustive testing, all payloads and techniques, all attack chains, informational findings documented, maximum coverage up to the time limit
  - Persisted to `.pentest-scope.json` as `"thoroughness"`
  - Displayed in all scope/summary blocks
  - Thoroughness guidance injected into the orchestrator handoff instruction so every deployed executor respects the selected depth

### Changed
- `pentest-scope.md` Step 1 now extracts `existing_timing` and `existing_thoroughness`; Step 2 displays both in the EXISTING SCOPE FOUND block; Step 3 collects Q6 (timing text) and Q7 (thoroughness select) after Q5; Step 5 JSON includes both fields; Step 6 confirmation block shows both fields
- `pentest.md` Step 2 extracts `timing` and `thoroughness` from pre-defined scope; PRE-DEFINED SCOPE FOUND block shows both; "Use pre-defined scope" path sets `Q6_answer` and `Q7_answer`; new-scope path adds Q6 and Q7 questions; JSON write includes both fields; Step 4 ENGAGEMENT SUMMARY shows Timing and Thoroughness rows; Step 5 orchestrator instruction includes max execution time and per-level thoroughness guidance

---

## [2.2.0] — 2026-06-05

### Added
- `/pentest:pentest-attacks` slash command — define which attack categories and skills the orchestrator should use for an engagement. Saves to `.pentest-attacks.json`. Does not launch a pentest.
  - **Mode selection**: Full suite / Web application profile / API & cloud profile / Custom
  - **Web app preset**: injection, client-side, server-side, authentication, API security, business logic
  - **API & cloud preset**: API security, cloud & containers, IP infrastructure, CVE testing, domain recon
  - **Custom mode**: 3 multi-select questions covering all 12 attack categories; each selection maps to the correct skill and executor(s)
  - If an existing profile is found, offers update or keep
  - Full skill/executor mapping embedded for consistent JSON output

### Changed
- `/pentest:pentest` now checks for `.pentest-attacks.json` after scope collection (new Step 3)
  - If a profile exists: shows it and asks "Use this profile / Run full suite"
  - If no profile exists: asks inline mode selection (Full / Web app / API & cloud / Custom)
  - If "Custom" is chosen inline: stops the launch and instructs the user to run `/pentest:pentest-attacks` first (scope is already saved, so re-launching picks it up)
  - Attack mode is injected into the orchestrator handoff instruction — the orchestrator restricts executor deployment to the listed categories
  - Engagement summary now shows the `Attacks:` field
  - Step numbering updated: Summary is now Step 4, Orchestrator Handoff is Step 5

---

## [2.1.0] — 2026-06-05

### Added
- `/pentest:pentest-scope` slash command — define or update engagement scope without launching a pentest. Saves scope to `.pentest-scope.json`. Can be run before or during an active engagement.
  - If run with no existing scope: collects 5 scope fields and saves with `status: pending`
  - If run with an existing scope: shows current scope and offers update or cancel
  - If run during an active engagement with a target change: detects drastic vs minor changes
    - **Drastic change** (different domain or IP subnet): warns operator, offers update-anyway / save-as-pending / cancel
    - **Minor change** (same target, different restrictions/window/auth): updates scope silently with confirmation

### Changed
- `/pentest:pentest` now checks for a pre-defined scope file (`.pentest-scope.json`) before collecting scope
  - If pre-defined scope exists: displays it and asks "Use pre-defined scope / Enter new scope"
  - If pre-defined scope is used: skips all 5 scope questions and marks scope status as `active`
  - If no pre-defined scope or user opts for new scope: runs full 5-question collection as before, and saves the collected scope to `.pentest-scope.json` with `status: active`
  - `Read` added to allowed-tools in `pentest.md`

---

## [2.0.0] — 2026-03-16

### Added
- `/pentest:pentest` slash command — guided scope collection, session isolation, automatic orchestrator handoff at Phase 1
- `/pentest:pentest-exit` slash command — dual-schema findings probe (Schema A + B), severity-bucketed summary, isolation lift instruction
- Slash Commands section added to README
- Target-Type Routing table in `pentester-orchestrator` — routes web apps, APIs, cloud, network, and full-scope engagements to the correct skill coordinator
- Engagement Lifecycle flowchart in `pentester-orchestrator`
- Mandatory approval gate between Phase 2 (Experiment) and Phase 3 (Test) in `pentester-executor`
- Phase 0 mount-skill block in `pentester-executor`
- AV-safe reverse shell payload cheatsheet using component notation for PHP entries
- AV-safe file-inclusion payload files (wrappers, RFI, LFI) using component notation
- `CONTRIBUTING.md` and `SECURITY.md`

### Changed
- PHP literal code blocks in `file-upload-quickstart.md` and `file-upload-cheat-sheet.md` replaced with component notation to avoid Microsoft Defender signatures
- `pentester-executor` Critical Rules tightened — phases boundaries, approval gate enforced
- Phase headings standardised to H2 across all 12 executor/inventory agents
- Activity log paths corrected in `domain-assessment` agent
- `domain-assessment` tool declaration fixed
- Reduced token cost: removed repeated boilerplate `## When to Use` sections and duplicate Critical Rules bullets from 11 agents
- `inventory-surface-analyzer` When to Use section trimmed; orchestrator duplicate bullet removed; executor Phase 0 prose shortened
- Plugin install commands corrected in README

### Removed
- 53 dead-weight reference files from `skills/pentest/attacks/` (PortSwigger lab indexes, generic resource lists) — no actionable attack content, significant token cost

### Fixed
- `Task` tool added to `pentest.md` allowed-tools so orchestrator handoff executes correctly (CMD-03)
- `pentest-exit.md` now probes both output schemas before reading findings (CMD-04)
- `marketplace.json` name, schema URL, and owner fields corrected
- Invalid `agents` and `skills` declarations removed from `plugin.json`

---

## [1.0.0] — 2026-03-15

### Added
- `pentester-orchestrator` — coordinates full engagements: recon → plan → user approval → executor deployment → aggregation → report
- `pentester-executor` — general executor with 30+ attack specialisations following a 4-phase workflow
- `xss-tester` — reflected, stored, DOM-based XSS; framework sinks (React/Vue/Angular); WAF evasion; Playwright evidence capture
- `csrf-tester` — missing tokens, SameSite bypass, token reuse, method override; browser-loadable PoC HTML output
- `injection-tester` — SQLi, NoSQLi, OS command injection; sqlmap automation + manual curl probing
- `csp-bypass-tester` — CSP header analysis; unsafe-inline, wildcard sources, JSONP, Angular sandbox, open-redirect bypass vectors
- `prototype-pollution-tester` — URL params, hash fragments, JSON body; `Object.prototype` pollution verified in browser DOM
- `cve-tester` — tech stack fingerprinting, NVD/Exploit-DB/GitHub CVE research, PoC adaptation, live exploitability validation
- `domain-assessment` — subdomain discovery (subfinder, amass, crt.sh), port scanning (nmap, masscan), service enumeration
- `inventory-software-catalog` — SBOM generation with CVE flagging
- `inventory-directory-scanner` — active brute-forcing with ffuf, gobuster, feroxbuster, nikto, dirsearch
- `inventory-api-discovery` — REST, GraphQL, WebSocket, Swagger/OpenAPI/Postman discovery
- `inventory-javascript-mapper` — SPA route extraction via headless Playwright; React Router, Vue Router, Angular routes
- `inventory-surface-analyzer` — synthesises all 4 inventory agent outputs into a unified risk-tiered attack surface report
- `patt-fetcher` — on-demand PATT payload fetching (Haiku model for token efficiency)
- `common-appsec-patterns` skill coordinator — routes to xss-tester, csrf-tester, injection-tester, csp-bypass-tester, prototype-pollution-tester
- `web-application-mapping` skill coordinator — routes to all 5 inventory agents
- `cve-testing` skill coordinator
- `domain-assessment` skill coordinator
- `authenticating` skill coordinator — signup/login automation, 2FA/OTP bypass, CAPTCHA evasion, credential management tools
- `pentest` main skill — attack index covering 11 domains, 63 sub-categories; methodology frameworks (PTES, OWASP WSTG, MITRE ATT&CK)
- Attack knowledge base: injection (8), client-side (6), server-side (6), authentication (4), API security (4), web applications (9), cloud/containers (5), system/post-exploitation (8), IP infrastructure (9), physical/social engineering (1), essential skills (3)
- Curated PATT payload files per attack category (`payloads/` subdirectories, <200 lines each)
- `OUTPUT_STRUCTURE.md` and `TEST_PLAN_FORMAT.md` reference docs
- `WORKFLOWS.md` — complete planning & approval workflow with visual diagrams
- `CLAUDE.md` — agent architecture overview for the docs directory
- Structured engagement output layout: `outputs/{engagement}/activity/`, `findings/`, `inventory/`, `analysis/`, `pentest-report.json`
- `.gitignore` excluding `.claude/` and generated `outputs/`
- `marketplace.json` — Transilience Community Security Tools marketplace listing
- `plugin.json` — plugin metadata (MIT, author Stickman230)
- README with architecture diagram, engagement lifecycle, agent tables, attack coverage, and install instructions

---

## [0.1.0] — 2026-03-14

- Initial commit — empty repository scaffold
