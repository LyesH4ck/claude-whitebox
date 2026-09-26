# Business Logic & Trust-Boundary Reference — hunt the rules by hand

Mounted by the **business-logic-auditor** (OWASP **A04 Insecure Design**). Scanners cannot find these — there
is no dangerous API to grep for. You reason about **what the workflow is supposed to guarantee** and whether
the code actually enforces it. High-impact, low-noise: every finding names a concrete invariant and the state
it lets an attacker reach.

- **Work from a concrete invariant, not a payload.** Name (1) the lower-trust principal + starting capability,
  (2) the accepted value / action / state transition it submits, (3) the control that *should* reject/bind/
  limit/revoke it, (4) the exact code path after that decision, (5) the smallest wrong state it reaches.
- **A 2xx/302 is never proof.** The evidence is the reachable **invalid state** in the code (a negative balance,
  a skipped step, a replayed one-time action), shown by reading the state transitions — corroborate live only
  in hybrid mode with a before/after state delta.
- **Exploitability bar.** A logic finding needs a demonstrated invalid state or a boundary another component
  relies on being broken — not "this looks fragile."

## Core discipline — sad paths, parallel paths, cross-component

For each major workflow (checkout, transfer, invite, approval, provisioning, quota, publish):

1. **Test the sad paths and disagreements.** Feed each accepted field its hostile values *where the interface
   accepts them*: absent, empty, zero, **negative**, maximum, over-limit, duplicate, mixed-encoding, stale,
   revoked, reordered, concurrent, partially-migrated, failed-dependency, rollback. Compare canonicalization and
   **units** at every parser/policy handoff.
2. **Enumerate parallel paths to the same effect.** The effective rule is the **weakest** path, not the polished
   UI: direct API, batch/bulk, import, admin, legacy, retry, webhook, GraphQL mutation. If one path enforces the
   rule and a sibling doesn’t, that sibling is the bug.
3. **Diff cross-component guarantees.** Component A validates and hands to B — compare exactly what A *guarantees*
   against what B *assumes*: truncation, type coercion, normalization, tenant scope, rounding. The gap is the bug.

## Attack classes

**State-machine violations**
Can you **skip** a required step, go **backwards**, reach an **invalid state**, or **replay** a completed flow?
On partial failure (step 2 of 3 fails), is step 1 **rolled back**? Read the state field and every transition
that writes it. **vulnerable**: an order ships because `status` can jump `cart → shipped` without `paid`; a
one-time coupon/token re-applies because completion isn’t recorded atomically.

**Race conditions with business impact (TOCTOU)**
Concurrent operations that check-then-act **non-atomically** produce invalid states: double-spend,
double-approve, double-withdraw, lost update, over-redeem. Seeds: a read/validate followed by a separate write
with no transaction, row lock, `SELECT … FOR UPDATE`, atomic decrement, or idempotency key.
`rg -n 'balance|credit|quantity|stock|redeem|approve|withdraw|transfer'` then check the check→act window.
**safe**: a single atomic conditional update (`UPDATE … SET bal = bal - :amt WHERE bal >= :amt`).

**Numeric / quantity manipulation**
Negative, zero, overflow, precision loss, and **string↔number coercion**. A negative quantity that credits
instead of debits; a huge value that overflows; `"1e10"`/`"0x10"`/float rounding that changes the charged
amount. Check the value is range-checked *and* type-checked before it hits arithmetic or a ledger.

**Access-boundary violations (the right check for the rule)**
Not "does a permission check exist" but "is it the **right** check for the business rule?" Can input to one
operation bypass a restriction enforced on a **different** operation with the same effect? (Hand off pure
authz/IDOR to the access-control-auditor; keep the *logic* variant: e.g. a discount cap enforced on `apply`
but not on `bulk-apply`.)

**Time-based logic**
Expiry checks, scheduling, rate windows, clock skew. What happens at the **exact boundary** moment? On
**timezone** differences between components? A token valid because `exp` is compared with the wrong clock; a
promo redeemable one tick after expiry; a rate window that resets on a client-supplied timestamp.

**Default & fallback behavior**
The security posture when **config is missing, a feature flag is off, a dependency is unavailable, or the
system is mid-migration**. `rg -n 'getenv|feature_flag|isEnabled|fallback|default|try/except|rescue'` — read
the failure branch. **vulnerable**: auth or a limit that **fails open** when its backing service errors.

**Chained vulnerabilities & trust boundaries** (individually-contained behavior that composes into a break)
- *Multi-step boundary failures* — map what a low-privilege principal may read/write/invoke/retain, then connect
  **only concrete outputs** to later trust decisions. Confirm each prerequisite; do not assume the downstream
  effect.
- *Cross-component trust gaps* — A validates and passes to B; compare A’s exact guarantee with B’s assumption
  (truncation, coercion, normalization, tenant scope, plugin/extension access).
- *Second-order use* — data safe **when stored** becomes dangerous in a later context: a field name becomes a
  JSON path, a slug becomes a file path, escaped text enters raw rendering, a stored string becomes a URL,
  regex, template, or policy expression. (Exhibit **both** ends: the writer and the later consumer.)
- *Scope/capability growth* — a token, API key, OAuth grant, plugin, or delegated task becomes **broader** after
  refresh, caching, role change, or composition. Name the concrete operation the resulting principal shouldn’t
  have.
- *Rollback & recovery* — undelete, restore, revision rollback, and cancellation must re-apply **current**
  ownership, validation, and authorization. Name which invalid state is restored.

## Verdict criteria

`vulnerable` when a source-confirmed path lets a lower-trust principal reach an **invalid business state** or a
downstream component **relies on a guarantee the upstream doesn’t make**, with the concrete adverse outcome
named (money, data integrity, availability of a shared resource, another user’s state). `safe` when the
invariant is enforced atomically on **every** parallel path. Downgrade to `probable` when a sibling path or a
transaction boundary wasn’t fully read; `unconfirmed` (→ coverage gap) when you suspect but can’t exhibit the
reachable invalid state.

- **high** — double-spend/double-approve, workflow-skip on a money/integrity path, fail-open auth on a
  reachable failure branch. **medium** — a bounded numeric/time abuse with limited blast radius.

## False-positive discipline

- **Intended authority is not a finding.** A principal doing exactly what it’s allowed to do — even oddly — is
  not a logic bug. The break is a state/effect it should *not* be able to reach.
- **A guard on a sibling variable/path does not protect this one.** Follow the actual field into the actual
  transition; control-flow proximity ≠ enforcement.
- **Prove the atomicity gap.** A check-then-act is only a race if there’s no transaction/lock/atomic op *and* a
  realistic concurrent trigger. Read the DB/ORM call before claiming it.
- **Second-order needs both ends.** Do not flag a stored value as dangerous without exhibiting the later sink
  that consumes it unsafely.
