# Source-to-Sink Reference — slot types & defense matching

The verdict in a code audit hinges on one question: **does the tainted value land in a sink slot whose
required defense is present and correct?** This file defines the slot taxonomy and the correct defense
per slot. Mismatch = vulnerable.

## Why slots matter

The same sink has multiple slot kinds with different correct defenses. Parameter binding protects a SQL
**value** but does nothing for a SQL **identifier**. HTML-entity encoding protects HTML **text** but is
useless inside a `<script>` **JS context**. Labeling the slot is the step that prevents both false
positives and false negatives.

## Injection slots

| Slot | Example sink | Correct defense | Common mismatch (→ vulnerable) |
|------|--------------|-----------------|--------------------------------|
| `SQL-value` | `WHERE id = ?` | parameter binding | string concat / format into query |
| `SQL-like` | `LIKE ?` | binding + escaped wildcards | concat; unescaped `%`/`_` |
| `SQL-number` | numeric predicate | binding or strict int cast | concat of unvalidated string |
| `SQL-identifier` | table/column name | **allowlist** (binding can't help) | binding assumed sufficient; concat |
| `SQL-keyword` | `ORDER BY {dir}` | allowlist (`ASC`/`DESC`) | regex/escape on a keyword slot |
| `SQL-funcarg` | `DATE_TRUNC('%s', x)`, `EXTRACT({f} FROM x)`, `CAST(… AS {t})` | allowlist of the function's legal keywords/types | `%`/format/f-string/concat into the function-arg slot (binding can't reach it) |
| `SQL-limit` | `LIMIT {n} OFFSET {m}` | strict **int cast** | string-built limit/offset |
| `CMD-argument` | `execve` argv array | array exec (`shell=False`) | string command + `shell=True` |
| `CMD-option` | `execFile("git",[userArg])` — argv, but the value can begin with `-` | literal program **+** reject/neutralise leading `-`/`--` (or pass `--` first) | "it's the argv form, so it's safe" — the shell is bypassed, the program's **own** option parser is not (CWE-88) |
| `CMD-string` | `system("...")` | avoid; else `shlex.quote` per arg | char blacklist (`;`,`|`,`&`) |
| `FILE-path` | `open(path)` | canonicalize + boundary check | `../` blacklist; concat of user path |
| `FILE-include` | `require/include(x)` | static allowlist of includes | dynamic include of user value |
| `TEMPLATE-expr` | `render_template_string` | no user input in template source | user value used as template text |
| `DESERIALIZE` | `pickle.loads`, `unserialize`, `readObject`, `yaml.load` | safe format + trusted source + integrity (HMAC) | untrusted bytes into native deser |
| `PATH-component` | route/URL building | allowlist segment | concat into path/URL |
| `NoSQL-operator` | `col.find({user: x})` | reject object-typed input / scalar-cast / operator allowlist | typed object (`{$ne:…}`/`{$gt:…}`) reaches a query-operator slot |
| `NoSQL-where-js` | `$where`, `mapReduce`, `$expr` | never pass user data as JS/expression | user string embedded in `$where`/`mapReduce` JS |
| `XML-entity` | XML parser (`DocumentBuilderFactory`, `lxml`, `simplexml`) | disable DOCTYPE + external general/parameter entities + network DTD | parser resolves external entities/DTD on attacker XML → XXE (file read, SSRF, billion-laughs) |
| `PROTO-pollution` | recursive merge / `obj[k1][k2]=v` | null-proto objects / key allowlist / reject `__proto__`\|`constructor`\|`prototype` | user-controlled keys reach a recursive merge or dynamic property path |

## XSS (output) slots

