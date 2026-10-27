# Node / JavaScript / TypeScript review reference

Load when `package.json` is present. Covers Express, Fastify, Koa, Hono, Elysia, NestJS, Next.js, tRPC,
React/Vue/Angular/Svelte, Prisma/Sequelize/Mongoose/TypeORM, template engines, `child_process`, VM sandboxes,
prototype-pollution chains, and unsafe serialization packages.

Resolve versions from `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml`. A caret range in `package.json`
is not a version. See `README.md` for the binding version-sensitivity rule.

---

## Version facts to check

**Node — Windows `.bat`/`.cmd` argument injection ("BatBadBut", CVE-2024-27980).**
Below the fixed lines, `child_process.spawn`/`execFile` on a `.bat` or `.cmd` file invokes `cmd.exe` parsing
**even with `shell: false`**, so the argv form is *not* a defense there. Fixed in **18.20.2, 20.12.2, 21.7.3**.
That fix was then bypassed (**CVE-2024-36138**) until **18.20.4, 20.15.1, 22.4.1** — clear a Windows
`.bat`/`.cmd` spawn only at or above the **July 2024** lines.
Sources: <https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2>,
<https://nodejs.org/en/blog/vulnerability/july-2024-security-releases>
→ Applies only when the deployment target is Windows **and** the spawned program is a `.bat`/`.cmd`. On Linux
containers this row is not a finding; say so in `tested_not_vulnerable` rather than silently dropping it.

**`jsonwebtoken` ≤ 8.5.1 — three distinct advisories, each with its own precondition. Fixed in 9.0.0.**
The package version alone is **never** the finding; the call site decides.
- **CVE-2022-23540** — `jwt.verify()` with **no explicit `algorithms`** option can fall through to `none`
  when the verification key is falsy. Requires both conditions.
- **CVE-2022-23539** — legacy/insecure key-type ↔ algorithm pairs accepted (e.g. a DSA key with `RS256`).
  9.0.0 validates the pair; `allowInvalidAsymmetricKeyTypes: true` re-opens it.
- **CVE-2022-23541** — a **poorly implemented custom key-retrieval function** lets a token signed with an
  asymmetric *public* key verify under symmetric `HS256` (key confusion → forged tokens).
Source: <https://auth0.com/docs/secure/security-guidance/security-bulletins/2022-12-21-jsonwebtoken>
→ On ≥ 9.0.0, `alg:none` and key-type confusion are closed. **Issuer, audience, token-purpose, tenant and
scope binding are not** — those are application obligations at every version. See `jwt.md`.

**Next.js — middleware authorization bypass (CVE-2025-29927).**
An attacker-supplied `x-middleware-subrequest` request header lets a request skip middleware entirely. Where
the **only** authorization check lives in `middleware.ts`, this is a full authz bypass. Fixed in
**15.2.3, 14.2.25, 13.5.9, 12.3.5**.
Sources: <https://osv.dev/vulnerability/CVE-2025-29927>,
<https://www.fastly.com/blog/cve-2025-29927-authorization-bypass-in-next-js>
→ Two checks, both required: (1) installed version below the cutoff for its major line; (2) a protected route
whose authorization is **only** in middleware. A Route Handler or Server Action that makes its own authz
decision is not bypassed. Apps on Vercel/Netlify were reported auto-protected at the edge — that is a
*deployment* mitigation; record it as an assumption, not as source-confirmed safety.
→ Independently of the CVE: **Next.js middleware is a coarse gate, never the authorization boundary.** A
Server Action is directly invocable and must authorize itself; a check in a page or layout does not cover it.

**`lodash` — prototype pollution, by cutoff.**
`< 4.17.5` CVE-2018-3721 (`merge`/`mergeWith`/`defaultsDeep`) · `< 4.17.12` CVE-2019-10744 (`defaultsDeep`) ·
`< 4.17.20` CVE-2020-8203 (`zipObjectDeep`, path-setting) · `< 4.17.21` CVE-2021-23337 (**command injection
in `_.template`**).
Sources: <https://www.cve.org/CVERecord?id=CVE-2019-10744>, <https://nvd.nist.gov/vuln/detail/CVE-2020-8203>,
<https://nvd.nist.gov/vuln/detail/CVE-2021-23337>
→ Below a pollution cutoff you still need a **downstream gadget**: a polluted key later read into template
compilation, `Function`, `vm`, `child_process` options, or a privileged config/authz read. Pollution with no
traced sink is `client-side`-class pollution, not RCE — rate it accordingly.

