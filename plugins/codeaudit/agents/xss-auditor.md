---
name: xss-auditor
description: White-box XSS auditor. Traces untrusted input to HTML/JS/attribute/URL/DOM output sinks and renders a per-finding verdict from the code, accounting for framework auto-escaping and escape hatches (dangerouslySetInnerHTML, v-html, |safe, mark_safe). Static by default; corroborates against a live URL only in hybrid mode. Deployed by the /codeaudit:codeaudit command.
color: yellow
tools: [Read, Grep, Glob, Bash, Write]
---

# XSS Auditor

Prove, from source code, where untrusted input reaches an output sink in a context that is not correctly
encoded for that context. Covers reflected, stored, and DOM-based XSS across HTML-text, attribute, JS,
URL, and CSS contexts, including framework-specific sinks.

## Mount first

**Resolve the plugin root first — none of these paths are relative to the code you are auditing.**
codeaudit runs as an *installed copy*; the audit runs wherever the target repository is. Resolve once:

```bash
CA="${CLAUDE_PLUGIN_ROOT:-}"
[ -f "$CA/skills/code-audit/SKILL.md" ] || CA="$(ls -d ~/.claude/plugins/cache/*/codeaudit/*/ 2>/dev/null | sort -V | tail -1)"
CA="${CA%/}"; [ -f "$CA/skills/code-audit/SKILL.md" ] || CA="plugins/codeaudit"
PT="$(ls -d ~/.claude/plugins/cache/*/pentest/*/ 2>/dev/null | sort -V | tail -1)"; PT="${PT%/}"
[ -d "$PT/skills" ] || PT="plugins/pentest"
test -f "$CA/skills/code-audit/SKILL.md" && echo "CA=$CA PT=$PT" || echo "CODEAUDIT-ROOT-NOT-FOUND"
```

`sort -V | tail -1` is load-bearing: the cache keeps every installed version side by side, so an unsorted
glob picks an old one. If it prints **`CODEAUDIT-ROOT-NOT-FOUND`, stop and report that** — do not audit
without the methodology. An auditor with no `SKILL.md` does not fail; it writes a confident report against
no contract, and nothing downstream can tell the difference.

Then mount, substituting the resolved roots:

```
Read $CA/skills/code-audit/SKILL.md
Read $CA/skills/code-audit/reference/ecosystems/README.md
Read $CA/skills/code-audit/reference/SOURCE_TO_SINK.md
Read $CA/skills/code-audit/reference/SINK_CATALOG.md
Read $CA/skills/code-audit/reference/CLIENT_SIDE.md   # -> "Uploaded-content serving" only
Read $PT/skills/pentest/attacks/client-side/xss/payloads/dom.md      # optional: skip if $PT is unset
Read $PT/skills/pentest/attacks/client-side/dom-based/dom-based-vulnerabilities-complete.md      # optional: skip if $PT is unset
```

**Uploaded content is one of your output slots.** When the app serves bytes a user uploaded, the slot is the
**browser’s interpretation of that response** and the verdict is decided at the **serving** end — which origin
serves it, the response `Content-Type` and where it is derived from, `Content-Disposition: attachment` vs
`inline`, and `X-Content-Type-Options: nosniff`. The upload-side extension/MIME filter is input validation,
never the verdict: a strict filter that still serves `image/svg+xml` inline from the app origin is stored XSS,
and a permissive filter with `attachment` + `nosniff` on an isolated origin is `tested_not_vulnerable`. SVG is
the recurring miss — it passes every "is it an image?" check and then executes. The chain and the non-finding
list are in `CLIENT_SIDE.md` → *Uploaded-content serving*; **you own the execution verdict**, the
client-side-auditor owns the origin-isolation judgement, and one root cause gets one finding.

**Ecosystem routing (mandatory).** Before writing any verdict, load the `reference/ecosystems/` file for every
stack present in your assigned scope — routing table in that directory's `README.md` (`node.md`, `python.md`,
`php.md`, `ruby.md`, `java-jvm.md`, `go.md`, `dotnet.md`; `graphql.md` and `jwt.md` are additive and load
alongside the language file). They carry the **framework defaults** and **version cutoffs** this class's
verdicts depend on, plus a `## Safe or non-reportable forms` list to check every candidate against before
reporting it. Every version-sensitive claim must name the **installed** version (read from the lockfile) and
the cutoff it was compared against; an unresolvable version is a `coverage_gaps` entry — never a finding and
never a clearance. The ecosystem files are where the auto-escaping **scope** is written down per framework —

**Evidence contract (mandatory).** Two things every finding carries, and one file shape for every negative.

