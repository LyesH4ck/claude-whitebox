# Go review reference

Load when `go.mod` is present. Covers `net/http`, chi, Gin, Echo, Fiber, gRPC interceptors, `database/sql`,
GORM/sqlx, `html/template` vs `text/template`, `os/exec`, `encoding/gob`, YAML loaders, and gorilla/websocket.

Resolve versions from `go.mod` (the toolchain line and the `require` block) and `go.sum`. The **Go toolchain
version itself** decides several rows below — read `go` / `toolchain` in `go.mod` and the CI/Dockerfile image.
See `README.md` for the version-sensitivity rule.

---

## Version facts to check

**`html/template` — script-context escaping bugs.**
- **CVE-2023-39319**: the parser could consider a `<script>` context terminated early, escaping actions
  incorrectly → XSS. Fixed in **go1.20.8** and **go1.21.1**.
  Source: <https://pkg.go.dev/vuln/GO-2023-2043>
- **CVE-2023-24538** (templates with actions in a **JavaScript** context, e.g. inside backticks) was fixed in
  **go1.19.8** / **go1.20.3**; that fix also made some previously-accepted templates error at parse time.
→ Both require a toolchain below the cutoff **and** a template that puts an action in a JS/script context.
Run `govulncheck` — it resolves toolchain-level advisories and call-graph reachability in one step and is the
right tool to cite here.

**`text/template` is not an escaping package at any version.** Rendering user data into HTML with
`text/template` is XSS by construction — no CVE, no cutoff, nothing to check. The import line **is** the
finding. This is the single highest-signal grep in a Go web audit.

**`golang-jwt/jwt` v4 ≤ 4.5.0 — CVE-2024-51744.** Caller error handling that inspects only a combined
non-signature error can accept a token whose signature failed. **4.5.1** returns immediately on dangerous
signature failures. For v5, `WithValidMethods` is the explicit algorithm allowlist; note that `exp` is
**optional** unless `WithExpirationRequired()` is used, while `WithIssuer`/`WithAudience` require and validate
their claims. Source: <https://pkg.go.dev/github.com/golang-jwt/jwt/v5>
→ The vulnerable condition is **incorrect caller error handling**; the dependency version alone is not a
finding. Read the `if err != nil` block at the call site.

**`net/http` — protocol-level DoS rows** (HTTP/2 rapid reset, CONTINUATION flood, etc.) move with the
toolchain. Do not enumerate them from memory: run `govulncheck ./...` and cite its output. It distinguishes
"module in the graph" from "vulnerable symbol actually reachable", which is exactly the reachability bar
`SKILL.md` requires.

---

## Framework defaults

**Routing and authz.** `net/http`, chi, Gin, Echo and Fiber are **allow-by-default**. A guard is middleware,
and middleware is scoped to where it is mounted:
- chi: `r.Use()` applies to the router it is called on; `r.Group(func(r chi.Router){ r.Use(auth); ... })` and
  `r.Route("/admin", ...)` create sub-scopes. A handler registered on the **parent** before the group is not
  covered.
- Gin: `r.Group("/api", AuthMiddleware())` vs `r.GET(...)` registered on the bare engine.
- gRPC: `UnaryInterceptor`/`StreamInterceptor` are **global**; a per-method authz decision must still happen
  inside the interceptor or the handler. A single interceptor that only checks *authentication* leaves every
  method unauthorized.
- `context.Value` is the usual principal carrier. Trace the **type assertion**: `ctx.Value(userKey).(*User)`
  with the comma-ok form discarded panics or yields a zero value — a `user, _ := ...` that proceeds with
  `nil` is fail-open. This is the mandatory fail-open question from `SKILL.md` in its most common Go shape.

**`database/sql`.** `db.Query("... WHERE id = ?", id)` is parameterized; `fmt.Sprintf` into the query string is
not. **Identifiers are not bindable** — `ORDER BY ?` does not work, so a sortable column from a request is an
allowlist problem by construction. GORM parameterizes its builder but `Raw`, `Exec`, `Where("x = " + v)`,
`Order(userInput)` and `Select(userInput)` are escape hatches. `sqlx.In` expands slices safely; manual
`strings.Join` of placeholders with values is not.

**Path handling.** `filepath.Join` **cleans** the result (`a/../../b` → `../b`) but does **not** contain it
within a root. The containment check is explicit:
`abs, _ := filepath.Abs(filepath.Join(root, user)); strings.HasPrefix(abs, rootAbs+string(os.PathSeparator))`.
`http.ServeFile` warns in its own docs that the path must not be taken directly from the request;
`http.FileServer` + `http.Dir` does contain, and `os.Root` (Go 1.24+) is the modern primitive. On Windows,
`strings.HasPrefix` without case-folding is bypassable.

**`gorilla/websocket`.** The **default `CheckOrigin` rejects cross-origin requests**, which is safe — but a
`CheckOrigin: func(r *http.Request) bool { return true }` override is extremely common and is
cross-site WebSocket hijacking when the connection is cookie-authenticated. Grep for the override, not the
import.

---

## Dangerous APIs

- **Command execution** — `exec.Command("sh", "-c", userString)`, `exec.Command(userProgram, ...)`,
  `exec.CommandContext` with a computed name. `exec.LookPath` resolving a relative/`PATH`-derived program.