**`handlebars` < 4.7.7** — prototype-pollution and helper/lookup RCE chains (CVE-2021-23383, CVE-2021-23369).
Later advisories reach **before 4.7.9** under specific runtime/option combinations. Template compilation
performed *after* a user-controlled deep merge is suspicious until the installed version, the compile options
and the merge guard together rule it out. Source: <https://github.com/advisories?query=handlebars>

**`node-serialize`** — `unserialize()` executes embedded function markers. Unsafe in **every** published
version on untrusted input; **no patched version exists**.
Source: <https://github.com/advisories/GHSA-q4v7-4rhw-9hqm>

**`vm2`** — a long history of sandbox escapes (CVE-2023-37466, CVE-2023-37903 among others). Its maintenance
status has changed more than once; **verify the current status and the installed version before writing
anything**. Presence of `vm2` alone is not a finding. Report when the pin sits on a known-escapable line, when
fully untrusted code runs with no defense-in-depth outside the sandbox, or when you traced an escape path.
`vm`/`vm2`/`isolated-vm` are **not** security boundaries for attacker-authored code — that claim belongs in
`design_properties`/`unverified_assumptions`, not in a finding, unless you exhibit the escape.

**WebSocket origin defaults differ by library and major version.** Node `ws` performs **no** origin check —
the application must supply one (`verifyClient`, or a check in the `upgrade` handler); the absence is the
finding. `socket.io`'s `cors` option **does not gate the WebSocket handshake at all** — per its own docs, CORS
applies only to HTTP long-polling, and WebSocket connections are not subject to it. Origin restriction must
be done in `allowRequest`. So a cookie-authenticated socket.io server with a tight `cors.origin` and no
`allowRequest` is CSWSH-vulnerable, and **the absence of `allowRequest` is the finding** — a correct-looking
`cors` block is not a control here. Source: <https://socket.io/docs/v4/handling-cors/> The handshake is not subject to CORS or SOP, so a strict
Express `cors()` middleware protects nothing here — see `CLIENT_SIDE.md` → *Cross-site WebSocket hijacking*.

---

## Framework defaults

**Middleware is allow-by-default and order-sensitive.** Express, Koa, Fastify, Hono and Elysia protect a route
only if a guard actually covers it:
- Express applies middleware **in registration order** — `app.use(auth)` registered *after* a route does not
  protect that route. Path-scoped `app.use('/admin', auth)` protects only matching mounts.
- Fastify guards are `onRequest` / `preValidation` / `preHandler` hooks, and **plugin encapsulation** means a
  hook registered in one scope does not protect a sibling plugin.
- Koa middleware must **stop the chain** on failure. A `catch` that sets an empty principal and still calls
  `await next()` is fail-open — that is the mandatory fail-open question from `SKILL.md`, and it is the single
  most common real authz bug in Koa code.
- NestJS: `APP_GUARD` (global) vs `@UseGuards` (controller/route) vs a `@Public()` metadata escape hatch. A
  `@Roles()` decorator does **nothing** unless a guard reads it via the reflector. For GraphQL controllers,
  confirm the guard extracts the GraphQL execution context, not an HTTP request shape absent at runtime.
- tRPC: follow `publicProcedure` / `protectedProcedure` builders through aliases and router merges to the
  **final** builder. A security-sounding variable name is not evidence.

**Output encoding — scope matters more than presence.**
- **React / Vue / Angular / Svelte auto-escape the HTML *text* context only.** Escape hatches:
  `dangerouslySetInnerHTML`, `v-html`, `[innerHTML]`, `bypassSecurityTrust*`, `{@html}`.
- **Even with no escape hatch**, a tainted value still needs a slot-specific defense in: a URL attribute
  (`<a href={v}>` → `javascript:`), an inline event handler, a `<script>` / JSON-in-JS block, a `style`/CSS
  slot, and a **prop spread** (`{...v}` — which can inject `dangerouslySetInnerHTML` itself).
- Server-rendered JSON embedded in HTML (`__NEXT_DATA__`, `window.__STATE__ = ...`) is a JS-string slot, not
  an HTML-text slot: `JSON.stringify` alone does not escape `</script>`.

