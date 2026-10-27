# GraphQL review reference (cross-language)

Load whenever a GraphQL schema (SDL, `.graphql`, `buildSchema`, `@ObjectType`), resolver, federation gateway,
subscription server or persisted-query layer is present. Additive — load it alongside the language file.

GraphQL changes **where** the bugs live, not what they are. One HTTP endpoint, one method, one status code: the
`entry_points` map that code-recon builds from a REST router does not exist here. **The resolver is the route.**
Build the surface from the schema, then audit per field.

---

## Version facts to check

Unlike the language files, GraphQL's decisive facts are **server defaults**, not CVE cutoffs — the library
version matters because it changes what you get for free, not because a specific version is exploitable.
Resolve the server package and major version first; several verdicts below invert on it.

**Apollo Server — CSRF prevention is enabled by default** (it was announced in the Apollo Server 3 docs as
becoming the default in **Apollo Server 4**). It blocks GET requests and simple-content-type POSTs that lack
specific headers. Source: <https://www.apollographql.com/docs/apollo-server/api/apollo-server>
→ So on AS4 with defaults, "GraphQL endpoint is CSRF-able" is **not** a finding — confirm it instead.
`csrfPrevention: false`, or a custom header allowlist that admits a simple content type, re-opens it, and
**that setting is the finding**. On AS3 and on hand-rolled servers (`express-graphql`, `graphql-yoga`
configured permissively, a bespoke handler), there is no such default — check the accepted methods and
content types yourself.

**Apollo Server — introspection defaults to `true` unless `NODE_ENV === "production"`.**
Source: same reference.
→ Two consequences. A deployment that does not set `NODE_ENV=production` ships introspection on **without
anyone writing `introspection: true`** — so judge the deployment config, not just the constructor options.
And an explicit `introspection: true` is a deliberate choice: report it as `informational` hardening, with
the concrete exposure if you can name one, never as a vulnerability on its own.

**`graphql-js` validation rules are opt-in.** Depth limiting, cost/complexity analysis and operation limits
are **not** in the reference implementation — they come from `graphql-depth-limit`,
`graphql-query-complexity`, `graphql-armor` or equivalent, wired into `validationRules`. Their absence is
therefore the default state of every GraphQL server, which is exactly why "no depth limit" needs the
reachability bar applied (unauthenticated endpoint → finding; authenticated internal API behind a gateway
limiter → hardening) rather than being reported everywhere.

**Server-side batching is library-dependent.** Whether a single POST may carry an **array** of operations
differs per server and per configuration (`allowBatchedHttpRequests` in Apollo Server, on by default in some
other servers). Resolve it before claiming a batching-based rate-limit bypass — and note that **aliasing
inside one document** achieves the same amplification regardless of batching support.

---

## Build the surface first

- Enumerate **every field with a resolver**, not every top-level query. A nested field resolver
  (`User.email`, `Order.internalNotes`) is an independently reachable endpoint and is frequently the one
  missing an authorization check.
- Map **mutations** separately from queries — they are the state-changing surface.
- Record **subscriptions**: the WebSocket handshake carries (or fails to carry) authentication, and
  `connectionParams` is a different auth path from the HTTP header used by queries. Check it separately.
- Note **federation**: a subgraph's `@key` resolver (`_entities`) is reachable from the gateway and is often
  written assuming the gateway already authorized — trace whether the subgraph is directly reachable.
- `in` for a GraphQL source is **`json`** (the POST body) in the plugin's fixed enum, with the variable name as
  `name`. A GET-over-query-string GraphQL endpoint is `query` and additionally a CSRF surface.

---

## Attack classes

**Field-level authorization (the dominant class).** Authorization at the **query root only** is the defining
GraphQL authz bug: `me { ... }` is authorized, but `me { organization { members { email } } }` traverses into
objects the caller may not own, because the nested resolvers inherited no check. Audit **per field**, and
specifically every **edge** that crosses an ownership or tenant boundary. A `@auth`/`@hasRole` **schema
directive** is a real defense — confirm it is actually wired into the executable schema and applied to the
field you are judging, not merely declared in the SDL.

**IDOR through node/global IDs.** Relay-style `node(id: "...")` and any `Query.user(id:)` take a
caller-supplied opaque id. Base64 is **encoding, not authorization** — decode it and check whether the
resolver compares the loaded object's owner to the session principal. A global-ID resolver that dispatches by
type prefix is a single chokepoint worth reading closely.

**DataLoader / batching cache poisoning.** A DataLoader cache keyed only by object id and **shared across
requests or tenants** returns another tenant's object. The key must include the tenant/principal scope, or the
loader must be per-request. Check where the loader is constructed: module scope = shared, request-context
scope = safe.