- **Templates** — `text/template` rendering into HTML (above); `template.HTML(v)`, `template.JS(v)`,
  `template.URL(v)`, `template.HTMLAttr(v)` — these four conversions **disable escaping for that value** and
  are Go's `dangerouslySetInnerHTML`. A `template.HTML(userInput)` is XSS, full stop.
- **Deserialization** — `encoding/gob` on untrusted bytes, `gopkg.in/yaml.v2` `Unmarshal` into `interface{}`
  (v3 is stricter), `json.Unmarshal` into a struct with embedded `interface{}` plus a type switch.
- **Mass assignment** — `json.Unmarshal(body, &model)` straight into a persistence model, or GORM
  `db.Model(&u).Updates(userMap)` with a request-derived `map[string]interface{}`. Struct tags (`json:"-"`)
  are the control; a field without one is writable.
- **SSRF** — `http.Get`, `http.Client.Do` with a computed URL. The default `http.Client` **follows up to 10
  redirects**: an allowlist checked before `Do` and not re-applied in `CheckRedirect` is bypassable. Set
  `CheckRedirect` to re-validate each hop.
- **Crypto** — `math/rand` (and `math/rand/v2`) for tokens/session ids — `crypto/rand` is the only correct
  source; `crypto/md5`/`sha1` for passwords; `tls.Config{InsecureSkipVerify: true}`; `==` on secrets instead
  of `crypto/subtle.ConstantTimeCompare`.
- **Resource exhaustion** — `io.ReadAll(r.Body)` with no `http.MaxBytesReader`, `encoding/json` decoding into
  an unbounded structure, `regexp` is RE2 (no catastrophic backtracking — **do not report ReDoS on Go
  stdlib regexp**), unbounded goroutine spawn per request.

---

## Safe or non-reportable forms

- `db.Query("SELECT ... WHERE id = ?", id)` / `$1` / named binds — parameterized.
- `exec.Command("git", "clone", userURL)` — argv form with a literal program; the argument is not shell-parsed.
  (Still check the program's **own** argument semantics: a `--upload-pack=` style option injection is a
  different, real bug.)
- `html/template` with an action in an **HTML-text** slot on a current toolchain — escaped and context-aware.
  `html/template` is genuinely good; the findings are the `template.HTML`/`template.JS` conversions and
  `text/template`.
- `gorilla/websocket` with the **default** `CheckOrigin` — origin-checked. Only an override returning `true`
  unconditionally is the finding.
- `math/rand` for jitter, backoff, load-balancer choice, sampling, or test data — not a crypto finding.
- **ReDoS claims against `regexp`** — Go's RE2 engine has linear-time guarantees. Not a finding unless the
  code uses a third-party backtracking engine (e.g. `regexp2`) or the cost is in input **size**, not pattern.
- `InsecureSkipVerify: true` in a test file, a local dev tool, or against a pinned self-signed cert whose
  verification is done manually via `VerifyPeerCertificate` — read the surrounding config before reporting.
- A missing middleware on a handler whose **only** registration is inside a guarded `Group`/`Route` — resolve
  the composed router.

---

## Commands

```bash
# toolchain + resolved advisories (preferred over memory for every net/http + stdlib row)
rg -n '^go |^toolchain |FROM golang:' go.mod Dockerfile* 2>/dev/null
govulncheck ./... 2>/dev/null || echo "govulncheck unavailable -> record a coverage_gaps entry"

# the single highest-signal Go web grep
rg -n '"text/template"'
rg -n 'template\.(HTML|JS|URL|HTMLAttr|CSS|JSStr)\('

# command execution
rg -n 'exec\.Command(Context)?\(|"sh", "-c"|"bash", "-c"|LookPath'

# SQL incl. identifier slots
rg -n 'fmt\.Sprintf\(.*(SELECT|INSERT|UPDATE|DELETE|WHERE|ORDER BY)|\.Raw\(|\.Exec\(|Order\(|Select\('

# deserialization / mass assignment
rg -n 'encoding/gob|gob\.NewDecoder|yaml\.Unmarshal|json\.Unmarshal\([^,]+,\s*&'
rg -n 'Updates\(|map\[string\]interface\{\}'

# path containment
rg -n 'filepath\.Join\(|http\.ServeFile|os\.Open\(|os\.ReadFile\(|os\.Root'
rg -n 'HasPrefix\(.*filepath\.(Abs|Clean)'   # the containment check — its ABSENCE is the finding

# authz surface + fail-open type assertions
rg -n 'r\.Use\(|r\.Group\(|r\.Route\(|UnaryInterceptor|StreamInterceptor|ctx\.Value\('
rg -n 'ctx\.Value\([^)]+\)\.\(\*?\w+\)' -A1          # non-comma-ok assertion
rg -n ':?=\s*ctx\.Value\([^)]+\)\.\(\w+\),?\s*_\s*\)' # comma-ok with the bool discarded

# websocket origin
rg -n 'CheckOrigin'  -A2

# SSRF redirect re-validation + TLS + crypto
rg -n 'http\.Get\(|client\.Do\(|CheckRedirect|InsecureSkipVerify'
rg -n 'math/rand|crypto/md5|crypto/sha1|ConstantTimeCompare|MaxBytesReader'
```