**Data access.** Prisma, Sequelize, Mongoose, TypeORM and Knex parameterize by default on their typed query
APIs. Raw escape hatches: `$queryRawUnsafe`, `$executeRawUnsafe`, `sequelize.query` with interpolation,
`knex.raw`, `.whereRaw`, Mongoose `$where`. Tagged-template `$queryRaw\`...\`` **is** parameterized — do not
report it on the `Raw` substring. For NoSQL, an un-cast `req.query`/`req.body` value reaching a filter object
allows **operator injection** (`{"$ne":null}`, `{"$gt":""}`) — Express `extended` query parsing yields objects,
not just strings.

**Mass assignment.** Spreading `req.body` / an input object / a DTO instance into `create`/`update` can carry
`role`, `tenantId`, `ownerId`, `status`, `isAdmin`, `price`. Zod/Joi/class-validator schemas are a defense
**only** when they omit or reject those fields *and* the **parsed result** — not the original body — reaches
persistence. `schema.parse(body)` followed by `prisma.user.update({data: body})` is the bug.

**Edge and alternative runtimes have no framework gate at all.** `Bun.serve({ fetch })`, `Deno.serve(handler)`
and a Workers `export default { fetch(req, env) }` are the whole entry: auth and validation live in that one
function or nowhere. `Bun.$\`…\`` and `Bun.spawn` with interpolated input are command injection; Workers
`caches.default` keys on the full URL, so an unnormalised query string poisons the cache; `env.<BINDING>` (KV,
R2, D1, secrets) is the blast radius of any bug in the handler.

---

## Fail-open and bypass shapes

The patterns below are not sinks. Each is a place where the **security decision itself** is wrong in a way a
reader skims past because the surrounding code looks careful. Pattern-matchers catch them cheaply; a
source→sink trace does not, because the path looks guarded. Ask the fail-open question (`SKILL.md`) at each.

- **A security flag read as a truthy string.** `if (process.env.DISABLE_AUTH) skipAuth()` is disabled by
  `DISABLE_AUTH=false` — the string `"false"` is truthy. Same for `SKIP_*`, `BYPASS_*`, `NO_*` and the inverse
  `if (process.env.REQUIRE_AUTH)`, which is **off when the variable is unset**. The safe shape compares to a
  literal (`=== 'true'`) or parses with a boolean helper. Check the deploy files: an env file that sets the
  variable to `false` to "turn it off" is the finding's witness.
- **Security gated by a feature flag.** `if (featureFlag('strict-auth')) await verifyToken(req)` — the flag
  service failing, the flag missing in an environment, or a default of `false` all fail open. Verification,
  CSRF, rate limiting, header stripping, encryption and signature checks behind `LaunchDarkly.variation(…)`,
  `statsig.checkGate(…)`, `isFeatureEnabled(…)`, `experiment(…)`: the default branch is the finding.
- **Test and bypass headers honoured outside tests.** `x-automated-test`, `x-test-*`, `x-debug`, `x-bypass`,
  `x-skip-auth`, `x-no-rate-limit`, `x-internal` read in handler code with no gate on environment — a
  production request can send them too. The gate must be the *absence* of the branch in the production
  build, not a comparison to `NODE_ENV` the deploy can misset.
- **Development auth bypasses that ship.** `/auth/dev`, `/api/dev/login`, `isDev && autoLogin()`,
  `mock-session`, `test-token`, `if (process.env.NODE_ENV !== 'production') req.user = admin`. `NODE_ENV` is a
  build-time string a container can run without; treat a bypass reachable under any `NODE_ENV` value as live.
- **A cron secret that disables itself when unset.** `if (auth !== \`Bearer ${process.env.CRON_SECRET}\`)
  return 401` is correct **only when the variable is set**; unset, the comparison is against `Bearer undefined`
  and a request carrying that literal passes. Require the secret to exist (fail closed) before comparing.
- **Spread order on a write.** `{ role: 'member', ...req.body }` lets the body overwrite `role` — later keys
  win. `{ ...req.body, role: 'member' }` is the safe order; better, pick the allowed fields. Same for
  `Object.assign({}, req.body)` into a create/update, `.values(body)` / `.set(body)` on Drizzle, and
  `schema.passthrough()` on Zod: passthrough keeps unknown keys, so the parsed result still carries `role`.
- **Missing `await` on a guard.** `withMutex(() => …)`, `withLock(…)`, `withTransaction(…)`, `redis.set(…)`,
  `prisma.x.update(…)` called without `await` or `return`: the lock never held, the write races the response,
  the error is swallowed. A race on an authz-relevant write (quota, balance, token revocation) is a finding.