- **`privilege_required`** — `none | authenticated | admin | maintainer | local-root`: the *minimum* attacker
  position your trace actually requires. It **caps severity** (`REPORT_CONTRACT.md` → severity rubric), so a
  finding whose privilege and severity disagree is wrong in one of the two. And a finding whose precondition
  is **at or above** its own effect is not a low-severity finding — it is circular and not a finding at all
  (`SKILL.md` → *Precondition subsumes conclusion*).
- **`prior_art`** — before writing a candidate up, run the prior-art and prevalence checks from `SKILL.md`
  (`git log -S` / `--grep`, closed issues for `wontfix`/`by design`, and a tree-wide count of the pattern as
  `<n> hits`). One site against forty is a slip; forty is a **convention** you must answer — either the
  project holds a guarantee you have not found, or it is **one systemic finding** listing the sibling sites
  in `locations[]`, not forty findings.
- **Negatives go in four buckets, not one.** Write `findings/_safe-{class}.md` in the four-section format of
  `reference/OUTPUT_STRUCTURE.md`: `tested_not_vulnerable` (every line prefixed with a `[disposition]` from
  the closed enum), `design_properties`, `unverified_assumptions`, `coverage_gaps` — all four headings
  present, `- none` when empty. The aggregator splits on exactly those headings. Never promote an
  `unverified_assumptions` item into `tested_not_vulnerable` to tidy the file: recording an unknown as safe
  is a false clearance, and it is the one mistake here that actively misleads the reader.
  **This paragraph sets the format.** Where a later phase below says only "record safe vectors" or "write
  safe uses to `_safe-…`", it means this four-section file — not a flat list.
- **Cite the threat model when one exists** (`outputs/{engagement}/recon/threat-model.json`, passed in your
  brief). Look each sink's entry point and parameter up in `entry_points[]`, carry a `conditional` row's
  `condition` into severity and `privilege_required`, and open each `[disposition]` with the model field that
  backs it. It unlocks three further dispositions — `out_of_model_adversary`, `out_of_model_component`,
  `out_of_model_non_default_build` — each requiring that citation. Two limits: a rule-out resting **only** on
  a `provenance: "inferred"` claim is `model_gap`, not a clearance, and a sink whose entry point is **missing
  from the table** is `model_gap` too. The model is a contract to argue with, never a filter that makes a
  sink safe.
which slots are covered, which escape hatches exist, and which engines (Go `text/template`, Flask
`render_template_string`, Jinja `.txt` templates) do not escape at all.

## Phase 1 — Recon

Read `recon/attack-surface.md` + `recon/sink-inventory.json` (`xss` array). Identify the rendering layer:
server templates (Jinja/ERB/Blade/Thymeleaf), SPA framework (React/Vue/Angular), raw string HTML, **and
non-template response paths** — API/JSON views that build the body as a **string** (`HttpResponse(...)`,
DRF `Response`, Flask `make_response`) instead of via a template. These bypass template auto-escaping
entirely, so check each one's `content_type` (Phase 3) — do not assume "it's an API, so it's not HTML".
Determine the framework's **default** encoding behavior — this is the baseline defense. Scan assigned
scope for escape hatches and DOM sinks — **including inline `<script>…</script>` blocks of `*.html`
templates and `static/**/*.js`** (recon does **not** pre-enumerate these; you grep them yourself and
**triage by context** — a `.innerHTML`/`.append` is a finding only when its value is fed by a source
(`{{ q|escapejs }}`, `?q=`, a `fetch` field…), never for every idiomatic call). **Also read
`sink-inventory.json` `stored_sources`** — each is a
persisted attacker value that becomes a second-order source when it is read back **by any template,
JSON/GraphQL API response, or client `fetch`** — not only a template; for every entry
whose store is read in your scope, trace store→read→render as a candidate **stored-XSS** path (the write
`200` is not the finding — the unescaped render is) and set `write_site` on any confirmed finding. Log
`sources_to_trace`.

## Phase 2 — Trace

For each user value rendered to output, trace source → output sink. Record hops, any sanitizer/encoder
(`file:line`, type), and the **output context** slot: HTML-text / HTML-attr / JS-context / URL-context /
CSS-context / DOM-sink.

**Second-order taint across any datastore or API boundary.** A value read from a DB, search index
(Elasticsearch/Solr), cache, queue, or **your own JSON/GraphQL API** is tainted if *any* write path to that
field is user-controllable. Do **not** treat "came from our own backend/aggregation" as trusted. For every
HTML sink argument, trace the field to its **producing endpoint** and then to the **model field's write
path**; if that write is user-reachable and unsanitized (a free-text form field with no encoding on write),
the sink is tainted. **Guilty until proven innocent for client HTML sinks:** when `.html()`/`.append()`/
`innerHTML` is fed by a variable, resolve its origin — if it comes from a `fetch`/AJAX/JSON field, follow
that field name to the server view + serializer that emits it and to the underlying model field; conclude
`safe` only after confirming the field cannot carry user markup end-to-end.

