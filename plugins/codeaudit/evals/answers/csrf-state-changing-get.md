# Answer key — csrf-state-changing-get

**Kept outside `fixtures/` on purpose.** The fixture is the tree the audit reads; an answer key inside it
tells the auditor where to look and what to call safe, which voids both halves of the measurement.

**Planted true positive** — `server.js`, the `GET /api/email` handler. It changes state on a GET while the
session cookie is `SameSite=Lax`, which still sends the cookie on a top-level navigation. Reachable from any
origin via `window.location`, a link, or `<form method=GET>`.

**Planted safe sibling** — `server.js`, the `POST /api/display-name` handler. Same kind of operation,
protected by an exact `Origin` allowlist plus a session-bound token, on a method `Lax` already blocks
cross-site.
