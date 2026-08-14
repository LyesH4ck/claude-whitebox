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
- **Cross-site request forgery (CSRF)**: for a **cookie/session-authenticated, state-changing** handler,
  is there a synchronizer/double-submit token validated server-side, or `SameSite=Strict|Lax` cookies with
  no cross-site-reachable exemption? Ambient-cookie auth with **neither** token nor SameSite → **CSRF**
  (CWE-352, A01). A handler authenticated by an `Authorization`/bearer header (not an ambient cookie) is
  not CSRF-able. Flag only state-changing, cross-site-reachable handlers — a read-only GET is not CSRF.

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