| Slot | Context | Correct defense | Mismatch |
|------|---------|-----------------|----------|
| `HTML-text` | `<div>{x}</div>` | HTML-entity encode (framework default) | `innerHTML`, `dangerouslySetInnerHTML`, `v-html`, `\| safe`, `mark_safe` on tainted value |
| `HTML-attr` | `<a title="{x}">` | attribute encode + quote | unquoted attr; event-handler attr |
| `JS-context` | `<script>var v={x}</script>` | JSON-serialize + JS-encode | HTML-encode used (wrong); raw interpolation |
| `URL-context` | `href="{x}"` | scheme allowlist (`http(s)`) | raw user URL → `javascript:` |
| `CSS-context` | `style="{x}"` | CSS-encode / avoid | raw interpolation |
| `DOM-sink` | `.innerHTML`/`.html()`/`.append()`, `document.write`, `insertAdjacentHTML`, `eval`/`new Function`/`setTimeout(str)`, framework bypass | safe DOM API / sanitizer (DOMPurify) | tainted DOM source → sink: `location.hash`/`search`/`href`, `document.referrer`, `window.name`, `postMessage`, `URLSearchParams().get()` + URL-param helpers, `$(el).val()`/`.value` (server-populated → HTML-decoded), a `fetch`/XHR JSON field, `{{v\|escapejs}}` in inline JS, `localStorage`/`cookie` |

> **Encoder ≠ context (very common false negative).** An encoder is valid only for the context it targets;
> track that context and re-check it at the sink — the mere presence of *an* encoder never downgrades a
> finding whose sink context differs:
> - `escapejs` / JS-string-encode → then `innerHTML`/`.html()`/`document.write` → **vulnerable** (the string
>   still holds `<img …>`, re-parsed as HTML).
> - HTML-entity / attribute encode (incl. Django/Jinja auto-escape) → read back via `.val()`/`.value` and
>   written to an HTML sink → **vulnerable** (`.val()` returns the decoded string).
> - HTML-entity encode → placed inside a `<script>`/JS context or an event-handler attribute → **vulnerable**.

> **Uploaded bytes are an output slot too.** When the application later *serves* a file a user uploaded, the
> slot is **the browser's interpretation of that response**, and it is decided at the **serving** end —
> response `Content-Type`, `Content-Disposition`, `X-Content-Type-Options`, and **which origin** serves it —
> not by the extension filter at the upload end. Extension/MIME filtering on the way in is a weak input check,
> never the verdict. Full chain and the non-finding list: `CLIENT_SIDE.md` → *Uploaded-content serving*.

> **Server content-type mismatch (non-template XSS).** A response body served as `text/html` is an HTML
> sink even with **no template**: Django `HttpResponse(...)`/`HttpResponseBadRequest(...)` default to
> `content_type='text/html'`, and `json.dumps()`/f-strings/concat do **not** HTML-encode. Reflected input in
> such a body → **reflected XSS**. Safe only with an explicit non-HTML content type (`JsonResponse`,
> `content_type='application/json'|'text/plain'`) or HTML-encoding. (`json.dumps` escapes a JSON *string* —
> the wrong context for a `text/html` response.)

## SSRF slots

| Slot | Sink | Correct defense | Mismatch |
|------|------|-----------------|----------|
| `URL-host` | HTTP client, fetch, webhook, image/PDF fetch, URL-import | host **allowlist** + DNS-rebind protection + block link-local/metadata (169.254.169.254, `*.internal`) | user-controlled host with no allowlist; blocklist-only |
| `URL-scheme` | same | scheme **allowlist** (`http(s)` only) | `file://`/`gopher://`/`dict://` reachable; on **Py2 `urlopen`/`build_opener()`** `file://`+`ftp://` resolve by default → SSRF **and** LFI (CWE-73/98) with no filesystem call |
| `redirect-target` | `HttpResponseRedirect(x)`/`redirect(x)`/`redirect_to(x)`/`res.redirect(x)`, `Location:` header | relative-path only (no scheme/host) / on-site allowlist (`url_has_allowed_host_and_scheme`/`is_safe_url`) | user-controlled URL in a 3xx → open redirect (CWE-601, **A01**); class forms like `HttpResponseRedirect(next)` evade a `redirect(`-only grep |

## Access control slots (authz / IDOR / mass-assignment)

Access control is rarely a "sanitizer" question — it's a **missing-check** question. Trace each
state-changing or data-returning handler and verify:

- **Object ownership**: does the handler check that the authenticated principal owns/may access the
  object identified by a user-supplied id? Missing → **IDOR**.
