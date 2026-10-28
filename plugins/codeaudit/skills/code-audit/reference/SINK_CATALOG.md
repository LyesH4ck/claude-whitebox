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

### NoSQL injection (operator & server-side JS)
The danger signal is a **typed object** (not a scalar) from the request reaching a query-operator
position — `{$ne:null}`/`{$gt:''}`/`{$regex:…}` — or a user string in a JS-evaluated slot.
- **MongoDB (JS/TS)**: `.find(`/`.findOne(`/`.update*(`/`.deleteMany(` fed a request object without a
  scalar cast (`{ user: req.body.user }`), `$where` with a string, `mapReduce`, `.aggregate(` with a
  user-built `$expr`
- **Mongoose / ODMs**: a filter built by spreading `req.query`/`req.body` straight into the query
- **Python (pymongo)**: `collection.find(` / `update_one(` with a dict assembled from `request.json`
- **PHP**: `\MongoDB\...->find(` / `executeQuery(` with `$_GET`/`$_POST` merged into the filter array
- Also: Redis `EVAL` / Lua with concatenated user input; CouchDB/N1QL string-built queries

## OS command injection

> **The argv form is a conditional sink, not a non-sink.** `execFile`/`spawn(shell:false)`/`subprocess.run([…])`/
> `ProcessBuilder(prog, arg)`/`ArgumentList` bypass the shell but still feed the program's own option parser.
> Inventory them whenever the program is flag-rich (`git`, `curl`, `wget`, `tar`, `find`, `rsync`, `ffmpeg`,
> `zip`, `ssh`) and a user value can begin with `-`. Slot: `CMD-option` (CWE-88).
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

## XXE / XML external entities
The danger is an XML parser that resolves external entities or a network DTD on attacker-controlled XML
(uploads, SOAP, SAML, SVG, OOXML `.docx`/`.xlsx`, RSS/webhooks). Grep the parser construction, then check
whether DOCTYPE / external-general / external-parameter entities are disabled.
- **Java**: `DocumentBuilderFactory`, `SAXParserFactory`, `XMLInputFactory` (StAX), `TransformerFactory`,
  `SAXReader`, `XMLReader`, `Unmarshaller`, `SchemaFactory` — vulnerable unless `disallow-doctype-decl`
  (or `external-general-entities` + `external-parameter-entities`) is set to false
- **Python**: `lxml.etree` (`resolve_entities=True` / `no_network=False`), `xml.sax`, `xml.dom.minidom`,
  older `xml.etree.ElementTree`, `xmlrpc` — prefer `defusedxml`
- **PHP**: `simplexml_load_*`, `DOMDocument->load*` with `LIBXML_NOENT`/`LIBXML_DTDLOAD`, `xml_parse`
- **JS/TS**: `libxmljs` (`{noent:true}`), `node-expat`, `@xmldom/xmldom` with entity expansion
- **Ruby**: `Nokogiri::XML(...)` with `NOENT`/`DTDLOAD`, `REXML` (entity/billion-laughs expansion)
- **.NET**: `XmlDocument`/`XmlReader` with `DtdProcessing.Parse` and a non-null `XmlResolver`

## Prototype pollution (JS/TS)
Attacker-controlled object **keys** reaching a recursive merge/clone or a dynamic property write, polluting
`Object.prototype`. Server-side this enables gadget-driven RCE / authz bypass; client-side, DOM XSS.
- **Recursive merge/extend**: `_.merge`/`_.mergeWith`/`_.defaultsDeep` (lodash), `$.extend(true, …)`
  (jQuery), `deepmerge`, `merge-deep`, `hoek.merge`, a hand-rolled recursive `Object.assign`
- **Dynamic property write**: `obj[a][b] = c`, `_.set(obj, path, val)` with a user-controlled path
- **Parsers feeding merges**: `qs.parse`/`querystring` bracket syntax, `JSON.parse` → merge, body parsers
- Danger keys: `__proto__`, `constructor`, `prototype` appearing in user-controlled keys or a dotted path

## XSS / output
- **DOM sinks**: `innerHTML`, `outerHTML`, `document.write`, `insertAdjacentHTML`, jQuery
  `.html(`/`.append(`/`.prepend(`/`.before(`/`.after(`/`.replaceWith(`/`.wrap(`, `location`/`location.href`
  assignment; **code-exec**: `eval(`, `new Function(`, `setTimeout(str)`, `setInterval(str)`