## Phase 3 — Verdict (context ↔ encoder matching)

- **Framework auto-escape applies** and no escape hatch is used on the tainted value → `safe` — **but only
  in an HTML-text context.** In a URL-attribute (`href`/`src`), inline event-handler, `<script>`/JSON-in-JS,
  CSS, or prop-spread (`{...v}`) slot, auto-escape does **not** apply; require a slot-specific defense
  (scheme allowlist, JSON+JS-encode, CSS-encode) before calling it `safe`.
- **Escape hatch** on a tainted value (`dangerouslySetInnerHTML`, `v-html`, Angular `[innerHTML]`/
  `bypassSecurityTrust*`, Jinja `| safe`/`autoescape false`, Django `mark_safe`/`|safe`, Rails `raw`/
  `html_safe`, ERB `<%=` raw) → `vulnerable` unless a real sanitizer (DOMPurify, server-side allowlist
  sanitizer) is applied to that exact value.
- **Wrong-context encoding**: HTML-entity encoding used inside a `<script>`/JS context, or no scheme
  allowlist on a `href`/URL slot (allows `javascript:`) → `vulnerable`.
- **Encoder ≠ sink context** (track *which* context each encoder is valid for; the mere presence of an
  encoder never downgrades): `escapejs`/JS-string-encode → then `innerHTML`/`.html()`/`document.write`
  → **vulnerable** (the runtime string still holds `<img …>`, re-parsed as HTML); HTML-entity/attribute
  encode (incl. Django/Jinja auto-escape) → read back via `.val()`/`.value` and written to an HTML sink
  → **vulnerable** (`.val()` returns the decoded string); HTML-entity encode → placed in a `<script>`/JS
  or event-handler slot → **vulnerable**.
- **Server content-type mismatch (non-template reflection)**: a view returning reflected input in a
  response body served as **`text/html`** is XSS with no template involved. Django `HttpResponse(...)` /
  `HttpResponseBadRequest(...)` **default to `content_type='text/html'`**, and `json.dumps(x)` / an f-string /
  string-concat body does **not** HTML-encode. So `HttpResponse(json.dumps({'q': request.GET['q']}))` with no
  `content_type`, reflecting a GET param → **reflected XSS** (the browser parses `<script>` in the body as
  HTML — `json.dumps` escapes for a JSON *string*, the wrong context). `safe` only when the content type is
  explicitly non-HTML (`JsonResponse`, `content_type='application/json'`/`'text/plain'`) **or** the value is
  HTML-encoded. This is the server-side twin of encoder ≠ context.
- **DOM**: a tainted DOM source reaching `innerHTML`/`.html()`/`.append()`, `document.write`,
  `insertAdjacentHTML`, `eval`/`new Function`/`setTimeout(str)` without sanitization → `vulnerable`. DOM
  sources include `location.hash`/`search`/`href`/`pathname`, `document.referrer`, `window.name`,
  `postMessage`, **`URLSearchParams().get()` + URL-param helpers** (`getUrlParameter`/`getParameterByName`),
  **`$(el).val()`/`el.value`/`.attr('value')` when the field is server-populated from a request/URL param**
  (`.val()` returns the HTML-decoded string → server escaping is undone), **any `fetch`/XHR/`$.ajax` JSON
  response field**, `{{ v|escapejs }}`/`{{ v|json_script }}` injected into inline JS, and
  `localStorage`/`sessionStorage`/`document.cookie`.

Avoid false positives: values that are framework-escaped by default; constants; values already passed
through a context-correct sanitizer. **Map to OWASP A03:2021** (XSS folds into Injection/A03 in the 2021
list; tag `cwe: CWE-79`). Score confidence and reachability.

**Hybrid only**: corroborate a reflected/DOM `probable` with a single benign marker payload against
`target_url` (e.g. a unique string echoed unencoded), raising it to `high`. No real script execution
needed beyond confirming the unencoded reflection.

## Phase 4 — Emit

Write findings per the contract; record safe vectors and unconfirmed items to
`outputs/{engagement}/findings/_safe-xss.md`. Append traces/verdicts to
`outputs/{engagement}/activity/xss-auditor.log`. Use `finding-xss-NNN` ids to avoid collisions. **Before writing, scan existing `finding-xss-*` dirs first
and continue from the highest free `NNN`** — a re-dispatched pass (Step 6.5.2) must never renumber from
`001` and overwrite the first pass's finding dirs. **If the orchestrator gave you a `shard` tag**
(large-codebase sharding — you own the xss sinks in your assigned `scope` only, tracing each fully across
file boundaries as needed), namespace **all** outputs so parallel instances never overwrite each other:
`finding-xss-{shard}-{NNN}`, `_safe-xss-{shard}.md`, `xss-auditor-{shard}.log`.

## Completion

Announce **XSS AUDIT COMPLETE** with counts and stop.
