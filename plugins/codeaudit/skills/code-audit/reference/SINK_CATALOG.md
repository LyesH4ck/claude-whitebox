# Sink Catalog — grep-able dangerous operations by language

A starting set of dangerous sinks for the `code-recon` baseline and the auditors. Use these as ripgrep
seeds, then trace each hit source→sink per `SOURCE_TO_SINK.md`. Not exhaustive — frameworks add their
own. Always confirm the match is the real dangerous API, not a same-named safe helper.

> Tip: run from the repo root, e.g.
> `rg -n --type-add 'web:*.{js,ts,jsx,tsx,py,php,rb,go,java,cs}' -t web 'PATTERN'`

## SQL / NoSQL injection
- **JS/TS**: `.query(`, `.raw(`, `sequelize.query`, `knex.raw`, `$where`, `.find(` with built objects, template-literal SQL
- **Python**: `cursor.execute(` with `%`/`.format`/f-string, `text(` (SQLAlchemy raw), `extra(`, `RawSQL`
- **PHP**: `mysqli_query`, `->query(`, `PDO::query` (non-prepared), string-built SQL
- **Java**: `Statement.execute*`, `createQuery(` with concat, `createNativeQuery`
- **Go**: `db.Query(`/`Exec(` with `fmt.Sprintf`
- **Ruby**: `where("...#{}")`, `find_by_sql`, `execute(`

## OS command injection
- **JS/TS**: `child_process.exec(`, `execSync(`, `spawn(..., {shell:true})`
- **Python**: `os.system`, `subprocess.*(shell=True)`, `os.popen`, `commands.*`
- **PHP**: `system`, `exec`, `shell_exec`, `passthru`, `proc_open`, backticks
- **Java**: `Runtime.exec`, `ProcessBuilder` with shell
- **Go**: `exec.Command("sh","-c", ...)`
- **Ruby**: backticks, `system(`, `%x()`, `Open3`

## File / path / inclusion
- read/write: `open(`, `readFile`, `createReadStream`, `fs.*`, `file_get_contents`, `fopen`, `File.read`
- include: `require(`/`include(` (PHP dynamic), `__import__`, `importlib`, dynamic `require()` (JS)
- archive: zip/tar extract (zip-slip), `path.join` with user segment

## Template injection (SSTI)
- `render_template_string` (Jinja), `Template(` (string), `eval`/`exec` of template, `Twig` string,
  `Velocity`/`Freemarker` string templates, EJS/Handlebars compiled from user input

## Deserialization
- **Python**: `pickle.loads`, `yaml.load` (unsafe loader), `marshal.loads`
- **PHP**: `unserialize(`
- **Java**: `ObjectInputStream.readObject`, XMLDecoder, unsafe Jackson `enableDefaultTyping`
- **Ruby**: `Marshal.load`, `YAML.load`
- **JS**: `node-serialize`, `funcster`, untrusted `JSON.parse` into prototype-pollutable merge

## XSS / output
- **DOM**: `innerHTML`, `outerHTML`, `document.write`, `insertAdjacentHTML`, `eval`, `setTimeout(str)`,
  `location`/`location.href` assignment, `$(...).html()`
- **Framework escape hatches**: `dangerouslySetInnerHTML` (React), `v-html` (Vue), `[innerHTML]`/
  `bypassSecurityTrust*` (Angular), `| safe`/`{% autoescape false %}` (Jinja), `mark_safe`/`\|safe`
  (Django), `raw`/`html_safe` (Rails), `=` unescaped (ERB)
- **Server templates** rendering user data into non-default contexts (attributes, JS, URL)

## SSRF / outbound requests
- **JS/TS**: `fetch(`, `axios(`, `http.request`, `got(`, `request(`, `undici`
- **Python**: `requests.*`, `urllib`, `httpx`, `aiohttp`
- **PHP**: `curl_*`, `file_get_contents("http...")`, `fopen` on URL
- **Java**: `URL.openConnection`, `HttpClient`, `RestTemplate`
- Common SSRF features: webhooks, URL preview/unfurl, PDF/image from URL, import-from-URL, SSO metadata,
  proxy endpoints, `redirect_uri` fetches

## Open redirect
- `redirect(` / `res.redirect(` / `Location` header set from user value without allowlist