- **Function-level authz**: is there a role/permission guard *on the handler*, not just in the UI?
  Missing/optional middleware → **broken function-level access control**.
- **Mass assignment**: does the handler bind a whole request object to a model without an allowlist of
  fields? User-settable `isAdmin`/`role`/`balance` → **mass assignment**.
- **Indirect/horizontal**: can `userId` from the request override the session principal?
- **Cross-site request forgery (CSRF)** — see the dedicated slot table below. CWE-352, A01.

## CSRF slots (browser-origin, cookie-authenticated state change)

CSRF is a **slot** question like every other class: the slot is *the request shape a browser can be made to
emit*, and the defense has to cover that exact shape. Three conditions must **all** hold before a handler is
CSRF-able — establish each one, in order:

1. **Ambient credentials.** The browser attaches the credential automatically: a session cookie, HTTP Basic,
   a client TLS certificate, or integrated Windows/NTLM auth. An `Authorization: Bearer` header read out of
   JS memory is **not** ambient — those handlers are not CSRF-able. A token kept in a cookie and *copied*
   into a header by JS is ambient for the cookie, and the header copy is the double-submit defense (row 3).
2. **A sensitive effect** — a state change, or a read with a side effect (sending a mail, consuming a
   one-time token, spending quota).
3. **A browser-emittable request shape that reaches it.** This is the part audits get wrong; use the table.

### What a browser can actually emit

| Request shape | Cross-site cookie sent when… | Notes |
|---|---|---|
| **Navigation — GET** (`<a>` click, `location=`, `window.open`, `<form method=GET>`, meta refresh, 3xx) | `SameSite=Lax` ✅ · `None` ✅ · `Strict` ❌ | **The blind spot.** A state-changing GET is CSRF-able under `Lax`. |
| **Navigation — POST** (`<form method=POST>`) | `Lax` ❌ · `None` ✅ · `Strict` ❌ | Content-type limited to the three below. |
| **Subresource** (`<img>`, `<script>`, `<link>`, `<iframe>`, `fetch`, XHR) | `Lax` ❌ · `None` ✅ · `Strict` ❌ | `fetch`/XHR also need `credentials:'include'`. |

A cross-site HTML form can only send `application/x-www-form-urlencoded`, `multipart/form-data` or
`text/plain` — **no custom headers, no `application/json`**. Anything else forces a CORS preflight, which
fails without explicit server permission.

### Defenses, and what each one actually covers

- **Synchronizer token** bound to the session, validated server-side, compared constant-time — full coverage.
  Check it is validated on **every** state-changing route, not only the ones the UI uses.
- **Double-submit cookie** — covers only if the token is **signed/bound to the session**. A naked
  double-submit is defeated by anyone who can set a cookie on the registrable domain (a sibling subdomain, an
  XSS elsewhere on the site, a cookie-injection bug): same-site attackers are inside this defense.
- **`Origin` header allowlist** (exact match, not prefix/suffix/`includes`) — good coverage. **Run the
  fail-open question**: a request with **no** `Origin` must be rejected, not defaulted to allow.
- **`Referer` allowlist** — weaker: strippable via `Referrer-Policy`, and must also fail closed on absence.
- **Fetch Metadata** (`Sec-Fetch-Site` / `Sec-Fetch-Mode` / `Sec-Fetch-Dest`) — a real, recognised control.
  The standard resource-isolation policy allows a missing `Sec-Fetch-Site` (old-browser compat), allows
  `same-origin` / `same-site` / `none`, and **allows cross-site when `Sec-Fetch-Mode: navigate` with GET or
  HEAD**; everything else is rejected. Source:
  <https://web.dev/articles/fetch-metadata> and <https://xsleaks.dev/docs/defenses/isolation-policies/resource-isolation>.
- **Content-type enforcement** — requiring `application/json` **and rejecting** other content types forces a
  preflight and is a genuine defense. Verify the **rejection**: many frameworks happily parse a JSON body
  regardless of the declared content type, or bind form-encoded input into the same handler. A declared
  `consumes = "application/json"` that is not enforced at runtime is not a defense.

