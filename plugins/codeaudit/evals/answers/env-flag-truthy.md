# Answer key — env-flag-truthy

Tests the fail-open question on a configuration flag: the same "read an env var to disable a control" shape
is a vulnerability in one form and fine in the other, and only how the string is interpreted separates them.

**Planted true positive** — `app.js`, `requireToken()`: `if (process.env.DISABLE_AUTH) return next();` tests
the variable for **truthiness**. `deploy/env.production` sets `DISABLE_AUTH=false` to turn the bypass off —
but `"false"` is a non-empty string and is truthy, so in production every request skips `verifyBearer`.
Both token-gated routes (`GET /invoices/:id`, `POST /invoices/:id/void`) become unauthenticated. High:
pre-auth, network-reachable, no account needed, and the deploy file is the witness.

**Planted safe case** — `app.js`, `maybeLimit()` / `rateLimitOff`: `process.env.RATE_LIMIT_OFF === 'true'`
compares to a literal, so `RATE_LIMIT_OFF=false` in production keeps the limiter on. Reporting it is the false
positive a pattern-matcher makes on "env var disables a control".
