# Client-Side & Browser Reference — DOM sources, origins, and browser persistence

Mounted by the **client-side-auditor** (OWASP **A03** DOM-XSS / **A05** misconfig). Covers the browser trust
boundaries the server never sees: DOM sources (`location`, `document.referrer`, `window.name`, `postMessage`,
storage), origin boundaries, service workers, browser storage, and cross-site state oracles. Pairs with the
**xss-auditor** (which owns server-rendered reflected/stored HTML) — this file owns the **client-only** classes.

- **A client-side finding needs a controllable source AND an executing/disclosing sink.** Name both; show
  attacker-influenced data reaching the sink. The impact must reach a **victim’s session, another origin, or
  shared persistence** — self-injection of the attacker’s own data is not a finding.
- **Framework escaping, same-origin policy, CSP, COOP/CORP, service-worker scope, and modern `noopener`
  defaults are real controls.** Verify them before assigning impact.
- **Verdict from code.** Renderer/CSP/extension behavior that isn’t in the repo → coverage gap, not a
  confirmed finding.

## DOM & object-state attack classes

**DOM-based XSS**
Trace browser-controlled sources → executing sinks. Sources: `location.(href|hash|search|pathname)`,
`document.referrer`, `window.name`, `postMessage` data, `localStorage`/`sessionStorage`, `document.cookie`.
Sinks: `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `Function(`, `setTimeout`/
`setInterval` with a string, `$(...).html()`/jQuery HTML APIs, `location = `/`javascript:` URLs, framework
escape hatches (`dangerouslySetInnerHTML`, `v-html`, `[innerHTML]`, `bypassSecurityTrust*`). Seeds:
`rg -n 'innerHTML|outerHTML|document\.write|insertAdjacentHTML|eval\(|new Function|\.html\(|dangerouslySetInnerHTML|v-html|bypassSecurityTrust'`.
**safe**: value goes through framework interpolation/`textContent`/DOMPurify. **vulnerable**: `el.innerHTML =
location.hash.slice(1)`.

**DOM clobbering**
Attacker-injected `id`/`name` attributes shadow a global, form property, config object, or init flag later
trusted by code (`window.CONFIG`, `document.forms`, a truthy-check on a DOM lookup). Require **both** a markup
path that preserves the attribute (an HTML sink that allows `id`/`name`) **and** a security-relevant use of the
clobbered value. **vulnerable**: `if (window.isAdmin)` where `<a id=isAdmin>` can be injected.

**Prototype pollution & gadget chain**
An attacker-controlled **key** reaches a recursive write (deep merge, `_.merge`, path-assign, `Object.assign`
in a loop, query-string→object) and sets `__proto__`/`constructor`/`prototype`; then a **reachable gadget**
consumes the polluted property to change authorization, execution, navigation, or rendering. Seeds:
`rg -n '__proto__|constructor\[|prototype\[|deepMerge|deep-merge|_\.merge|_\.set|extend\(|Object\.assign'`.
`JSON.parse`, a shallow copy, or pollution **without a gadget** is not enough — exhibit the gadget. (Coordinate
with injection-auditor’s server-side proto-pollution slot; this is the client variant.)

## Cross-origin messaging & network attack classes

**`postMessage` origin & source trust**
A handler performs a sensitive action with `event.data` **without an exact `event.origin` allowlist** (and,
when frames share an origin, the expected `event.source`). Weak substring/prefix/suffix/unanchored-regex origin
matching is **not** an origin check (`origin.indexOf('trusted')`, `origin.endsWith('example.com')` → bypass via
`example.com.evil.com`). On the send side, sensitive data posted to `'*'` reaches any embedder. Seeds:
`rg -n 'addEventListener\(.?.message|onmessage|postMessage|event\.origin|\.origin'`.

**Cross-site WebSocket hijacking**
A WebSocket upgrade accepts **ambient cookies** from an untrusted origin with **no `Origin` check or
channel-specific token**, so a victim’s session reads/mutates data. Confirm both the upgrade behavior and a
security-relevant message handler.

> **The handshake is not subject to CORS or the same-origin policy.** It is an HTTP GET upgrade that any page
> can initiate cross-origin, and the browser sends it **without a preflight**. The application’s CORS
> configuration — however strict — therefore has **no effect** on it: the `Origin` check must be explicit and
> server-side, in the upgrade handler. Finding a tight `cors()` config and concluding the socket is protected
> is a false negative.

Library defaults differ, and several **changed across major versions** — resolve the installed one before
judging, because it decides whether the finding is an *override* or an *absence*:
- **Reject-by-default** → the finding is the **override**. `gorilla/websocket` (`CheckOrigin` compares Host to
  Origin; the bug is an override returning `true`); Spring WebSocket/SockJS (restricted to the current domain
  since **4.1.5** — before that it did not restrict; the bug is a permissive `setAllowedOrigins("*")`);
  (NOT socket.io — see below.)
- **No built-in check** → the finding is the **absence**. Node `ws` performs no origin validation at all and
  leaves it to the application (`verifyClient` / an upgrade-handler check). **`socket.io` belongs here too**:
  its `cors` option governs only the HTTP long-polling transport and never gates the WebSocket handshake
  (<https://socket.io/docs/v4/handling-cors/>), so origin restriction requires `allowRequest`. A tight
  `cors.origin` with no `allowRequest` reads like a control and is not one — this is the trap the whole
  section exists to catch. Current browsers do not send
`SameSite` cookies on a cross-site handshake, but that is **browser behaviour, not source**: treat an explicit
server-side `Origin` check or a channel-specific token as the source-confirmable control, and record any
reliance on `SameSite` under `unverified_assumptions`.

**Credentialed CORS trust**
> **CORS controls who may READ a cross-origin response — never whether the request can be SENT.** Two
> consequences, and both directions are regularly mis-audited: a permissive `Access-Control-Allow-Origin` does
> **not** create CSRF (the request was always sendable; CORS only decided who reads the reply), and a strict
> CORS policy does **not** prevent CSRF. Different classes, different defenses — see the CSRF slot table in
> `SOURCE_TO_SINK.md`.

A **credentialed cross-origin read** needs **all four**; establish each before reporting:
1. `Access-Control-Allow-Credentials: true`;
2. an `Access-Control-Allow-Origin` that **echoes or matches the attacker’s origin** (a literal `*` with
   credentials is browser-rejected — report the reflected/allowlisted path, not the `*`);
3. a response body actually carrying data the attacker cannot already obtain;
4. a credentialed client path (`credentials:'include'` / `withCredentials`) — the attacker’s own page supplies
   that, so what you must show from source is that the **server** would honour it.

Weak origin matching is the usual root cause, and it is the same family as the `postMessage` bugs above:
`startsWith`, `endsWith`, `includes`, unanchored regex, or a `.replace()`-based normalisation
(`origin.endsWith('example.com')` → `example.com.evil.com`; `startsWith('https://example.com')` →
`https://example.com.evil.com`). **`Access-Control-Allow-Origin: null` with credentials is exploitable** from a
sandboxed iframe or a `data:` document — treat `null` as an attacker-reachable origin, not as ’no origin’.
Seeds: `rg -n 'Access-Control-Allow-Origin|cors\(|allowedOrigins|reflect.*origin|Allow-Credentials'` and
`rg -n 'origin.*(startsWith|endsWith|includes|match|test)\('`.
(Config-auditor owns static CORS misconfig; here the angle is **dynamic origin reflection**.)

## Uploaded-content serving & origin isolation

> **Shared class — agree the split before filing.** The **xss-auditor** owns the verdict when the served
> response *executes in the application’s origin* (that is stored XSS, CWE-79, its class). This file owns the
> **origin-isolation** judgement — whether an isolating origin exists, whether it is really isolating, and the
> `Content-Type`/`Content-Disposition`/`nosniff` facts both verdicts rest on. One root cause, one finding:
> whichever auditor reaches it first files it, and the other cites it in `tested_not_vulnerable` rather than
> duplicating it (the Step 6.6 aggregator keys on sink `file:line`, so a duplicate here is visible but wasteful).

Follow one uploaded file through **five** stages — *accept → normalise → store → authorise → serve* — and
render the verdict at the **serve** stage. The upload-side checks (extension allowlist, declared MIME, magic
bytes) are input validation; they are **never** the verdict, because the browser decides what to execute from
the **response**, not from the filename. Auditing only the filter is the classic false negative here; auditing
only the filter and finding it strict is the classic false positive.

**Uploaded-content execution in the app’s origin (stored XSS / HTML injection)**
The response that serves attacker bytes executes in the authenticated origin. Four response-side facts decide
it, and you need all four:
- **Which origin serves it** — the application’s own origin, or an isolated sandbox domain / bucket host with
  no session cookie and no access to app state? Isolation is the strongest control and the one most often
  already present; look for it before anything else.
- **`Content-Type`** — and where it comes from. Derived from the **client-supplied filename extension** or from
  the multipart part’s own `Content-Type` header means it is attacker-controlled. A server-side mapping from
  sniffed magic bytes, or a fixed `application/octet-stream`, is not.
- **`Content-Disposition`** — `attachment` (download, no render) vs `inline` (render in place).
- **`X-Content-Type-Options: nosniff`** — without it a browser may sniff HTML out of a benign declared type.

**`vulnerable`**: served `inline` from the app origin with an attacker-influenced `Content-Type` that renders
(`text/html`, `image/svg+xml`, `application/xhtml+xml`), or sniffable with no `nosniff`.
**safe**: `attachment` + `nosniff`, or served from a genuinely isolated origin — *even when the upload filter
allows HTML*. Say so in `tested_not_vulnerable` with the serving code cited.

**SVG is the recurring miss.** `image/svg+xml` passes every "is it an image?" check — extension, declared MIME,
magic-byte sniffing, and most image libraries — and then executes `<script>` when served `inline`. An
avatar/logo upload that accepts SVG and serves it inline from the app origin is stored XSS. Rasterising on
upload, or serving `attachment`/isolated, closes it.

**Filename reaching a response header**
The stored or echoed filename is interpolated into `Content-Disposition` (or a `Location`). CR/LF or an
unescaped quote injects headers or breaks the disposition out of `attachment`. Hand the framing half to
**http-protocol-auditor**; the disposition-downgrade half is yours.

**Serving path & object authorisation**
The path that serves the file is its own access-control decision, independent of the upload: a predictable or
enumerable key, a public bucket, a signed URL with no expiry or no object binding, or a handler that reads
`?path=` without containment. Traversal/zip-slip on the **write** side belongs to injection-auditor; the
**read** side — "can another tenant fetch this object?" — belongs to access-control / data-lifecycle. Name
whichever you are reporting; do not file both halves as one finding.

Seeds: `rg -n 'Content-Disposition|X-Content-Type-Options|content_type=|mimetype=|guess_type|sendFile|send_file|serve_static|getimagesize|svg'`.

## Service-worker & browser-storage attack classes

**Service-worker registration & scope takeover**
Attacker-influenceable content becomes the registered worker script, controls a path granted an over-broad
`Service-Worker-Allowed` scope, or alters update imports without integrity control. Verify the final script
URL, MIME type, origin, scope, and who controls every `importScripts`. Seeds:
`rg -n 'serviceWorker\.register|Service-Worker-Allowed|importScripts'`.

**Service-worker cache & identity confusion**
The worker caches **personalized** responses without keying on account/tenant/authorization/request-mode, then
serves them after account switch or logout. Review fetch-event routing, cache names/keys, navigation fallbacks,
and cleanup.

**Browser-storage disclosure & stale authorization**
Tokens, private responses, drafts, or authorization decisions persist in `localStorage`/`sessionStorage`/
IndexedDB/Cache Storage and become readable by **another account** or a **less-trusted same-origin component**,
or keep authorizing **after revocation/logout**. Storing a token alone isn’t a finding — require a lower-
authority reader or continued use after logout. Also check `storage` events / `BroadcastChannel` / shared
workers that carry identity between tabs without binding to the current session.

## UI-redress & navigation attack classes

**Clickjacking**
A **framed, state-changing** action lacks effective `frame-ancestors` / `X-Frame-Options` / UI isolation.
Require the sensitive action *and* confirm it completes framed. Missing headers on **read-only** content are
hardening notes. (Config-auditor owns the header presence; here confirm a **sensitive framed action**.)

**Client-side navigation confusion / open redirect / tabnabbing**
A client source controls redirect/navigation without scheme+destination policy, including executable
`javascript:`/`data:` targets. `window.location = params.get('next')`. Reverse tabnabbing applies only where
code explicitly retains `window.opener` / uses `window.open` without `noopener`.

## Verdict & false-positive discipline

`vulnerable` when a controllable browser source reaches an executing/disclosing sink and the impact reaches a
victim session, another origin, or shared storage — with the browser control (framework escaping, CSP, SOP,
exact-origin check, SW scope) shown **absent or bypassable**. `safe` when the sink is fed only framework-escaped
data or the origin/scope check is exact.
- **For prototype pollution, exhibit the recursive write AND a security-relevant gadget.** For DOM clobbering,
  prove the markup survives and the shadowed value is used.
- **For messaging/CORS/WebSocket/storage, show the exact origin/source check is missing/weak and the protected
  state or action exposed** — and confirm CSP/COOP/CORP/SameSite don’t already block it.
- **For CORS, say which of the four conditions you established** (allow-credentials, attacker-matching
  allow-origin, sensitive body, server honouring credentials). A reflected `Access-Control-Allow-Origin` with
  no credentials and no sensitive body is hardening, not a cross-origin read. And never report a permissive
  CORS policy as CSRF — CORS governs reading the response, not causing the request.
- **For uploaded content, render the verdict at the serving response** (origin, `Content-Type` and where it is
  derived from, `Content-Disposition`, `nosniff`) — not at the upload filter. A permissive upload filter with
  `attachment` + `nosniff` on an isolated origin is `tested_not_vulnerable`; a strict extension filter that
  still serves `image/svg+xml` inline from the app origin is `vulnerable`.
- **Self-injection is not a finding** — the reader/victim must have less authority than the writer, or the data
  must cross an origin/session boundary.
- **Deployed CSP/headers/renderer behavior not in the repo → coverage gap**, not a confirmed verdict.
