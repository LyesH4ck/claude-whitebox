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
```