## Secrets (informational + high)
- patterns: `AKIA[0-9A-Z]{16}`, `-----BEGIN .* PRIVATE KEY-----`, `xox[baprs]-`, `ghp_[0-9A-Za-z]{36}`,
  `eyJ` (JWT), generic `api[_-]?key`, `secret`, `password\s*=`, `token\s*=` with literal values
- files: `.env`, `*.pem`, `*.key`, `id_rsa`, `credentials`, `*.pfx`, hardcoded connection strings
- tools (optional, if installed): `gitleaks detect`, `trufflehog filesystem`

## Weak crypto
- algos: `MD5`, `SHA1` for passwords/signatures, `DES`, `RC4`, `ECB` mode, static IV
- RNG: `Math.random()`/`random.random()`/`rand()` for tokens/keys (not CSPRNG)
- TLS: disabled verification (`rejectUnauthorized:false`, `verify=False`, `InsecureSkipVerify:true`)
- password hashing: plaintext, unsalted, MD5/SHA-family instead of bcrypt/argon2/scrypt/PBKDF2

## Vulnerable dependencies (SCA)
- manifests: `package.json`/lockfile, `requirements.txt`/`poetry.lock`, `pom.xml`, `build.gradle`,
  `go.mod`, `Gemfile.lock`, `composer.lock`, `Cargo.lock`
- tools (optional, if installed): `npm audit --json`, `pip-audit`, `osv-scanner`, `govulncheck`,
  `trivy fs`. If none available, list direct deps + versions and flag known-EOL/major-outdated.

## Security configuration
- missing/weak headers (CSP, HSTS, X-Frame-Options) in middleware/config
- permissive CORS (`Access-Control-Allow-Origin: *` with credentials; reflected origin)
- cookies without `HttpOnly`/`Secure`/`SameSite`
- debug mode on (`DEBUG=True`, `app.debug`, stack traces exposed)
- default/weak credentials in config; verbose error handlers; directory listing enabled

## Sensitive data in logs / egress (CWE-532) — A09 logging

This is an **egress sink**: the danger is a *sensitive value* reaching a log/telemetry channel, not an
attacker-controlled value reaching a dangerous API. Grep the **log sinks**, then check whether any
**sensitive source** (see `SOURCE_TO_SINK.md` → "Sensitive-data egress slots") flows into the call —
especially the *whole object / raw HTTP response body* logged in one shot.

- **Log sinks — JS/TS**: `console.{log,info,debug,warn,error}`, `logger.{info,debug,warn,error}`,
  `winston`/`pino`/`bunyan` calls, `Sentry.captureException(... extra)`
- **Log sinks — Python**: `logging.{info,debug,warning,error,exception}`, `print(`, `logger.*`, `traceback`
- **Log sinks — PHP**: `LoggerInterface::{info,debug,notice,warning,error,critical}`, `error_log(`,
  `var_dump`/`print_r`/`var_export` (into a log/response), Monolog handlers
- **Log sinks — Java**: `log.{info,debug,warn,error}` (slf4j/log4j), `printStackTrace()`, `System.out.println`
- **Log sinks — Go/Ruby**: `log.Print*`/`slog.*`/`fmt.Print*`; `Rails.logger.*`, `puts`, `p `
- **High-signal sensitive-source-into-log patterns** (grep the *argument*, not just the call):
  ```bash
  rg -n -i '(->|\.)(debug|info|notice|warn|warning|error|critical|log)\(' src \
    | rg -i 'token|password|passwd|secret|api[_-]?key|authorization|bearer|credential|\$data|getContent|response\b|code_verifier|refresh_token|access_token|set-cookie|ssn|card'
  ```
  Run this focused on auth/security/payment/webhook directories first — that is where token responses,
  PKCE verifiers, `Authorization` headers, and credential objects get logged verbatim.
- **What counts as leaked**: OAuth/OIDC `access_token`/`refresh_token`/`id_token`, the *raw response body*
  of an auth/token endpoint, passwords, API keys, session tokens, PKCE `code`/`code_verifier`,
  `Authorization`/`Cookie` headers, PII (gated by data-protection scope). Logging a whole DTO/response
  object (`['data' => $dto]`, `extra: {response}`) is the most common offender.
- **Also flag** (A09 gaps): security events with **no** audit log (login success/failure, authz denial,
  privilege change), and **log injection** (unsanitized newline/CRLF user input into a log line).