> **`SameSite=Lax` and the standard Fetch-Metadata policy share the same hole: both let a cross-site GET
> *navigation* through.** So a **state-changing GET** — `GET /api/email?email=…`, `GET /account/delete`,
> `GET /transfer?to=…` — is CSRF-able under either one. Checking "is there a SameSite cookie / a Fetch-Metadata
> filter?" and stopping there is how this bug survives an audit. Check the **method against the effect** first:
> a handler that mutates state on GET needs a token or an Origin check, full stop.

### False-positive and false-negative controls

- `SameSite=None` is no protection at all. **No `SameSite` attribute** means a browser default (Chrome defaults
  to Lax, others vary) — that is a *deployment/browser* assumption, not a source-confirmed defense: record it
  under `unverified_assumptions`, and do not let it clear a finding on its own.
- Chrome's "Lax-allowing-unsafe" two-minute window lets a cross-site **POST** through for a freshly-set cookie.
  Browser-dependent and not decidable from source — an assumption, never a finding by itself.
- **Method override** (`_method=DELETE`, `X-HTTP-Method-Override`, `?_method=`) defeats "only GET/POST are
  browser-reachable" reasoning: if the framework honours it, a form POST becomes a PUT/DELETE. Grep for it
  before concluding a verb is unreachable.
- **CORS is not a CSRF defense and a permissive CORS policy is not CSRF** — see the CORS rule in
  `CLIENT_SIDE.md`. They answer different questions: CORS governs *reading the response*, CSRF governs
  *causing the request*.
- A read-only GET with no side effect is not CSRF. A login form without CSRF protection is **login CSRF** —
  a real, lower-severity finding, not a non-finding.
- A **framework default** counts: Django's `CsrfViewMiddleware`, Rails' `protect_from_forgery`, Spring
  Security's CSRF filter and ASP.NET Core's antiforgery are on by default. The finding is the **escape hatch**
  (`@csrf_exempt`, `skip_before_action :verify_authenticity_token`, `csrf().disable()`, a missing
  `[ValidateAntiForgeryToken]` on a cookie-authed controller) — and only when the handler is still
  cookie-authenticated.

## Auth slots

Trace the authentication and session machinery (no single sink): credential comparison (timing-safe?
constant-time), password hashing (bcrypt/argon2/scrypt vs MD5/SHA1/plaintext), session token
generation (CSPRNG vs predictable), JWT verification (`alg:none`, key confusion, missing `exp`/sig
check), password-reset token entropy & expiry, MFA enforcement gaps, account-enumeration via differential
responses, and credential storage. See `auth-auditor` and the reused JWT/OAuth catalog.

## Sensitive-data egress slots (A09 logging / data exposure — CWE-532/200)

This taint direction is **inverted**: the tainted value is not attacker input reaching a dangerous API,
it is a **sensitive value** (secret/credential/token/PII) reaching an **egress channel** (logs,
telemetry, error responses, analytics). The "defense" is *redaction / omission*, not encoding. Trace
each sensitive source forward to every egress sink.

**Sensitive sources** (taint these as "confidential"):
- credentials & tokens: passwords, API keys, session tokens, OAuth/OIDC `access_token`/`refresh_token`/
  `id_token`, JWTs, the **raw response body of an auth/token endpoint**, `Authorization`/`Cookie` headers
- auth-flow secrets: PKCE `code`/`code_verifier`, password-reset/MFA tokens, signing keys/passphrases
- regulated PII: name, email, phone, government ids, financial/health data

**Egress sinks**: see `SINK_CATALOG.md` → "Sensitive data in logs / egress". Logs, `print`/`dump`,
telemetry/APM (`extra`/`context` payloads), error responses returned to the client, third-party analytics.

| Slot | Example sink | Correct defense | Mismatch (→ vulnerable) |
|------|--------------|-----------------|--------------------------|
| `LOG-sensitive` | `logger.info('...', {response, dto})` | log only non-sensitive metadata; redact (`***`) via a processor | whole token/response/DTO logged verbatim |
| `ERROR-response` | exception message/stack returned to client | generic error to client; details server-side only | secret/PII/stack in HTTP body |
| `TELEMETRY` | APM `extra`/breadcrumb | scrub before send | tokens/PII in breadcrumbs |

