# Resource Exhaustion & Availability Reference

Detection knowledge for the `resource-exhaustion-auditor` (OWASP **A04 Insecure Design** — uncontrolled
resource consumption). This class distinguishes a **source-reviewable availability vulnerability** from a
generic performance issue. A finding requires an **input→cost path**, a **missing effective bound**, and
**impact on another user, a shared service, a safety function, or operator-owned spend** — self-limiting
work in the requester's own process is not a service vulnerability. The plugin exploitability bar applies:
a bare "no rate limit" with no reachable shared impact is `informational`/hardening, not a vulnerability.

**Do not validate by stressing anything.** No live/shared stress, saturation, or cost-generation tests.
Reason from the code: **asymptotic analysis** of the accepted input, **bounded local fixtures** with strict
CPU/memory/time limits, mocked paid calls, and deterministic cancellation checks. A curve you can argue
from the source, not a load test.

## Core discipline

- A **missing rate limit is not enough.** Before calling a path unbounded, check body/message/file size
  caps, concurrency limits, queue bounds, deadlines/timeouts, DB constraints, upstream gateway limits, and
  per-tenant quotas. If any effective bound exists on the path, it is `safe` (or hardening at most).
- State, for each finding: **attacker cost**, **service work**, **persistence**, **scope** (self / tenant /
  process / whole service), and **recovery**. One bounded input with superlinear or persistent shared
  effect is materially worse than "sustained volume" (which is just capacity planning).
- Build an **input→resource table**: earliest accepted size/cardinality, work done **before auth**,
  downstream fan-out, persistence, the shared pool touched, the limit/cleanup owner, and recovery.

## Attack classes

### Superlinear parsing / matching / evaluation (ReDoS et al.)
Small accepted input drives catastrophic cost: **regex backtracking** (`(a+)+`, nested quantifiers,
alternation with overlap on user-supplied patterns *or* user input against a vulnerable pattern), recursive
descent parsing, recursive validation/schema expansion, symbolic evaluation, graph traversal, template
expansion, adversarial sort/hash (hash-flooding). Derive the accepted depth/cardinality and the complexity
class, then argue the growth curve. Grep: `re.compile`/`new RegExp`/`.match(`/`.test(` on request values,
recursive functions over user structures, `JSON.parse`→deep-walk, user-supplied regex.

### Decompression & representation amplification
Compressed / sparse / nested / aliased / encoded input expands far beyond the checked transfer or file
size: **zip/gzip bombs**, deeply nested JSON/XML (billion-laughs — coordinate with `injection`/XXE),
image/font decode blow-up, protocol compression tables. **Verify the limit is enforced after each
expansion**, not only on the compressed bytes. Grep: `unzip`/`gunzip`/`zlib`/`inflate`/`extractall`/
`tarfile`/image-decode without a decompressed-size cap.

### Database & downstream query amplification
A small request creates broad scans, pathological joins, fan-out, unbounded sort/aggregation, or many
downstream calls because query depth, filter cardinality, pagination, or expansion fields are not bounded
(GraphQL nested queries, `include`/`expand` params, `IN (…)` from a user list, N+1 in a loop over user
input). Confirm authorization does not intentionally permit that resource scope.

### Unbounded buffering & cardinality
Bodies, out-of-order streams, uploads, sessions, **unique cache keys**, **metrics labels**, log fields,
subscriptions, or pending jobs accumulate without per-item **and** aggregate limits (ten thousand valid
1-byte items evade a per-message cap while exhausting tenant/process state). Find cleanup/expiry on
disconnect, timeout, cancellation, and partial parse.

### Descriptor / handle / temp-resource leaks
Malformed or canceled work misses cleanup and retains sockets, files, DB cursors, timers, subprocesses,
temp files, or object refs. Show the leak repeats across bounded iterations and hits a **shared** pool.
Grep: `open(`/`connect(`/`spawn(` without a matching close in the error/cancel path, missing
`finally`/`defer`/`with`.

### Detached work after cancellation
Client timeout, disconnect, canceled job, or failed authorization returns control but leaves DB, model,
network, or worker work running. Trace **cancellation and deadline propagation** through every layer
(context/AbortController/CancellationToken not passed down).

### Pre-authentication work imbalance
Expensive parsing, key lookup, cryptography, decompression, or external requests happen **before**
authentication and the earliest size/rate gate. Compare minimal requester effort to shared service cost.

### Quota-accounting scope & reset gaps
Accounting keys on an attacker-influenceable dimension (IP, route, tenant, key prefix, task id) so one
principal escapes its budget or consumes another's. Review integer overflow, distributed races, retries,
reconnects, account switching.

### Worker / pool / priority starvation
Low-priority or attacker-controlled jobs hold shared locks, workers, DB pools, event-loop turns, or
scheduler priority needed by unrelated users. Require a path that bypasses queue/concurrency fairness or
retains a slot beyond its deadline.

### Reachable fatal error or deadlock
Untrusted input reaches `panic`/abort/fatal assertion/unhandled exception/process-exit/lock-cycle/infinite
loop in a **shared** process. Confirm supervisor scope: does one worker die or the whole service? A
restarted isolated worker reduces impact but does not erase the defect.

### Retry storm / fail-open amplification & poison records
Timeouts, dependency errors, partial messages, or health-check failures trigger synchronized/unbounded
retries without jitter, ceiling, circuit-breaking, or dedup; or one malformed record repeatedly fails at
the **front** of a shared queue/partition/startup-scan/migration (head-of-line blocking). Verify one
bounded failure creates persistent aggregate work.

## Verdict criteria

`vulnerable` when you can name an untrusted input, the requester work, the **service amplification or
retained resource**, the **shared** blast radius, and the (missing/weak) bound — and argue the cost curve
or leak from source, confirming no source-visible upstream/parser/queue/tenant/framework bound already
prevents it. `safe` when an effective bound (size cap, concurrency limit, timeout, per-tenant quota,
streaming with backpressure) is present on the path. Downgrade to `probable`/coverage-gap when the deciding
fact is an **unobserved deployed control** (upstream gateway cap, autoscaling, paid quota, supervisor
isolation) — do not assert missing infrastructure behavior. Use `high/probable/unconfirmed`. Prioritize by
low requester work, **unauthenticated** reachability, cross-tenant scope, persistence, and poor recovery.

Map to **A04 Insecure Design** (`cwe`: CWE-400 uncontrolled-resource-consumption, CWE-770
allocation-without-limits, CWE-1333 ReDoS, CWE-409 decompression-bomb, CWE-834 excessive-iteration,
CWE-405 asymmetric-resource).

## False-positive discipline

- **Missing limits without concrete shared impact are hardening**, not findings — a request that only slows
  the requester's own response is not a service vulnerability.
- Do not strengthen a crash into RCE, ordinary work into shared availability loss, or a single-worker
  restart into whole-service outage. Report the observed effect, not the feared one.
- A per-request cap that exists but seems generous is `safe` unless you can show the aggregate/cross-tenant
  path around it. Verify framework/server defaults (body-size limits, timeouts) before flagging.
- Never validate with availability impact — asymptotic/source argument or a **bounded** local fixture only.