- **DOM sources** (taint when read client-side): `location.hash`/`search`/`href`/`pathname`,
  `document.referrer`, `window.name`, `postMessage` data, `URLSearchParams(...).get(...)` and custom
  URL-param helpers (`getUrlParameter`/`getParameterByName`), `$(el).val()`/`el.value`/`.attr('value')`
  **when server-populated from a request/URL param** (`.val()` returns the HTML-**decoded** string → server
  escaping is undone), any `fetch`/`XHR`/`$.ajax` JSON response field, `{{ v|escapejs }}`/`{{ v|json_script }}`
  injected into inline JS, and `localStorage`/`sessionStorage.getItem`, `document.cookie`
- **Where they live**: inline `<script>…</script>` blocks inside HTML/templates **and** `static/**/*.js` —
  grep these, not just framework component files
- **Framework escape hatches**: `dangerouslySetInnerHTML` (React), `v-html` (Vue), `[innerHTML]`/
  `bypassSecurityTrust*` (Angular), `| safe`/`{% autoescape false %}` (Jinja), `mark_safe`/`\|safe`
  (Django), `raw`/`html_safe` (Rails), `=` unescaped (ERB)
- **Server templates** rendering user data into non-default contexts (attributes, JS, URL)

## SSRF / outbound requests
- **JS/TS**: `fetch(`, `axios(`, `http.request`, `got(`, `request(`, `undici`
- **Python**: `requests.*`, `urllib`, `httpx`, `aiohttp`
- **Python (opener/builder — easy to miss)**: `urlopen(`, `urllib.request.build_opener(...).open(`,
  `urllib2.build_opener(...).open(`, `OpenerDirector.open(`, `FancyURLopener().open(`,
  `pycurl.Curl().setopt(...URL...)`, `http.client`/`httplib` `.request(`. **Py2 `build_opener()`/`urlopen`
  resolve `file://`+`ftp://` by default** (FileHandler/FTPHandler) → also **LFI** (CWE-73/98), not just SSRF
- **PHP**: `curl_*`, `file_get_contents("http...")`, `fopen` on URL
- **Java**: `URL.openConnection`, `HttpClient`, `RestTemplate`
- Common SSRF features: webhooks, URL preview/unfurl, PDF/image from URL, import-from-URL, SSO metadata,
  proxy endpoints, `redirect_uri` fetches

## Open redirect (CWE-601 — owned by access-control-auditor, A01)
- **Django**: `HttpResponseRedirect(x)`, `HttpResponsePermanentRedirect(x)`, `redirect(x)` (django.shortcuts)
- **Flask**: `redirect(x)` · **Express**: `res.redirect(x)`, `res.location(x)` · **Rails**: `redirect_to(x)`
- **raw**: any `Location` header assembled from a request value
- Safe iff the target is a **relative path with no scheme/host** or passes an on-site host allowlist
  (`django.utils.http.url_has_allowed_host_and_scheme` / `is_safe_url`). The low-level class forms
  (`HttpResponseRedirect(next)`) do **not** match a `redirect(`-only grep — search the class names too.

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
- **infrastructure and CI as code** — Terraform/HCL, Dockerfiles, Kubernetes manifests, GitHub workflows:
  wildcard IAM, public ingress, unencrypted stores, root containers, unpinned actions/modules/images,
  `pull_request_target` running PR code. Seeds, defaults and safe forms in `ecosystems/iac.md`.

## Fail-open and bypass shapes (language-agnostic — read the decision, not the sink)
A security *decision* that is wrong in a way the surrounding code hides. None of these is a sink; each is a
place to ask the fail-open question from `SKILL.md`. Stack-specific forms and seeds live in each
`ecosystems/*.md` (fullest in `node.md`).
- a security flag read as a truthy **string** (`if (env.DISABLE_AUTH)` — `"false"` is truthy; `if
  (env.REQUIRE_AUTH)` — off when unset)
- verification, CSRF, rate limiting, signature or encryption gated behind a **feature flag** whose default or
  failure branch is "skip"
- **test / debug / bypass headers** (`x-test-*`, `x-debug`, `x-bypass`, `x-skip-auth`, `x-internal`) honoured
  by handler code reachable in production
- **dev-mode auth shortcuts** (`/auth/dev`, mock sessions, test tokens, `if (!production) user = admin`)
  gated only on an environment string the deploy can misset
