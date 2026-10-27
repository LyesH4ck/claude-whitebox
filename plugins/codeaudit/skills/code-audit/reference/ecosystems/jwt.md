# JWT / token review reference (cross-language)

Load **whenever** a JWT, JWS or JWE header or claim influences a principal, tenant, role, permission, scope,
ownership check or protected resource. Additive — load it alongside the language file.

Token parsing used **only** for logging, display, or a non-security cache key is **not** an authorization
finding. Establish that the claims reach a decision before writing anything.

---

## The two questions, in order

1. **Is the signature verified at all, with a key and algorithm the server pins?**
2. **Is the verified token bound to *this* request** — this relying party, this principal, this session, this
   tenant, this resource, this operation, this moment?

Most real JWT findings are question 2. A valid signature proves possession of an issuer's signing key. It does
**not** prove that this service is the intended audience, that an access token may be used as an ID or session
token, that a role or scope applies to the **selected tenant or object**, or that a token issued before a
permission change is still authorized.

---

## Version facts to check

**Node `jsonwebtoken` ≤ 8.5.1 → 9.0.0** — CVE-2022-23540 (no explicit `algorithms` + falsy key → `none`),
CVE-2022-23539 (invalid key-type/algorithm pairs, e.g. DSA key with `RS256`), CVE-2022-23541 (weak custom key
retrieval → asymmetric public key verified as `HS256`).
Source: <https://auth0.com/docs/secure/security-guidance/security-bulletins/2022-12-21-jsonwebtoken>
→ 9.0.0 closes `alg:none` and key-type confusion. `allowInvalidAsymmetricKeyTypes: true` re-opens the latter.

**Python `PyJWT` < 2.4.0 — CVE-2022-29217.** Key confusion when the application permits **both** asymmetric
and HMAC algorithms and supplies a public key in a format the older blocklist did not recognise. A pinned
asymmetric algorithm with the matching public key is **not** this vulnerability. PyJWT's docs warn never to
derive the `algorithms` argument from token data.
Source: <https://github.com/jpadilla/pyjwt/security/advisories/GHSA-ffqj-6fqr-9h24>
→ Confirm the installed module is PyJWT and not another package imported as `jwt`.

**Go `golang-jwt/jwt` v4 ≤ 4.5.0 — CVE-2024-51744 → 4.5.1.** Caller error handling that checks only a
combined non-signature error can accept a token whose signature failed. For v5: `WithValidMethods` is the
algorithm allowlist; `exp` is optional unless `WithExpirationRequired()`; `WithIssuer`/`WithAudience` require
and validate their claims. Source: <https://pkg.go.dev/github.com/golang-jwt/jwt/v5>
→ The bug is in the **caller's `if err != nil` block**; the version alone is not a finding.

**Java `jjwt` / `nimbus-jose-jwt`** — `Jwts.parser().setSigningKey(k).parseClaimsJws(t)` verifies;
`parseClaimsJwt` (no `s`) and any `parse` on an unsecured JWT do not. In Nimbus, a `JWSVerifier` chosen from
the token's own header rather than from pinned configuration is key confusion.

**.NET `System.IdentityModel.Tokens.Jwt`** — `TokenValidationParameters` with `ValidateIssuer = false`,
`ValidateAudience = false`, `ValidateLifetime = false`, or `SignatureValidator` returning an unvalidated token
are the explicit opt-outs. `ValidateIssuerSigningKey = false` with a non-null `IssuerSigningKey` still
verifies; read the whole object, not one flag.

---

## Verification requirements (version-independent)

For a verified token, establish **all** of these from the actual call site:

- The accepted **algorithm or key family is fixed by trusted configuration**, not selected from the token's
  own `alg` header. An explicit algorithm list is the usual form; a pinned library + a typed key object that
  admits only one family is equally good — do not demand a literal list when the key type already enforces it.