**Introspection and field suggestions.** Introspection enabled in production is **information disclosure, not
a vulnerability on its own** — hardening unless you tie it to a concrete exposure. More useful: **"Did you
mean" field suggestions** reconstruct the schema even with introspection disabled, and an **error message that
echoes the database error** is a far better oracle than the schema.

**Resource exhaustion** (hand off to `resource-exhaustion-auditor`). Unbounded **query depth** (recursive
`friends { friends { ... } }`), **field duplication / aliasing** (`a: user{...} b: user{...}` ×1000),
**batched operations** in a single POST array, **circular fragments**, and **query cost** with no complexity
limit. The controls are a depth limit, a complexity/cost analyser, an operation limit, and persisted queries.
Their **absence on an unauthenticated endpoint** is the finding; on an authenticated internal API it is
hardening.

**Injection through resolver arguments.** Arguments are typed but **not sanitized**: a `String` argument
interpolated into SQL, a NoSQL filter, a shell command or a template is the same injection as anywhere. A
custom scalar's `parseValue` is a validation point — read it. Filter/sort/`where` arguments that map onto
column names are identifier-slot injection.

**CSRF.** A GraphQL endpoint that accepts `GET` with a `query` parameter, or `POST` with
`Content-Type: text/plain` / `application/x-www-form-urlencoded` / `multipart/form-data`, is reachable by a
browser form or navigation and is CSRF-able when cookie-authenticated. Requiring `application/json` (which
forces a preflight) or a CSRF token is the defense. `apollo-server` has a CSRF-prevention option — check
whether it is enabled.

**Aliasing around rate limits.** A rate limiter counting **HTTP requests** counts one for a query that aliases
the same mutation 500 times. Login/OTP/invite mutations behind a per-request limiter are brute-forceable this
way. The limiter must count **operations or cost**, not requests.

**Batched mutation atomicity.** Multiple mutations in one document execute **serially**; a partial failure
leaves partial state unless the resolvers share a transaction. Hand off to `business-logic-auditor`.

---

## Safe or non-reportable forms

- **Introspection enabled** with no further exposure — hardening (`informational`), not a vulnerability.
- A **nested field with no explicit check** whose parent resolver already scoped the query to the principal
  (`ctx.user.organizations` → the children are reachable only through an owned root). Trace the parent before
  claiming a missing check; this is the most common GraphQL false positive.
- `@auth` / `@hasRole` directives, or a middleware layer (`graphql-shield`, NestJS guards on resolvers) that
  provably applies to the field in the executable schema.
- Typed `ID`/`Int` arguments reaching a parameterized ORM query — not injection.
- **Depth/complexity limits absent on an authenticated internal API** behind an effective gateway limiter —
  hardening, not a DoS finding. Say which limiter you found.
- A **persisted-query-only** endpoint (arbitrary documents rejected) — depth, aliasing and batching classes
  are closed by construction. Confirm the allowlist is enforced server-side, not just used by the client.
- Base64 global IDs described as "obfuscation" in a comment — that is the project's own words, not a defense,
  but it is also not a finding unless the resolver actually skips the ownership check.

---

## Commands

```bash
# schema + resolver surface
rg -n 'type (Query|Mutation|Subscription)' --glob '*.graphql' --glob '*.gql' --glob '*.ts' --glob '*.js'
rg -n 'buildSchema|makeExecutableSchema|@ObjectType|@Resolver|@Query\(|@Mutation\(|@FieldResolver|strawberry\.|graphene\.'
rg -n 'resolvers\s*[:=]|Resolvers\s*=' -A5

# authorization wiring
rg -n '@auth|@hasRole|@requiresAuth|@authenticated|shield\(|allow\b|deny\b|rule\(|@UseGuards'
rg -n 'directiveResolvers|schemaDirectives|mapSchema|applyMiddleware'

# node/global id + ownership
rg -n 'node\(|globalId|fromGlobalId|toGlobalId|base64|Buffer\.from\(.*base64'
rg -n 'findUnique\(|findById\(|objects\.get\(|find_by\(' -A3   # check for an owner/tenant predicate

# dataloader scope (module scope = shared across requests)
rg -n 'new DataLoader' -B5

# limits + CSRF + introspection
rg -n 'depthLimit|queryComplexity|costAnalysis|createComplexityRule|persistedQueries|APQ'
rg -n 'introspection\s*:|__schema|NoSchemaIntrospectionCustomRule|csrfPrevention'
rg -n 'text/plain|application/x-www-form-urlencoded|multipart/form-data' --glob '*graphql*'

# subscriptions (separate auth path)
rg -n 'connectionParams|onConnect|subscriptions-transport-ws|graphql-ws|SubscriptionServer'

# federation
rg -n '@key|_entities|resolveReference|buildSubgraphSchema|@external'

# injection through arguments
rg -n 'args\.\w+|variables\[|parseValue|parseLiteral' -A2
```