- a shared secret compared **without requiring it to exist** (`!== "Bearer " + env.CRON_SECRET` with the
  variable unset)
- **spread / merge order** on a write where request data can overwrite a server-set field (`{role, ...body}`),
  schema `passthrough`/`unknown`-keys modes before persistence
- a lock, transaction or revocation call whose result is **not awaited / not checked**
- **read-then-write on a single-use value** (token, invite, balance, quota) outside a transaction or
  compare-and-set
- cache or KV keys that omit the **principal or tenant**
- an outbound client that **follows redirects** after a one-time allowlist check
- host/URL validation by **regex with a wildcard** instead of a parsed hostname compared to an allowlist

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

## Client-side — browser classes beyond DOM-XSS (owned by client-side-auditor)

DOM-XSS sources/sinks are above (§XSS / Prototype pollution). These are the *additional* browser sinks —
a controllable browser source must reach one AND impact a victim session / another origin / shared
persistence (self-injection is not a finding). Full slot logic in `CLIENT_SIDE.md`.
- **DOM clobbering**: markup with attacker `id`/`name` that shadows a global/config/init flag later read
  (`window.<x>`, `document.<x>`, `config.<x>` trusted after an HTML sink). Grep sanitizer allowlists that
  keep `id`/`name`.
- **postMessage origin trust**: `addEventListener('message', …)` / `onmessage` handlers — flag any that
  act on `event.data` without an **exact** `event.origin` allowlist (substring/`indexOf`/`startsWith`/
  unanchored-regex = not a check). Send side: `postMessage(data, '*')` with sensitive data.
- **Credentialed CORS**: server reflecting/weak-matching `Origin` with `Access-Control-Allow-Credentials:
  true` (grep both headers together; a bare `*`+credentials is browser-rejected — report the reflected path).
- **Cross-site WebSocket**: `new WebSocket(` upgrade accepting ambient cookies with no `Origin` check /
  channel token + a state-touching message handler.
- **Service worker**: `navigator.serviceWorker.register(`, `Service-Worker-Allowed`, `caches.*` — attacker-
  influenced script/scope, or personalized responses cached without account/tenant in the key.
- **Browser storage / stale auth**: `localStorage`/`sessionStorage`/`indexedDB`/`caches` holding tokens or
  private data readable by a lower-trust same-origin component or used after logout/revocation.
- **Clickjacking**: state-changing action framed without effective `frame-ancestors`/`X-Frame-Options`.
- **Client-side redirect / reverse tabnabbing**: `location = <src>` / `window.open(` to `javascript:`/
  `data:` from a client source; retained `window.opener`.

## HTTP framing / cache / header trust (owned by http-protocol-auditor)

A framing/cache finding needs **two** components interpreting the same request/response/key differently —
name both. Full slot logic in `HTTP_PROTOCOL.md`. Most surface exists only when a **custom parser or an
in-repo proxy/CDN config** is present; otherwise downgrade to a coverage gap.
- **Request framing / desync**: `Content-Length` + `Transfer-Encoding` both handled, `chunked` parsing,
  raw `recv(`/`readline(` HTTP parsing, HTTP/2→1 downgrade, header-name normalization. Grep proxy config
  (`nginx.conf`, `haproxy`, `Caddyfile`, `varnish`, `cloudfront`, ingress) alongside app parsing.
- **Cache poisoning (unkeyed input)** / **deception**: `Cache-Control`/`s-maxage`/`surrogate-control`,
  `proxy_cache_key`/cache-key builders — a request value (forwarded host/scheme, cookie, lang/device
  header) that changes the response but is absent from the key; a private dynamic path cached as a static
  asset (suffix/path-param normalization mismatch).
- **Host / forwarded-header trust**: `req.headers.host`/`request.get_host()`/`X-Forwarded-Host`/`Forwarded`
  used to build absolute URLs, **password-reset links**, tenant routing, cache keys, or the client IP used
  for authz — confirm trusted ingress strips client copies.