- A **`kid` selects from a trusted, bounded key set**, not from a caller-chosen file path, URL, embedded JWK,
  or another tenant's key. Treat `kid`, `jku`, `x5u` and an embedded `jwk` as **attacker-controlled metadata**
  until a trusted issuer configuration constrains them. A `jku`/`x5u` fetched by the server is also **SSRF** —
  file it with the SSRF auditor as a chain.
- **Issuer, audience, subject/token-purpose, `exp` and `nbf`** are checked where they separate trust domains.
- **Role, tenant and scope claims are bound to the resource and operation** they authorize — a `scope:admin`
  that is never checked against the **target tenant** authorizes nothing in particular.
- **Verification errors cannot fall through to an allow path.** Inspect the `catch`/`err != nil`/`except`
  branch: a swallowed exception that leaves a partially-built principal is the fail-open shape.
- **Absent token ≠ anonymous-but-allowed.** Run the `SKILL.md` fail-open question: if the header/cookie is
  missing, null or empty, is the protected operation still reachable?

---

## Safe or non-reportable forms

- **Decoding before verification** to read the untrusted `kid` and select a key from a **trusted bounded key
  set**, with claims consumed only **after** verification — safe. This is the normal JWKS pattern; do not
  report `decode` on sight.
- `algorithms` supplied through a wrapper, a shared helper, or trusted configuration rather than at the call
  site — read the wrapper before calling it missing.
- An application supporting **both** HMAC and asymmetric families through **separate verification paths with
  separate keys** — that is not key confusion. Key confusion requires one verifier that accepts a key of the
  wrong family for the token's declared algorithm.
- **Missing `aud`** when the issuer mints tokens for exactly one service and no second token type or relying
  party crosses the boundary — establish a second trust domain before reporting it.
- **Long-lived tokens without revocation** — not automatically an authorization bypass. Establish a product
  promise (logout invalidates, permission change takes effect, deactivation is immediate) or a
  permission-change path that *requires* invalidation. The documented trade-off of a stateless session is a
  `design_properties` entry, not a finding.
- A **stolen-token prerequisite**. If the attack starts with "the attacker has the victim's valid token", the
  precondition subsumes the conclusion — see the circularity rule in `SKILL.md`. The finding must *obtain* or
  *forge* the token, not assume it.
- Generic advice to validate every optional claim — hardening at best, not a finding.

---

## Commands

```bash
# which library, which version — decides half the rows above
rg -n '"(jsonwebtoken|jose|jwt-decode)"' package.json package-lock.json 2>/dev/null
rg -n '^(pyjwt|python-jose|authlib)' -i requirements*.txt pyproject.toml 2>/dev/null
rg -n 'golang-jwt/jwt' go.mod 2>/dev/null
rg -n 'jjwt|nimbus-jose-jwt|java-jwt' pom.xml build.gradle* 2>/dev/null
rg -n 'System\.IdentityModel\.Tokens\.Jwt|Microsoft\.IdentityModel' --glob '*.csproj' 2>/dev/null

# verify vs decode (the core distinction)
rg -n 'jwt\.(verify|decode|sign)|jwt\.decode\(|parseClaimsJws|parseClaimsJwt|ParseWithClaims|ParseUnverified'
rg -n 'verify=False|options=\{[^}]*verify|verify_signature'

# algorithm pinning + key selection
rg -n 'algorithms\s*[:=]|WithValidMethods|setSigningKey|alg\b|HS256|RS256|none'
rg -n '\bkid\b|\bjku\b|\bx5u\b|jwks|JWKS|getKey|keyResolver|SigningKeyResolver'

# claim binding
rg -n 'audience|\baud\b|issuer|\biss\b|\bnonce\b|\bexp\b|\bnbf\b|ValidateAudience|ValidateIssuer|ValidateLifetime'

# fail-open shapes around verification
rg -n 'catch\s*\(|except .*:|if err != nil' -A3 --glob '*auth*' --glob '*jwt*' --glob '*token*'
```
