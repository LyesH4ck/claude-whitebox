# crawl-write.mjs — SPA / micro-frontend nested-form patch (G1–G6)

Motivation: the harness stalled on Vue/React micro-frontend apps with **nested forms** (a create form
containing sub-entities that each persist via their own Save). On such an app it reached only the login page.
Every gap is encoded as a regression test in `crawl-write.test.mjs` that is **red before** the patch and
**green after**; no target-specific selector or entity name is hard-coded in the harness (genericity preserved —
the harness keys on standard framework attributes, ARIA roles, and repeated-container class fragments only).

## Verification summary

- **Unit tests:** `node --test` in `stealth/` → **18 pass / 0 fail** (10 pre-existing + 5 new gap tests +
  `crawl.test.mjs` + `op-signature.test.mjs`). The 5 new tests (`G1`…`G5`) each fail on the pre-patch harness.
- **Live dry-run** against a real micro-frontend SPA (`--max-views 12`), before → after:

  | metric            | before (baseline) | after |
  |-------------------|-------------------|-------|
  | `pages_visited`   | 2 (login only)    | **6** |
  | `forms_processed` | 1 (login)         | **3** |

- **Live armed run** on a deep create page: endpoint discovery rose markedly (`data_endpoints 1→11`,
  `param_endpoints 0→2`) and real in-scope writes were captured. The deepest fully-nested create chain
  (a sub-entity POST → a line-item PUT → the parent create) is **best-effort** end-to-end in a bounded live
  run — it needs a valid option picked from a live typeahead and several per-row commits. The generic
  **machinery** for it (form-region detection, validation-aware option cycling, sub-entity commit, state-delta
  oracle) is in place and unit-proven; completing that specific heavy form generically within a time-boxed run
  is not guaranteed.

## Gaps & fixes

**G1 — SPA route discovery.** `nextNavTarget` only read `a[href]` from the *current* page, so a client-routed
launcher (tiles via `routerlink`/`data-href`/`role=link`) stalled it at 2 pages. Fix: a broadened attribute
harvest (`collectRoutes`) **plus** a **global BFS frontier** queue (create-ish first) that survives dead-end
routes, and a longer `mountSettle` (networkidle + paint) after each navigation so a micro-app has time to mount
before introspection. *Test G1* (routerlink/data-href tiles → reach a create form).

**G2 — formless form-region.** `INTROSPECT` keyed on `input/select/textarea` with a `name`, so a framework
region (no `<form>`, `role=combobox/textbox/spinbutton`, `contenteditable`, often nameless) yielded 0 fields.
Fix: enumerate those control types, derive a name from `aria-label`/`placeholder`, tag each element with a
`data-cx-field` handle so nameless fields are locatable, and fill `contenteditable` via a scripted `input` event.
`openAddDialogs` now self-guards (skips when a form-region is already visible) so it never fires a region's own
submit. *Test G2* (formless nameless region + contenteditable → completed once).

**G3 — validation-aware option selection.** `fillWidgets` took the first option; the first can be poisoned
(an invalid choice → a blocking toast + inert submit). Fix: after each pick, re-read state via `readToast`/
`hasBlockingError`; on a blocking error, reopen the widget and try the next option. *Test G3* (poisoned first
option → advances to the valid one → submits).

**G4 — nested sub-entity commit order.** A parent create can hold sub-entities that persist via their **own**
Save (a related-party sub-form → its POST, each line row → its PUT); the parent may stay incomplete until they
commit. The `MAX_STEPS` wizard loop never clicked them. Fix: `commitSubEntities` clicks per-card/row Save
buttons (create-hint, not the terminal submit, inside a `card/row/line/item/li/tr` container) in DOM order
before the parent action. *Test G4* (sub-form Save → line Save → parent Create, in order).

**G5 — state-delta oracle (anti-false-positive).** A create was recorded on any write response; a submit that
fired **no** write (enabled button, empty total, empty list) was silently treated as "did work". Fix: only a
**2xx** in-scope write becomes a `created`; a submit that produced no 2xx write is recorded as `blocked` with
the read toast reason (`intent_blocked`); a 4xx/5xx response is never a `created`. *Test G5* (no-write submit →
`blocked` with reason, no false `created`).

**G6 — intermediate writes + errors.** `actions[]` held only the terminal create. Fix: a session-wide
`response` listener records **every** in-scope write (`session_writes[]` — seeds incl. the intermediate
sub-entity writes) and routes 4xx/5xx to `findings[]` (endpoint contract + server bug). Written to
`session-writes.json` / `findings.json` under `--out`. *Test G4+G6* (sub-entity writes captured as seeds; a 5xx
sub-write surfaced as a finding).

## Output additions (additive — `crud-merge.mjs` still consumes `actions[]`/`intents[]` unchanged)

- `totals.session_writes` / `totals.findings` / `totals.blocked`
- `session_writes[]`, `findings[]`, `blocked[]` (+ `session-writes.json`, `findings.json` files under `--out`)

## Follow-ups (not in this patch)

- Feed `session_writes[]` (intermediate sub-entity writes) into `crud-merge.mjs` as additional BOLA/injection
  seeds (currently emitted but not yet merged).
- Live typeahead option selection for the deepest nested form is best-effort; a longer per-route mount budget or
  a smarter typeahead probe could raise live completion.