- **Response-header injection / splitting**: request-derived value reaching `Location`/`Set-Cookie`/CSP via
  `setHeader`/`addHeader`/`write_head` with unsafe CR/LF (verify the framework doesn't already reject it).

---

# Extended-class seeds (business-logic · feature-abuse · data-lifecycle · client-side · http-protocol · ai-llm)

The extended seven are **surface/workflow-shaped**, not all pure `file:line` API sinks — the seeds below are
starting greps; the authoritative method lives in the matching reference file
(`BUSINESS_LOGIC.md`, `FEATURE_ABUSE.md`, `DATA_LIFECYCLE.md`, `CLIENT_SIDE.md`, `HTTP_PROTOCOL.md`, `AI_LLM.md`).

## Client-side / DOM & browser (client-side-auditor — A03/A05)
- **DOM sources**: `location.(hash|search|href|pathname)`, `document.referrer`, `window.name`,
  `addEventListener('message'` / `onmessage`, `localStorage`/`sessionStorage`/`indexedDB`, `URLSearchParams`
- **Executing sinks**: `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval(`,
  `new Function(`, `setTimeout(`/`setInterval(` with a string, jQuery `.html(`/`$(`, `location=`/`.href=`,
  `javascript:` URLs, `dangerouslySetInnerHTML`, `v-html`, Angular `bypassSecurityTrust*`
- **Prototype pollution**: recursive merge / `__proto__` / `constructor` / `[key]=` deep-write (then a gadget)
- **Cross-origin**: `postMessage(` (send-side `*`; recv-side weak origin check), `fetch(...credentials:'include'`,
  `new WebSocket(`, permissive `Access-Control-Allow-Origin` reflection, `navigator.serviceWorker.register(`
- Scan `static/**/*.js`, SPA bundles, browser-extension code, and inline `<script>` blocks of templates.

## HTTP framing / cache / headers (http-protocol-auditor — A05)
- **In-repo proxy/edge config** (the second interpreter): `nginx.conf`, `haproxy.cfg`, `Caddyfile`,
  `*.vcl` (varnish), `cloudfront`/ingress rules, `proxy_pass`, `proxy_cache_key`, rewrite rules
- **Framing**: custom request parsers, `Content-Length`, `Transfer-Encoding`, HTTP/2 handling, header-name
  normalization, CR/LF handling
- **Host/forwarded trust**: `req.headers.host`/`getHeader("Host")`/`X-Forwarded-*`/`Forwarded` used to build
  absolute URLs, password-reset links, redirects, tenant routing, cache keys, or the client IP for authz
- **Response headers**: `setHeader`/`addHeader`/`Location`/`Set-Cookie`/CSP built from request-derived values

## Business-logic / feature-abuse / data-lifecycle / ai-llm (workflow-shaped)
- **business-logic**: `status`/`state`/`step`/`stage` enums + transition guards; read-modify-write without a
  transaction / row-lock / `SELECT … FOR UPDATE` / atomic increment; `balance`/`quota`/`credit`/`amount`
  arithmetic; `expire`/`schedule`/`valid_until` comparisons.
- **feature-abuse**: `export`/`download`/`report`/`snapshot`/`backup`/`csv`/`pdf`; `import`/`restore`/`upload`;
  `search`/`filter`/`order_by`/`sort`/`?q=`; `preview`/`draft`/share-token/`sitemap`/`rss`;
  `webhook`/`callback`/`notify_url`/`hook_url`.
- **data-lifecycle**: `findById`/`.get(`/`WHERE id=` lookups lacking a tenant predicate; `unscoped`/service
  clients; cache/object/search-doc keys omitting tenant; `deleted_at`/`is_deleted`/tombstone predicates;
  membership/consent/role revocation not invalidating sessions/caches/jobs.
- **ai-llm**: LLM SDK calls (`openai`/`anthropic`/`chat.completions`/`generate`/`invoke`); prompt assembly
  (concatenated system/user/tool messages, caller-controlled role fields); RAG/`embedding`/`vector`/`upsert`;
  tool/function definitions + dispatcher (`tools=`/`function_call`/`tool_call`); MCP server/client wiring.
- **resource-exhaustion**: user-supplied/user-matched regex (`new RegExp`/`re.compile`/`.match(`/`.test(`);
  decompression without a decompressed-size cap (`unzip`/`gunzip`/`zlib`/`inflate`/`extractall`/`tarfile`/
  image-decode); recursion over user structures; query fan-out (`include`/`expand`/pagination, `IN (…)` from
  a user list); unbounded reads/streams; resource acquisition without a matching `finally`/`defer`/`with`;
  retry loops without jitter/ceiling; shared-queue consumers (poison-record / head-of-line blocking).