- **Read-then-delete without a transaction.** `const t = await redis.get(k); …; await redis.del(k)` and
  `findUnique` → `delete` without `$transaction`/`WATCH`/`SELECT … FOR UPDATE` is TOCTOU on a single-use
  token, invite, or balance — two concurrent requests both see the value.
- **Cache keys without a principal.** `redis.get(\`feature:${name}\`)`, `cache.set(\`profile:${id}\`)` where
  `id` is request-supplied and the key omits tenant/user — one user's cached object served to another.
- **Outbound fetch that follows redirects.** `fetch(url)` defaults to `redirect: 'follow'`; an allowlist
  checked once on `url` is bypassed by a 302 to `169.254.169.254`. `redirect: 'manual'` plus re-validation
  per hop, or an allowlist applied inside the HTTP client, is the defense.
- **URL or host validation by regex with a greedy wildcard.** `new RegExp("https?://.+\\.example\\.com")`
  matches `https://evil.com/#.example.com`; an unanchored or `.+`/`.*` host pattern is bypassable. Parse with
  `new URL()` and compare `hostname` to an allowlist.
- **Git-provider URLs built from input.** `\`https://api.github.com/repos/${owner}/${repo}\`` with
  request-controlled segments: `../` and `?` rewrite the API path (a different endpoint, a different
  resource) under the server's token. Validate each segment against `[A-Za-z0-9_.-]+`.
- **JSON in a script slot.** `JSON.stringify(state)` inside `<script>` or `dangerouslySetInnerHTML` is XSS the
  moment a string contains `</script>`; a `safeJsonStringify` that escapes `<`, `>`, `&`, U+2028/2029 is the
  defense (`JSON.stringify` alone is not).
- **Filesystem writes to a computed path with no symlink boundary.** `fs.writeFile(\`${base}/${name}\`)` /
  `path.join(uploadDir, req.body.name)` without `realpath` + `startsWith(root)`: `../` escapes, and a
  pre-planted symlink inside `uploadDir` escapes even when `../` is filtered.
- **Next.js, specifically.** Every `'use server'` export is a public POST endpoint — auth lives **in** the
  function (`auth()`/`getSession()`/`requireAuth()` before the first write), not on the page that calls it.
  `[...slug]` / `[[...rest]]` route handlers must authorize every sub-path. A Server Component page that
  fetches `/api/orders/${params.id}` with no ownership check is IDOR even though the API is "internal".
  `x-middleware-subrequest`, `x-middleware-rewrite`, `x-next-*`, `next-action`, `rsc`, `next-url` are
  framework-internal headers: handler code that **reads** them trusts the client; code that **sets** them from
  request data rewrites routing. The image optimiser's `remotePatterns`/`domains` allowlist is an SSRF
  boundary — a wildcard host or a private-IP allowlist entry is the finding.
- **tRPC `publicProcedure` that reaches the session.** A `publicProcedure` whose handler reads
  `ctx.session` / `ctx.user` / `ctx.prisma` under `/admin`, `/billing`, `/teams`, `/settings` is almost
  always a mislabelled `protectedProcedure`: without the guard, `ctx.session` is `null` and the handler either
  throws (DoS-shaped) or, worse, queries with `undefined` as the tenant.
- **LLM calls without a step cap.** `streamText`/`generateText`/`generateObject` with tools and no
  `maxSteps`/`stopWhen`, `query()` on an agent SDK with no `maxTurns`/`abortSignal`/`timeout`: a tool loop
  the model does not exit is a cost-burn and availability finding (resource-exhaustion class).
- **Secrets in the system prompt.** `system: \`… ${process.env.OPENAI_API_KEY}\``, a `role: 'system'`
  message interpolating `*_TOKEN`/`*_SECRET`/`*_PASSWORD`: the value reaches the provider, the traces, and
  any prompt-extraction attack. A literal `sk-…`, `ghp_…`, `xoxb-…`, `AKIA…` in a prompt string is a secrets
  finding outright.

---

## Dangerous APIs

- **Command execution** — `child_process.exec`, `execSync`, `spawn`/`spawnSync`/`execFile` with
  `{shell: true}`, and any wrapper taking one interpolated command string.
- **Dynamic execution** — `eval`, `new Function`, `AsyncFunction`, string-form `setTimeout`/`setInterval`,
  `vm.runInThisContext`, `vm.runInNewContext`, framework expression engines evaluating request data.