Verdict rule: a sensitive source reaching one of these slots **without redaction/omission** is
`vulnerable` (CWE-532/CWE-200, OWASP A09). Severity scales with the secret's value (refresh_token /
password = higher) and the log's exposure (persisted on disk / shipped to SIEM / world-readable).

> Watch the logging config too: a buffered handler (Monolog `fingers_crossed`, log level `debug`/`info`)
> determines whether an `info`-level leak is actually persisted. Record the effective level/handler.

## Adequacy of a present defense (the "Poor Validation" trap)

Matching the defense *category* to the slot is necessary, **not sufficient** — a right-type defense can
still be incomplete. After confirming the category matches, check completeness; flag `vulnerable` only
when you can **name the bypass input**, else `probable` / coverage gap:

- **Char-set gap** — HTML-encodes `<>&"` but the value lands in a single-quoted attribute (`'` uncovered),
  or in a `JS`/`URL` slot the HTML encoder doesn't cover. Slot ↔ encoder must be *complete*, not same-family.
- **Blocklist vs allowlist** — a deny-list of bad chars/keywords is bypassable by construction; only an
  allowlist is adequate for identifier / keyword / scheme / host slots.
- **Mis-anchored / greedy regex** — `^https?:` without `$`, `.` matching newlines, missing `\A…\z`.
- **Single-pass vs re-decode** — one sanitize pass on a value that is later URL/HTML-decoded again
  (double-decode, mutation XSS).
- **Bypassable escape** — `addslashes` / manual `\` escaping under a multibyte charset (e.g. GBK),
  `*_escape_string` without the connection charset set.

## The post-sanitization concat trap

The single most common false-negative-turned-vulnerability: a value is correctly sanitized, then later
**re-concatenated** into the sink string. Always record concat operations with `file:line` and flag any
that occur *after* the sanitizer on the same path — that sanitizer is **non-effective** for this path.

## Worked example (verdict trail)

```
source:  req.query.sort                       (controller.ts:42)
path:    controller.ts:42 → listService.ts:88 → userRepo.ts:130
sink:    `SELECT * FROM users ORDER BY ${sort}`  (userRepo.ts:130)
slot:    SQL-keyword (ORDER BY direction/column)
defense: none (template-literal concat)
verdict: vulnerable — SQL-keyword slot requires an allowlist; none present
witness: ?sort=id--   (structure-influence probe, for optional live corroboration)
confidence: high       reachable: true       owasp: A03 Injection   cwe: CWE-89
```

## Extended classes — slot logic lives in the class reference

The slot↔defense matrix above covers the source→sink classes (injection, xss, ssrf, access-control,
auth-egress). The **extended classes** are workflow/boundary-shaped rather than a single tainted-value
slot; their verdict logic lives in a dedicated reference the auditor mounts alongside this file:

- **business-logic / chained trust boundaries** → `BUSINESS_LOGIC.md` (invariant-driven method; the
  "slot" is a workflow rule, not a character context).
- **feature-abuse & data-leakage** → `FEATURE_ABUSE.md` (per-item authz after selection is the "defense").
- **data isolation & lifecycle** → `DATA_LIFECYCLE.md` (the tenant/owner/lifecycle predicate is the
  "defense"; a stale derived copy is a post-sanitization-concat analogue).
- **client-side (browser)** → `CLIENT_SIDE.md` (browser source → executing sink; the browser policy —
  SOP/CSP/exact-origin — is the "defense").
- **HTTP framing/cache/header** → `HTTP_PROTOCOL.md` (two components + the divergent normalized value).
- **AI / LLM / agent** → `AI_LLM.md` (untrusted content → model/memory → capability; a deterministic
  authorization/binding check is the "defense", never a guardrail prompt).
- **federated identity / session binding** → `WEB_AUTH.md` (verification line + every required binding).

The universal discipline still applies to all of them: guards protect a **variable/path**, not a
neighborhood; the **weakest parallel path** is the policy; and a missing control with no reachable
boundary violation is `informational` hardening, not a vulnerability.
