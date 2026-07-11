# crawl-write.mjs — patch #2: correctness fixes (F1–F5)

An adversarial review (3 independent reviewers) of the G1–G6 patch found **3 critical correctness defects** that
poison the downstream testers (`idor-bola`, `injection`) with phantom, wrong, or duplicated seeds, plus robustness
gaps. Each fix is driven by a regression test in `crawl-write.test.mjs` (or `crud-merge.test.mjs`) that is **red
before** and **green after**; genericity preserved (no target-specific selector or name).

## Verification

- **Unit tests:** `node --test` in `stealth/` → **20 pass / 0 fail** (15 prior + 5 new: T-F1/F4, T-F2, T-F3,
  T-F7, T-bug3). `crud-merge.test.mjs` → **8 pass / 0 fail** (7 prior + F5). `crawl.test.mjs`,
  `op-signature.test.mjs` still green.
- **Authenticated live re-benchmark: NOT RUN — the provided cookie is expired** (`cookie.txt` redirects to
  `/auth/login-page`). The prior patch #1 numbers (`pages 2→6`, `forms 1→3`) were measured against the
  **unauthenticated** surface and should be read as such; a fresh operator cookie is required to re-validate the
  authenticated flow (real routes reached, `POST /vendor` 201, `PUT /inventories/{id}` 200,
  `custom-field/contents` 500 as a finding, no false `created`, no duplicated writes). Do not claim nested
  end-to-end capability as proven until measured authenticated.

## Defects & fixes

**F1/F4 — G5 was not a persistence oracle (CRITICAL).** The code recorded `action:'create'` on the FIRST 2xx
non-GET write after the submit, so a preview/validation/telemetry 200 (or an ag-grid `count` POST) became a false
`created`, and the `blocked` path was unreachable. Fix: wait for a **candidate-create** write only
(`mutationWritePredicate` = POST/PUT/PATCH to a non-denylisted path), then require a **positive persistence
signal** — HTTP 201, a `Location`, a URL→detail change, or a non-echoed response id — else record `blocked` with
the read reason. A generic token denylist (`preview|validate|validation|check|activity|analytics|telemetry|
search|autocomplete|typeahead|count|list|export|log|track|metric|ping|heartbeat|health`) marks non-persistent
paths (token-matched, so `preview-doc-definition`/`create-activity-log`/`…/count` are caught but `/accounts` is
not). *Test T-F1/F4.*

**F2 — findId picked the wrong id (CRITICAL).** It returned the first `id` at ANY depth, so a response echoing
`owner:{id:<company_id>}` yielded the auth principal's id → crud-merge derived a cross-tenant GET/PUT/**DELETE**
corpus against the real company. Fix: prefer a **top-level** id (or one under a standard `data`/`result` wrapper),
**never** descend into an auth-principal node (`owner`/`user`/`company`/`tenant`/…), and **reject** any value
echoed from the request body. *Test T-F2.*

**F3 — G4 amplified writes (CRITICAL).** `commitSubEntities` ran inside the `for step` loop and a terminal ≥400
`continue`d, so sub-entity Saves were re-clicked up to 4× → many objects for one form. Fix: run
`commitSubEntities` **once per form** (step 0 only); a 4xx retries the parent only, a 5xx stops; the "1 object/
form" cap holds. *Test T-F3.*

**G4-sel — sub-entity container too broad (MEDIUM).** `[class*="item"]` matched Tailwind `items-center`,
`row`→`ag-row`, `line`→`inline`. Fix: **word-boundary** match on the ancestor `className` (`\b(card|row|line|
item|entry)\b`), and the sub-container must **not contain** the parent's terminal submit (so it is a genuine
sub-region, not the whole form). *(Covered by T-F3 / G4.)*

**F7/G3 — blocking detection too narrow (MEDIUM).** It keyed on a toast matching `invalid` only, missing the bare
`valid` in "not a valid"/"non valide" and any **inline** validation. Fix: multilingual `<negation> … valid`
regex **plus** inline signals (`[aria-invalid="true"]`, `.v-alert`/`.mat-error`/error helper-text). *Test T-F7.*

**bug#3 — read-only discovery regression (MEDIUM).** The `openAddDialogs` guard skipped whenever ANY input was
visible, so a LIST page's search box blocked the "+Add" dialog and its inner widgets/params went undiscovered.
Fix: the guard ignores **search-like** fields (a lone search box is not a create form-region). Also the typeahead
probe was scoped to the **open overlay/dialog/listbox** (an unscoped `input[placeholder*=search]` had `.first()`
type into the page's own list-search box, firing nothing). *Test T-bug3.*

**F5 — G6 seeds not merged (MEDIUM).** `crud-merge.mjs` read only `crud.actions`, so the intermediate
sub-entity writes (`session_writes[]`) were lost to `idor-bola`/`injection`. Fix: a new `--session-writes` input
seeds each **mutating, successful, in-scope** write as an extra BOLA/BOPLA request, filtered by the SAME mutation
denylist (telemetry/preview/count/non-2xx/GET dropped). Backward-compatible: `actions[]` stays the primary source.
*Test F5 (crud-merge).*

## Notes

- A latent **TDZ bug** surfaced during the fix: the new `BLOCKING_RE`/`NEG_VALID_RE` constants were first placed
  after the top-level-await main block, so the hoisted `hasBlockingError` threw `Cannot access … before
  initialization`. Moved them to the top with the other regex constants.
- `crud-exerciser.md` (armed-run + Phase 4) documents the persistence oracle, non-echoed-id rule, commit-once, and
  the `--session-writes` mutation-filtered seeding.