- **Templates (SSTI)** — `Handlebars.compile(userSource)`, `pug.compile`, `ejs.render(userTemplate)`,
  `nunjucks.renderString`, `liquidjs.parseAndRender` on tenant-supplied source, and request-controlled
  `res.render(viewName)`.
- **Deserialization / module loading** — `node-serialize.unserialize`, dynamic `require(userValue)`, dynamic
  `import(userValue)`, plugin names without a closed allowlist, JSON revivers that instantiate classes.
- **Prototype pollution → execution** — unguarded `lodash.merge`/`defaultsDeep`/`set`/`setWith`, `deepmerge`,
  hand-rolled recursive merge of `req.body`, `Object.assign` into a shared prototype, followed by template
  compilation, `Function`, `vm`, child-process options, or a privileged config read.
- **Path / file** — `path.join(root, req.params[0])` without containment, `res.sendFile` /
  `express.static` with a computed path, archive extraction (`unzipper`, `tar`, `adm-zip`) without entry-name
  containment (zip-slip), `multer` with a client-supplied `originalname` used as the stored filename.
- **SSRF** — `fetch`, `axios`, `got`, `node-fetch`, `request`, `undici` with a computed URL. Check redirect
  following (`maxRedirects`, `redirect: 'follow'`): an allowlist applied **before** the request and not
  re-applied per redirect hop is bypassable via a 302 to `169.254.169.254`.
- **Crypto / TLS** — `rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, `Math.random()` for
  tokens/session ids/password-reset values, `createHash('md5'|'sha1')` for passwords, `===` on secrets instead
  of `crypto.timingSafeEqual`.

---

## Safe or non-reportable forms

- `execFile("bin", [userArg])` and `spawn("bin", [userArg], {shell: false})` with a **literal** binary — not
  shell-parsed on POSIX. (Windows `.bat`/`.cmd` is the exception above.) **But argv is not a free pass**: the argument still reaches the program's own option parser, so a
  user-controlled value that can begin with `-`/`--` is **argument injection** (CWE-88) against a
  flag-rich binary — `git --upload-pack=`, `curl -o`, `tar --checkpoint-action=exec=`, `find -exec`,
  `ffmpeg -f lavfi`. Safe only with a literal program **and** a value that cannot start with a dash
  (validate, or pass `--` first where the program supports it).
- `res.render("literal-view", data)` with a fixed view name — not SSTI.
- `JSON.parse(x)` with no reviver — not unsafe deserialization.
- Prisma tagged template `$queryRaw\`SELECT * FROM t WHERE id = ${id}\`` — parameterized. Only
  `$queryRawUnsafe` / `$executeRawUnsafe` take an interpolated string.
- Prototype pollution with **no traced downstream execution or authz sink** — a `client-side`-class finding at
  most, never RCE.
- `dangerouslySetInnerHTML` on a value that is a **constant, a server-trusted enum, or DOMPurify output with
  a correctly scoped config** — check the config: `ALLOWED_ATTR` including `href`/`on*` re-opens it.
- A `vm`/`vm2` sandbox around **first-party** code (plugin isolation, resource limits) where attacker-authored
  code never enters — design property, not a finding.
- `Math.random()` for non-security values (jitter, cache-buster, UI keys, test fixtures) — not a crypto finding.
- A guard **present on a parent router** that the route inherits — resolve the composed app before claiming a
  missing check; `app.use('/api', requireAuth, apiRouter)` protects every route in `apiRouter`.
- An endpoint explicitly and intentionally public (health check, OIDC discovery, signed webhook receiver with
  verified signature) — not missing authorization.

---

## Commands

