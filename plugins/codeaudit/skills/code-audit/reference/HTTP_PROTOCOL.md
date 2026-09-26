# HTTP-Protocol Reference — framing, caching, and header trust

Mounted by the **http-protocol-auditor** (OWASP **A05 Misconfiguration** / **A06**). Where access-control asks
*may this principal do this?*, this file asks whether the **HTTP layer can confuse which request, response, or
cache key an operation belongs to**. Reachable surface is proportional to how much request parsing/caching the
code owns: a single app behind a managed proxy has little; a **custom HTTP parser, reverse proxy, CDN edge
logic, or cache layer** has much.

- **Framing and cache findings require TWO interpretations of the same request/response/key.** Name **both**
  components and the exact normalized value each assigns. One parser alone is not a desync.
- **Host / `Forwarded` / `X-Forwarded-*` / `Origin` / `Referer` / redirect targets / request-derived URLs are
  trust decisions.** Trace each to the affected identity or response.
- **A missing header/attribute is not a finding alone** — require an accepted invalid request, a cross-user/
  cross-cache impact, or a security-relevant response change.
- **Verdict from code.** Proxy chains, edge cache keys, and deployed proxy config that aren’t in the repo →
  coverage gap, not a confirmed finding.

## Attack classes

**Request framing & desynchronization (smuggling)**
Front end and back end disagree on request **length or header normalization**. Review: multiple
`Content-Length` values; `Content-Length` + `Transfer-Encoding` together; `Transfer-Encoding: chunked`
obfuscations (`Transfer-Encoding : chunked`, duplicated, cased); HTTP/2→1 or HTTP/3 **downgrade**; header-name
normalization; forbidden connection headers; CR/LF conversion. Confirm **which bytes one component assigns to a
request and which its peer assigns to the next**. Seeds:
`rg -n -i 'content-length|transfer-encoding|chunked|parseRequest|readHeaders|http2|downgrade|\r\n'`. Most likely
in a custom server, proxy, or hand-rolled parser — not a framework’s stock handler.

**Web cache poisoning through unkeyed input**
A request value **changes cached content or security-relevant headers but is absent from the cache key**.
Compare cache-key construction against every response variant: forwarded host/scheme, selected cookies, query
normalization, language/device headers, authorization state. Seeds:
`rg -n -i 'cache.?key|vary|cacheable|s-maxage|surrogate-key|cdn|varnish|cache-control'`. **vulnerable**: the
response reflects `X-Forwarded-Host` into an absolute URL but the cache key omits it.

**Cache deception & private-response caching**
Cache routing treats a **private dynamic path as a public static asset**, or caches a response whose identity/
authorization inputs aren’t in policy. Compare edge cacheability with application route parsing — suffix/
path-parameter normalization (`/account/profile.css`, `/api/me;.js`), and whether an authenticated response
carries `Cache-Control: private|no-store`. **vulnerable**: `/account` served under a rule that caches `*.css`
because the router ignores a trailing `.css`.

**Host & forwarded-header trust**
Untrusted **Host / proxy metadata** determines absolute URLs, tenant routing, callbacks, **password-reset
links**, cache keys, or the client address used by authorization/rate-limiting. Confirm **who can supply the
header** and whether trusted ingress strips client-provided copies. Seeds:
`rg -n -i 'X-Forwarded-For|X-Forwarded-Host|X-Real-IP|Forwarded|req\.host|request\.host|getHeader\(.host|HTTP_HOST|url_for.*_external|absolute_url'`.
**vulnerable**: a reset link built from `Host`/`X-Forwarded-Host` (poisoned reset); rate-limit/authz keyed on a
client-settable `X-Forwarded-For`.

**Response-header injection / splitting**
Untrusted data reaches `Location`, `Set-Cookie`, CSP, or another response header with unsafe **control
characters** (`\r`, `\n`, ` `) or normalization. Verify the framework/runtime **rejects** CRLF before
reporting (most modern stacks do) and require a security-relevant response change. Seeds:
`rg -n -i 'setHeader|addHeader|header\(|Location:|Set-Cookie|writeHead'` with a user value.

## Verdict criteria

`vulnerable` requires the concrete effect: for **framing**, name both components and the divergent parse and a
cross-request/cross-user impact; for **cache**, name the unkeyed input and the poisoned/deceived response with
its security relevance; for **host-header**, the trusted sink (reset link, absolute URL, authz key) that
consumes the attacker-settable header with no allowlist/ingress-strip; for **header injection**, the accepted
control character and the changed response. `safe` when the parser rejects the ambiguity, the cache key
includes the input, ingress strips client headers, or the runtime blocks CRLF.

- **high** — a source-confirmed desync or a poisoned cache serving cross-user content; a host-header poisoned
  password reset. **medium** — cache deception on a bounded private path.
- Downgrade to `probable` when only **one** side of the framing/cache pair is source-visible.

## False-positive discipline

- **Desync needs two disagreeing parsers.** A single framework handler that normalizes consistently is not
  smuggling — do not flag on a lone `Transfer-Encoding` string.
- **The peer proxy/CDN is often deployment, not repo.** If the second interpretation lives in infra you can’t
  read, record a **coverage gap** naming the exact proxy/cache behavior an owner must confirm.
- **Modern runtimes reject CRLF in headers** — verify the specific version/API doesn’t before claiming response
  splitting.
- **A missing `Cache-Control`/`Vary` alone is hardening** unless you can show a concrete private-response cache
  or a poisoned variant.
