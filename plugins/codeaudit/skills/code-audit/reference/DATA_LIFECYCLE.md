# Data Isolation & Lifecycle Reference

Follow **one data item** through every copy and state transition, and prove a principal can read or mutate
it outside their scope.

Mounted by the `data-lifecycle-auditor`. The core principle: **a tenant/owner FIELD on a record is not
isolation** — you must find the query, key, path, or policy that *enforces* it on **each read and write
path**. Sanitized primary data can become unsafe in a derived copy (search, cache, analytics, export,
preview, log, replica, backup) with different ACL and retention rules. The verdict is derived from the code.
The plugin **exploitability bar** applies. Map to **OWASP A01:2021 Broken Access Control**.

## Method

Pick one protected record and draw its full lineage:

```
primary write → query → cache → index/search → event/queue → export → backup → deletion → restore
```

Mark the **principal** and **tenant** at every edge. The effective policy is the **weakest parallel path**,
not the most polished endpoint. Start at the paths that commonly omit request-scoped identity:
**bypass/`unscoped` clients, background jobs, migrations, global uniqueness constraints, and cache keys.**
Compare two dummy tenants through the same code path, then repeat the trace after an ACL change, a deletion,
and a restore.

## Attack classes

### Missing tenant / owner enforcement
A read/update/delete/list/count/bulk query identifies an object **without binding it to the authenticated
tenant/owner**, or trusts a body field to supply that identity. `rg -n -i 'findById|find_one|\.get\(|
get_object_or_404|WHERE id\s*=|filter\(id=' {scope}` → check each for an owner/tenant predicate.
**Vulnerable** when direct lookup, a nested relationship, an admin/import/legacy path, or a background job
loads by id with no `AND owner_id = :principal` / policy check. **Safe** when every access path binds the
authenticated principal at the query layer.

### Composite-key & namespace collision
Cache keys, object storage paths, search document IDs, temp files, or dedup keys **omit tenant/environment**,
so two principals resolve the same logical key. `rg -n -i 'cache\.(get|set)|redis|s3|key\s*=|f"|`+"`"+`.*:.*`+"`"+`'`
around identity building. **Vulnerable** when a key is built from an object id without a tenant/env
component. **Safe** when every shared-namespace key is tenant-scoped.

### Policy vs query disagreement
Row-level policy, ORM default scopes, authorization filters, and raw/bypass clients apply **different
predicates**. Check joins, aggregates, aliases, views, transactions, `unscoped`/service clients, and error
paths where the tenant context is missing. **Vulnerable** when one path (a raw query, a report aggregate, a
service client) drops the predicate the interactive endpoint enforces.

### Blob & signed-reference overreach
Object keys, attachment IDs, version IDs, shared links, or signed URLs permit operations or namespaces
**beyond the issuing principal's access**, or stay valid **after the underlying ACL changes**. **Vulnerable**
when a signed reference is not bound to operation + exact object/version + audience + expiry + tenant, or is
not revoked on ACL change. **Safe** when every binding is present and re-checked.

### Search / cache / index ACL drift
A primary record's ACL or lifecycle changes **without invalidating** a searchable, cached, embedded,
thumbnail, RSS, preview, or index copy. **Vulnerable** when authorization is applied only at ingestion, not
at **retrieval**, or invalidation misses a derived store. **Safe** when the derived read re-filters by
current ACL.

### Export / import scope expansion
Export includes tenants/fields/soft-deleted/history above the requester; import/restore bypasses owner/
schema/ACL/uniqueness or recreates records in a tenant the requester cannot write. **Vulnerable** without
per-item authz **after selection** and authorization of the final artifact / resulting write. (The
`feature-abuse` class owns the feature framing; here own the **tenant-lineage** angle.)

### Migration default & ownership confusion
Old records lack tenant/ACL/lifecycle fields; incompatible IDs collide; a partial rollout makes new and old
readers apply **different defaults**. Review backfill, dual-read/write, compatibility, rollback, and
resumed-migration paths. **Vulnerable** when a migration default grants broader visibility than the current
policy, or an ID collision merges two tenants' rows.

### Soft-delete / tombstone bypass
Direct lookup, search, relation traversal, background processor, or restore **ignores the lifecycle
predicate** and returns or acts on a deleted/revoked record. `rg -n -i 'deleted_at|is_deleted|soft.?delete|
tombstone|status\s*=\s*.deleted' {scope}`. **Vulnerable** when a parallel path omits the `deleted_at IS NULL`
predicate, or a deleted identifier can be **re-registered** before all references are gone. **Safe** when
every read path applies the lifecycle filter.

### Stale authorization & derived-copy use
Membership removal, ACL update, consent withdrawal, secret revocation, or role downgrade **does not
invalidate** sessions, caches, subscriptions, jobs, or materialized data that keep authorizing future
operations. **Vulnerable** when revocation updates the source of truth but a cached/derived copy continues to
grant access.

### Restore reintroduces invalid state
Backup, undo, undelete, or replica recovery restores data, credentials, memberships, or permissions that
**current policy no longer allows**. **Vulnerable** when restore does not re-authorize the restored state or
reapply lifecycle changes made after the snapshot.

## Verdict criteria

- **vulnerable** — a concrete cross-tenant/owner read or mutation, or a stale-authorization / lifecycle-
  bypass path, exhibited from code with the **omitted predicate** cited at `file:line`.
- **safe** — the tenant/lifecycle predicate is enforced on **every** parallel path (interactive, bulk,
  background, migration, derived read).
- **probable / coverage-gap** — an uninspected helper/branch, or the divergent behavior lives in an
  **external** cache/replica/backup/retention layer not visible in source. Downgrade — do not confirm on
  suspicion. Use high/probable/unconfirmed (`unconfirmed` → coverage gap).

## False-positive discipline

- An owner/tenant field alone neither confirms isolation nor proves a bug — **cite the enforcing (or
  missing) predicate** on the actual sink path.
- Confirm **no other layer** enforces the same tenant/lifecycle condition before flagging.
- External cache / object-storage / replica / backup / retention behavior that source cannot establish is a
  **coverage gap (probable)**, not a confirmed finding — do not assume presence or absence.
- Intended same-principal access to their own data across copies is not a finding.
