# Answer key — jwt-version-gate

Tests the version discipline: the same pattern is a finding on one library version and not on another, and
the lockfile is the only thing that says which.

**Planted safe case** — `auth.js`, `currentUser()`: `jwt.verify(token, SECRET)` with no explicit
`algorithms`. On `jsonwebtoken` 8.x this is CVE-2022-23540 territory; `package-lock.json` pins **9.0.2**,
where the implicit `none` fallback was removed. Reporting it as an `alg:none` bypass is the false positive a
pattern-matcher makes.

**Planted true positive** — `auth.js`, `isAdmin()`: `jwt.decode()` does not verify a signature, and the
resulting claim decides authorization. A finding at every version; no upgrade fixes it.
