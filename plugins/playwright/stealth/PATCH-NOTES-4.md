# crawl-write.mjs — patch #4: reach & engage real SPA forms (G1 seeds, G2 picker) + regressions (bug#1, bug#2)

Patch #3 unblocked authentication; this patch makes the harness able to REACH create views on a micro-frontend
launcher and ENGAGE picker-first forms, and fixes two residual regressions the code review flagged. Every fix is
red-before/green-after tested; genericity preserved (`--seed-route` is operator INPUT, never a hard-coded target).

## Two-tier model (documented in `crud-exerciser.md`)

1. **Authenticated mapper** (reliable): authenticates via real cookies, reaches the true backends, captures
   endpoints/params/hosts, classifies writes (mutation vs read-POST). Always adds value.
2. **Deep CRUD** (best-effort): drives picker-first / multi-step forms generically; on a launcher with no
   crawlable `<a href>`, the operator supplies known create routes via `--seed-route`.

## P0/G1 — descend into the SPA

- **`--seed-route <route>` (repeatable) and `--seeds <file>`** — operator-supplied create routes, resolved
  against the start URL, scope-checked, and enqueued FIRST in the BFS frontier. On a micro-frontend launcher that
  exposes no crawlable link, this is the reliable way to reach a create view. Emits `seed_routes` in the output.
- The DOM harvest already collects `routerlink`/`data-href`/`data-route`/`role=link` tiles (patch #1) and reaches
  non-anchor routes via `goto` (works for History-API / hash routers).

*Test T-G1-seed* (a launcher with no create link + `--seed-route` reaches and submits the create form).
**Live:** the dry-run with `--seed-route "/transaction/…/sale?action=create"` visits the seed page
(`pages_visited 1 → 2`, `seed_routes: 1`) and maps 11 authenticated endpoints — up from the stuck-at-1 baseline.

## P1/G2 — recognize picker-first / multi-step forms

A picker-first invoice form has no input cluster at load — a buyer **picker** (typeahead) that, once a valid option is
chosen, REVEALS the line section (each line committed by its own Save) before the parent create. Changes:
- A shared `PICKER_SEL` broadens picker recognition (Vuetify `v-autocomplete`/`v-select`, Material `mat-select`,
  ARIA comboboxes, `[aria-autocomplete]`, `[class*=typeahead]`); a picker + a primary action is a form-region.
- After a valid option is selected, the step loop RE-INTROSPECTS and `commitSubEntities` clicks the revealed rows.
- `pickSubmit` no longer picks a sub-entity Save as the parent submit, and the parent submit is RE-PICKED after
  the sub-rows commit (the "Create" often stays disabled until they do).

*Test T-G2-picker* (buyer picker → select → two revealed line rows committed once each → parent create captured).
**Live:** the picker mechanism is unit-proven; on a real heavy Vuetify picker page, engaging it
end-to-end within a bounded run remains best-effort (the page needs a long mount and several dependent
interactions) — see the armed-run note below.

## P1 — patch #3 regressions

- **bug#1** — `idFromUrlChange` is back in the `positive` signal: a SPA create whose only proof is navigating to
  `/…/{id}` (POST 200, no id/Location) is `created` again, not `blocked`. *Test T-bug1.*
- **bug#2** — read-POSTs are classified `mutation:false` producer-side: a GraphQL query (`{query}` whose op is not
  a `mutation`, or a `/graphql` terminal) and an ag-grid list POST (`filterModel`/`startRow`/`rowGroupCols`/
  `sortModel`) are never seeded as mutations by `crud-merge`. *Test T-bug2.*

## Verification

- Unit: `node --test` in `stealth/` → **33 pass / 0 fail** (browser + crawl-write 27 + crawl + op-signature);
  `crud-merge.test.mjs` → **8 pass / 0 fail**. New: T-G1-seed, T-G2-picker, T-bug1, T-bug2.
- Live (authenticated, proxy warmed): G1 seed-route reaches the seed create page; the mapper captures the
  authenticated surface with correct write classification; **no false `created`** on preview/telemetry writes.
  The armed run on a deep create page authenticated and mapped **39 endpoints / 8 params**; the preview and
  telemetry writes were correctly classified as `mutation:false` (no false `created`). Driving that specific heavy picker to a full sub-entity → line → parent-create chain
  end-to-end did **not** complete in the bounded run (`forms_processed:0`) — the page needs a long mount and
  several dependent interactions; the picker MECHANISM is unit-proven (T-G2-picker) but this particular form
  remains best-effort. Honest status: the authenticated **mapper** tier is solid and live-proven; the **deep
  CRUD** tier reaches create views (seeds) and drives generic picker forms, but the most complex real form is
  not yet completed purely generically.
