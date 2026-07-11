# crawl-write.mjs — patch #3: authenticated-browser fix (P0) + patch #2 over-correction undo (P1) + hygiene (P2)

Two things blocked the earlier patches from ever being validated on a real target, and one made the oracle
over-strict. Fixed here, then validated live against an authenticated SPA. Every fix is red-before/green-after
tested; genericity preserved (no target-specific selector/name).

## P0 — BLOCKING: cookie auth via `context.addCookies`, not `extraHTTPHeaders`

**Bug.** `--cookie` was injected as `extraHTTPHeaders: { Cookie }`. On HTTPS-through-a-proxy the browser DROPS a
manual Cookie header on the wire, and it never populates `document.cookie` — so a SPA's client-side auth guard
reads no cookie and redirects to `/login`. The harness therefore NEVER reached authenticated forms: all of
G1–G6 / F1–F6 were un-validatable in live.

**Fix.** `browser.mjs/newStealthContext` now parses `--cookie` and injects real cookies via `ctx.addCookies` on
the registrable domain (`.example.com` → every in-scope subdomain; an IP/localhost gets an exact domain, no
leading dot). Per-cookie try/catch (a `@`/`.` in a name must not fail the lot). `extraHTTPHeaders` is kept for
`--header` only (Authorization Bearer etc. — browser-honored). `--state` (storageState) is unchanged. Same fix
applied to `crawl.mjs` (recon). **Impact: unblocks the whole plugin in browser mode.**

**Live A/B (through the proxy, same cookie).**
- `curl -H "Cookie: …"` (header on the wire) → `303 → authenticated home 200` (auth works server-side).
- old `extraHTTPHeaders.Cookie` → the SPA redirects to the login page.
- new `addCookies` → **authenticated**: the dry-run reached authenticated app API routes across multiple in-scope hosts (`data_endpoints 1 → 15`),
  with no login-page fallback. **P0 proven.**

Test: `browser.test.mjs` — `page.evaluate(() => document.cookie)` must contain the injected cookie AND the
server must receive it on the wire. (With the old header path `document.cookie` is EMPTY — the discriminator.)

## P1 — undo the patch #2 over-correction (false negatives)

**F1 — the non-persistent denylist is now ADVISORY.** Patch #2 EXCLUDED denylisted-path writes from the create
wait, so a REAL `POST …/id-validation` 201 (or `/checks`, `/lists`) was classified `blocked` — a lost seed.
Now the submit COLLECTS every mutating in-scope write and picks the best create candidate; a strong positive
signal (**201 / Location / URL→detail / non-echoed id**) makes it a create and **overrides** the token. The
token is checked on the **terminal segment only** and the lottery singular/plural tokens the review flagged
(`check(s)`, `list`, `activity`, `log(s)`, `track`, `trace`, `count`, `health`) were removed. *Test T-P1-F1.*

**F2 — reject an echoed id only when it is AUTH-PRINCIPAL.** Patch #2 flattened ALL request-body leaves and
rejected any echoed response id, so a legitimate client-supplied id (a UUID, an idempotency key, a low integer
colliding with a submitted number) was dropped → `created` with no id → an EMPTY BOLA corpus. Now the echo set
holds only values sent under an auth-principal key (`company/tenant/owner/user/…`); resource ids are kept.
*Test T-P1-F2.*

**session-writes filter by FORM, not token.** `crud-merge.mjs` seeded session-writes using a path-token denylist
that can't tell a mutation from a read-POST (GraphQL `query`, an ag-grid list POST). Now the harness tags each
session write with a `mutation` flag (method + status + form: PUT/PATCH/DELETE always; POST only on 201 /
Location / a 2xx to a non-preview terminal), and `crud-merge` seeds only `mutation` writes. *Test F5 (crud-merge).*

**G4-sel — require a real repeated group.** `\b(card|row|line|item|entry)\b` still matched `ag-row`/`form-row`/
`flex-row`/`list-item`. A sub-entity Save must now sit in a `<li>`/`<tr>` with a same-tag sibling, OR a
repeat-classed element with ≥1 sibling carrying the same repeat class — a lone layout wrapper no longer qualifies.

## P2 — hygiene / robustness

- **Shared token set.** `NON_PERSIST_TOKENS` moved to `non-persist-tokens.mjs` (single source for crawl-write);
  `crud-merge` no longer duplicates it (it filters on the `mutation` flag), so the two can't drift.
- **findId arrays.** `findId` now also reads `{data:[{id}]}` (created object as the first array element). *Test T-P2-array.*
- **F3 stale handles / sequential revelation.** `commitSubEntities` re-queries the sub-save handles after EVERY
  commit (a Vue/React re-render detaches the old `elementHandle`s; a line may only appear after the previous one
  commits) and dedups by a stable signature so a Save is never clicked twice (no amplification). Bounded passes.

## Verification

- Unit: `node --test` in `stealth/` → **29 pass / 0 fail** (browser P0 + crawl-write 24 + crawl + op-signature);
  `crud-merge.test.mjs` → **8 pass / 0 fail**. New tests: P0 cookie, T-P1-F1, T-P1-F2, T-P2-array, crud-merge F5
  mutation flag; the nested tests use genuine repeated-sibling rows.
- Live: P0 proven (authenticated app routes reached, no `/auth` fallback; `data_endpoints` up an order of
  magnitude). The armed run on the deepest nested create form authenticates and discovers 39 endpoints / 8 params with
  **no false `created`** on a preview/validation write (F1 correct). Driving that heavy form to a full
  sub-entity → line → parent-create chain end-to-end remains best-effort within a bounded run; the generic
  machinery is in place and unit-proven.