```bash
# installed versions first — every claim below needs one
rg -n '"(next|jsonwebtoken|lodash|handlebars|vm2|node-serialize|express|fastify)"\s*:' package.json
rg -n '"version"' package-lock.json | rg -n 'next|jsonwebtoken|lodash|handlebars'

# command / dynamic execution
rg -n 'child_process|exec(Sync)?\(|spawn(Sync)?\(|shell:\s*true' --glob '!node_modules'
rg -n '\beval\(|new Function|AsyncFunction|vm2|vm\.runIn' --glob '!node_modules'

# templates / deserialization / dynamic module load
rg -n 'Handlebars\.compile|pug\.compile|ejs\.render|renderString|parseAndRender|res\.render\(' --glob '!node_modules'
rg -n 'node-serialize|unserialize\(|require\([^"'\'']|import\([^"'\'']' --glob '!node_modules'

# prototype pollution -> gadget
rg -n 'merge\(|defaultsDeep|setWith|deepmerge|__proto__|constructor\s*\[|prototype\s*\[' --glob '!node_modules'

# SQL / NoSQL raw escape hatches
rg -n 'queryRawUnsafe|executeRawUnsafe|sequelize\.query\(|knex\.raw|whereRaw|\$where' --glob '!node_modules'

# XSS slots (escape hatches + non-text slots)
rg -n 'dangerouslySetInnerHTML|v-html|\[innerHTML\]|bypassSecurityTrust|\{@html' --glob '!node_modules'
rg -n 'href=\{|src=\{|on[A-Z][a-zA-Z]+=\{|\{\.\.\.' --glob '!node_modules' --glob '*.tsx' --glob '*.jsx'

# authz surface
rg -n 'app\.use\(|router\.use\(|preHandler|onRequest|APP_GUARD|@UseGuards|@Public|publicProcedure|protectedProcedure' --glob '!node_modules'
rg -n 'middleware\.(ts|js)$|x-middleware-subrequest' --glob '!node_modules'

# SSRF + TLS
rg -n 'fetch\(|axios\.|got\(|node-fetch|undici|maxRedirects|rejectUnauthorized' --glob '!node_modules'

# fail-open and bypass shapes (see the section above — each hit is a decision to read, not a sink)
rg -n 'process\.env\.\w*(DISABLE|SKIP|BYPASS|NO_|ENABLE|REQUIRE)\w*(AUTH|VERIFY|CSRF|RATE|CHECK)' --glob '!node_modules'
rg -n -i 'featureFlag|feature_flag|LaunchDarkly|\.variation\(|statsig|checkGate|isFeatureEnabled|flag_enabled|getFlag\(' --glob '!node_modules'
rg -n -i 'x-automated-test|x-test-|x-debug|x-bypass|x-skip-auth|x-no-rate-limit|x-internal' --glob '!node_modules'
rg -n -i '/auth/dev|/api/dev|/dev/login|mock[_-]?(session|user|auth)|auto[_-]?login|fake[_-]?auth|test[_-]?(token|bearer)' --glob '!node_modules'
rg -n 'CRON_SECRET|x-cron-secret' --glob '!node_modules'
rg -n '\.\.\.(req|request)\.(body|query|params)|\.\.\.(parsed|input|body|params|query)\b|\.passthrough\(\)|\.values\(\s*(body|input|req)' --glob '!node_modules'
rg -n -P '(?<!await )(?<!return )with\w*(Mutex|Lock|Transaction)\s*\(' --glob '!node_modules'
rg -n 'redis\.(get|hget|hgetall)\(|findUnique\(|findFirst\(' --glob '!node_modules'          # then look for the del/update within 10 lines, and the transaction around both
rg -n 'redis\.(get|set|hget|hset|setex)\(\s*`|cache\.(get|set|has)\(\s*`|cacheKey\s*=\s*`' --glob '!node_modules'
rg -n "redirect:\s*['\"]follow['\"]|new RegExp\([^)]*https?" --glob '!node_modules'
rg -n 'api\.github\.com[^`'"'"'"]*\$\{|gitlab\.com[^`'"'"'"]*\$\{|bitbucket\.org[^`'"'"'"]*\$\{' --glob '!node_modules'
rg -n 'JSON\.stringify' --glob '*.tsx' --glob '*.jsx' | rg -n 'dangerouslySetInnerHTML|<script'
rg -n 'fs(p|\.promises)?\.(writeFile|writeFileSync|mkdir|mkdirSync|createWriteStream|copyFile|appendFile|symlink)\w*\(\s*(`|path\.(join|resolve)\(|[a-zA-Z_]+\s*\+)' --glob '!node_modules'
rg -n "['\"]use server['\"]|\[\.\.\.|\[\[\.\.\.|x-middleware-|x-next-|next-action|remotePatterns|domains:" --glob '!node_modules'
rg -n 'publicProcedure\s*\.\s*(input|query|mutation|use)' --glob '!node_modules'          # then: does the handler read ctx.session / ctx.user?
rg -n 'streamText\(|generateText\(|generateObject\(|streamObject\(|\bquery\(\{' --glob '!node_modules' | rg -v 'maxSteps|maxTurns|stopWhen|abortSignal|timeout'
rg -n -P '(system|instructions|prompt)\s*:\s*`[^`]*\$\{process\.env\.[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD)' --glob '!node_modules'
```
