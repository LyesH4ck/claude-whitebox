# Feature Abuse & Data-Leakage Reference — legitimate features used against the design

Mounted by the **feature-abuse-auditor** (OWASP **A04 Insecure Design** / **A01**). The bug is in the *design*,
not a bad API call: a feature that works exactly as written but can be pointed at data or effects it was never
meant to reach. You look for the gap between what a feature *does* and what its designer *assumed* about who
uses it and how.

- **Use the API the way the frontend never would.** The UI constrains users; the API/handler does not. Ask of
  every feature: what request is *possible* but never *made by the client*?
- **Exploitability bar.** Require a concrete affected principal/resource: another user’s data exported, an
  existence oracle for a record the caller can’t read, a server-side fetch to an internal host. A feature that
  only exposes the *attacker’s own* data is not a finding.
- **Verdict from code**; corroborate live only in hybrid mode with a named observable.

## Attack classes

**Export / backup as exfiltration**
Can a low-privilege user trigger an **export, snapshot, report, or backup** that includes data **above** their
access level — other users’ rows, deleted/draft/private content, pruned revision history, secret fields? Check
**per-item authorization after selection** *and* authorization to **download the final artifact** (a job id or
signed URL that isn’t re-authorized is the common bug). Seeds:
`rg -n 'export|download|report|snapshot|backup|to_csv|dump|zip|stream'`. **vulnerable**: `/export?scope=all`
where `scope` isn’t clamped to the caller’s tenant; a report job whose result URL is guessable.

**Import / restore as injection**
Can **import/restore** overwrite existing data, create records that **bypass normal validation**, inject into
collections the user can’t write, or run with more authority than the UI path? Treat archive/import contents as
untrusted and re-authorize the resulting write. **vulnerable**: CSV/JSON import that sets `owner_id`/`role` from
the file; restore that recreates rows in another tenant.

**Search / filter / sort as an oracle**
Can a query reveal whether content the caller **can’t directly read** exists? Do filter params let users probe
statuses, roles, or fields they shouldn’t know? Does **sorting by a hidden field** leak its values through
result ordering? Does a filter on a related object disclose its existence? Seeds:
`rg -n 'order_by|sort|filter|search|q=|where|__(gt|lt|in|contains)'`. **vulnerable**: `?sort=secret_score`
reorders results by a field the user can’t see; `?filter[owner_id]=X` returns count>0 as an existence oracle.

**Enumeration through side effects**
Do responses differ between **"does not exist"** and **"no access"** — status code, body, size, or **timing**?
Can you enumerate users via **password-reset, invite, or registration**? A different error for a taken vs
unknown email/username is an account oracle. (A response that only reveals *public* existence is not
automatically a finding — name the confidential predicate.) Seeds:
`rg -n 'not found|does not exist|already (exists|registered|taken)|invalid (user|email)'`.

**Preview / draft / staging leakage**
Are **preview/share tokens** scoped to **one** item or do they unlock broader access? Can draft/unpublished
content be discovered through **search, RSS, sitemaps, or an API listing** endpoint? Can **cache headers** make
a CDN serve private content publicly (missing `Cache-Control: private`/`no-store` on an authenticated response)?
**vulnerable**: a preview token that’s really a session; a list endpoint that returns drafts to non-authors.

**Notification / webhook / callback as SSRF**
Can a user set a **notification URL, webhook URL, or callback URL** that the **server fetches**? Is it validated
against internal networks and non-HTTP schemes — **after redirects**? (Hand the deep SSRF trace to the
ssrf-auditor; flag the *feature* that exposes an attacker-controlled server-side fetch and confirm no
allowlist/internal-range block.) Seeds: `rg -n 'webhook|callback|notify_url|redirect_uri|fetch|http.get|requests.get'`.

**Feature-mixing (composition) abuse**
What breaks when features that were never designed together are combined? Localization + preview + caching;
import + plugins + webhooks; OAuth + impersonation + API keys. Read where one feature’s output becomes another’s
trusted input.

## Verdict criteria

`vulnerable` when a legitimate feature, driven directly (not through the UI), reaches **data or a side effect
above the caller’s authority**, with the affected principal/resource named and no control (per-item authz,
artifact re-auth, scope clamp, oracle-suppression, internal-range block) present on that path. `safe` when the
feature re-authorizes per item and per artifact and suppresses the oracle. Downgrade to `probable` when the
enforcement layer wasn’t fully read; `unconfirmed` (→ coverage gap) when the confidential predicate can’t be
exhibited.

- **high** — cross-user/tenant export or import-write, or a webhook feature that yields a confirmed internal
  fetch. **medium** — an existence oracle or a bounded draft leak. **low** — a public-existence differential.

## False-positive discipline

- **Attacker’s own data is not a finding.** Exporting/searching one’s own records is the feature working.
- **Public existence is not confidential.** An enumeration oracle is only a finding when it discloses a
  *confidential* predicate (a private record, a role, an internal status).
- **Name the observable distinction** for oracles — a concrete status/size/timing/body difference, not "the
  response might vary."
- **Don’t double-report SSRF/IDOR/logging.** Flag the *feature-abuse design gap*; the deep taint trace belongs
  to the ssrf/access-control/logging auditors — cross-reference rather than duplicate.
