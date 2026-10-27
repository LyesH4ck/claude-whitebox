# Federated Identity & Session Reference — verification and binding defects

Mounted by the **auth-auditor** as a depth extension beyond password/JWT-basics. Where the auth-auditor’s core
covers hashing, session tokens, and `alg:none`, this file covers the **binding and verification** defects of
federated identity, strong auth, account transitions, and service credentials. The question is not "does a
check exist" but "is the artifact whose signature is verified the **same** artifact used as identity, and is it
bound to the right principal/session/audience/action?"

- **For every credential, find the signature/secret verification AND every binding required for its role**:
  issuer, audience, origin, RP, client, session, principal, resource, assurance, expiry, one-time state.
- **A missing header/attribute/MFA-prompt/rate-limit is not a finding alone** — require an accepted invalid
  request, cross-principal impact, assurance downgrade, or credential disclosure.
- **Verdict from code.** IdP policy, proxy config, browser cookie behavior, and deployed secrets that aren’t in
  the repo → coverage gap.
- **First establish role.** Authorization-server controls (redirect allowlisting, code issuance) belong to the
  AS, not a relying-party client. Verification/binding defects belong to the component **consuming** the artifact.

## Session & browser-credential classes

**Session fixation & invalidation**
Session identifiers must **rotate** on login, account switch, MFA completion, impersonation, and privilege
change, and must be **invalidated** on logout, password change, revocation, and account disable. Check server
sessions, refresh tokens, signed cookies, websocket state, and cache copies. Seeds:
`rg -n -i 'session\.(regenerate|rotate|renew)|req\.session|login|logout|invalidate|destroy.*session'`.
**vulnerable**: no `session.regenerate()` after login (fixation); session still valid after password change.

**Cookie scope & transport** — a sensitive cookie with over-broad `Domain`/`Path`, or that crosses insecure
transport, or conflicts with a sibling cookie another component selects differently. Bare missing flags stay
hardening unless a realistic less-trusted origin/network position/browser path can gain or replace the
credential. (Config-auditor owns flag presence; here own the **scope/collision** angle.)

**`SameSite` is a cross-site *request* control, not a scope control** — and it is the attribute most often
over-credited. `Strict` blocks the cookie on every cross-site request; **`Lax` still sends it on a top-level
GET navigation**; `None` blocks nothing (and requires `Secure`); **absent** means a browser default, which is
an `unverified_assumptions` entry, not a source-confirmed control. Reading an attribute off a `set_cookie`
call therefore does **not** settle whether a handler is CSRF-able — the method and the effect do. The full
model, the browser-emittable request shapes, and what each defense (token, `Origin`, **Fetch Metadata**,
content-type enforcement) actually covers live in `SOURCE_TO_SINK.md` → **CSRF slots**. Own the cookie
*attribute* question here; take the CSRF *verdict* from there.

**Domain-scoped cookies and same-site attackers.** A cookie scoped to the registrable domain is readable and
**writable** by every subdomain. That breaks naked double-submit CSRF tokens, session-fixation defenses, and
any "the cookie proves it came from us" assumption: an XSS or a takeover on `blog.example.com` is inside the
boundary for `app.example.com`. Where a subdomain is third-party-controlled (a CMS, a status page, a customer
vanity host), say so explicitly — it converts several "requires XSS on the app" preconditions into
"requires XSS anywhere on the domain".

## Federated-identity classes

**JWT verification & claim binding** (beyond `alg:none`)
Check signature verification, **server-pinned** algorithm and key source, then `exp`, `nbf`, `aud`, `iss`.
Review `kid`, `jku`, `x5u` as **untrusted key selectors** (SSRF/key-injection), duplicate/normalized headers,
and decode-without-verify paths. **A valid token for another service is invalid here even when signed by a
trusted issuer** — confirm `aud` binds to *this* RP. Seeds:
`rg -n -i 'jwt\.(decode|verify)|verify\(|algorithms|jwks|kid|jku|x5u|audience|aud'`.

