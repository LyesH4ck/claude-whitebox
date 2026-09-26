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

**Credentialed CORS trust**
The server **reflects or weakly matches `Origin`** while allowing credentials and returns sensitive data. A bare
`*` with credentials is browser-rejected — report only the actual **reflected/allowed** origin path. Seeds:
`rg -n 'Access-Control-Allow-Origin|cors\(|allowedOrigins|reflect.*origin|Allow-Credentials'`. (Config-auditor
owns static CORS misconfig; here the angle is **dynamic origin reflection**.)

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
- **Self-injection is not a finding** — the reader/victim must have less authority than the writer, or the data
  must cross an origin/session boundary.
- **Deployed CSP/headers/renderer behavior not in the repo → coverage gap**, not a confirmed verdict.