**OAuth/OIDC request & callback binding**
Validate: exact `redirect_uri` ownership (where target is the AS); **session-bound `state`**; PKCE and
authorization-code binding; ID-token issuer/audience/signature/nonce; and **selected-IdP binding** in
multi-provider flows. Compare initial callback, retry, mobile/deep-link, and account-link routes. Seeds:
`rg -n -i 'redirect_uri|state|code_verifier|pkce|nonce|id_token|authorization_code|oauth|oidc'`. **vulnerable**:
callback accepts any `state` (CSRF/login-CSRF), or trusts an ID token without checking `aud`/`iss`/`nonce`.

**SAML signed-object & assertion binding** — ensure the element whose signature is validated **is** the element
used as identity (XML-signature wrapping). Review unsigned/fallback paths, safe XML parser config (XXE),
canonicalization differences, and freshness/binding (validity window, audience/recipient, request correlation,
replay state). Seeds: `rg -n -i 'saml|Assertion|Signature|SignedInfo|samlp|Response'`.

## Strong-auth & account-transition classes

**MFA enrollment & assurance downgrade** — enrollment, replacement, disablement, recovery-code generation,
trusted-device creation, and fallback login require the **intended prior assurance**. A valid first factor must
not enroll/replace the second factor without policy-required fresh auth; disabled/stale factors must stop
authorizing.

**Step-up binding & bypass** — a successful challenge must not upgrade the **wrong** session/account/tenant/
action, and no alternate route may omit the assurance check. Bind the challenge to principal, current session,
assurance target, operation/resource, expiry, and one-time completion. Compare UI, API, batch, recovery, and
resumed-flow paths.

**WebAuthn / passkey verification** — at registration bind challenge, RP ID, expected origin, credential,
user/userHandle, algorithm, and user verification to the initiating session; at authentication verify challenge,
RP/origin, credential membership, signature, and presence/verification. Check account-discovery/linking for
**userHandle or credential-to-account confusion**. Seeds: `rg -n -i 'webauthn|publicKey|attestation|assertion|rpId|userHandle|challenge'`.

**Account linking & identity collision** — adding an IdP/passkey/email/phone/device to an existing account must
require a current authenticated session, **verified ownership** of the new identity, policy step-up, and callback
state bound to the initiating account. Review unlink/relink and invite-acceptance for verified-identifier or
tenant collisions.

**Password reset & broader recovery** — recovery tokens, support/admin recovery, backup codes, device migration,
and email/phone change are often the **weakest** auth path. Verify token randomness (CSPRNG), user/action
binding, expiry, one-time state, rate/accounting, **delivery-URL trust (host-header poisoning → see
HTTP_PROTOCOL)**, and invalidation of prior tokens and sessions. (A response that only reveals *public* account
existence is not automatically a finding.)

## Service-credential classes

**API-key scope & resource binding** — a key authenticates to broader tenants/resources/actions/environments
than its server-side record grants, or request params override those bindings. Review key lookup, prefix vs
full-secret verification, **publishable-vs-secret type confusion**, scope checks, rotation, revocation caches,
and bulk endpoints. **API-key exposure** — keys in client bundles, URLs, redirects, logs, error paths, build
artifacts, or lower-trust responses (a *public identifier* called a key is not a secret — confirm the authority
disclosure grants).

**mTLS peer & identity confusion** — a process trusts client-cert **identity headers from any network peer**,
verifies a chain but maps attacker-influenceable subject text to an account wrongly, or accepts a cert for the
wrong trust domain/usage/audience. Where a trusted proxy terminates mTLS, verify only that proxy can connect, it
**strips** incoming identity headers, and the backend binds the sanitized identity. **Certificate lifecycle
fallback** — expired/revoked/missing certs causing silent fallback to bearer-only/anonymous (an in-repo
fail-open branch is source-confirmable; missing revocation data → coverage gap).

## Verdict & false-positive discipline

`vulnerable` cites the verification line and the **missing binding** (principal/session/resource/origin/
audience/action/assurance) and proves the server **accepts the invalid transition or credential**. `safe` when
the consumed artifact is the verified one and every role binding is checked.
- **Establish role first** — don’t fault a client for AS-side controls, or vice versa.
- **A valid credential for another audience/service is invalid here** — the bug is the missing `aud`/RP binding,
  not the signature.
- **Verify framework/library defaults and version** — if unknown, record a coverage gap; don’t downgrade an
  unverified critical into a lower-severity confirmed finding.
- IdP policy, proxy mTLS termination, browser cookie behavior, and deployed secrets outside source → coverage
  gap with the exact unresolved fact.
