# Stacks without a dedicated reference — threat highlights only

Load when the repository carries a language or runtime the directory has no file for: **Rust** (Actix,
Axum, Rocket, Warp, Tide, Poem, Tonic, Lambda), **Elixir** (Phoenix), **Swift** (Vapor), **Dart** (Shelf),
**Lua** (OpenResty / nginx), **Clojure** (Ring / Compojure), **Erlang** (Cowboy), **Crystal** (Kemal),
**Apex** (Salesforce), **mobile** (Android, iOS), and **serverless handlers** (AWS Lambda, GCP Cloud
Functions, Azure Functions) in any language.

This file is honest about what it is: **three to six threat highlights per stack and no version cutoffs**. It
tells an auditor where the gate is and which sink is the usual one; it does not tell them whether the pinned
framework fixed anything. Recon routes here with key `other` **and still records the stack under
`uncovered_relevant_categories`**, so the report's `coverage_gaps` says that version facts were not compared.
Record the lockfile anyway (`Cargo.lock`, `mix.lock`, `Package.resolved`, `pubspec.lock`, `deps.edn`,
`rebar.lock`, `shard.lock`) — a future reference file will need it, and an auditor citing an advisory must
still name the pin.

---

## Version facts to check

None are maintained here. A version-sensitive claim about one of these stacks must cite the advisory and the
lockfile pin inline, per `README.md`; absent that, it is a `coverage_gaps` entry.

---

## Framework defaults

**Rust web frameworks — extractors validate structure, never content; the gate is a layer or a guard.**
- *Actix*: `App::new().wrap(mw)` is global, `web::scope().wrap(mw)` per scope — a scope that skips the wrap is
  public. `web::Query<T>` / `web::Json<T>` / `web::Path<T>` are user input. An auth middleware that calls
  `srv.call(req)` before deciding is fail-open.
- *Axum*: identity rides on `Extension<User>` / `State<App>`; handlers that do not extract it are
  unauthenticated. `.layer()` applies to routes **already merged**; the order of `.layer` vs `.merge`/`.nest`
  decides which routes a middleware covers.
- *Rocket*: request guards (`FromRequest`) are the gate; a handler with no guard argument is public.
  `#[catch(...)]` that renders raw error data leaks internals. Fairings run around the request, not instead
  of a guard.
- *Warp*: filters compose with `.and()`; the auth filter must precede the body extractor.
  `warp::any()` matches everything; `content_length_limit` is the body DoS bound.
- *Tide*: `app.with(mw)` runs in registration order; responses do not HTML-escape.
- *Poem*: `.with(mw)` / `.around(f)` wrap endpoints; `OpenApiService` ships a schema UI — confirm it is not on
  a sensitive route in production.
- *Tonic (gRPC)*: an `Interceptor` is per-method only if it checks every method; streaming RPCs authenticate
  at stream open, not per message. Unbounded `repeated`/`bytes` fields are the DoS shape.
- *Rust Lambda*: `LambdaEvent<T>::payload` is user-supplied; claims live on
  `request_context.authorizer` and must be read. `lazy_static`/`OnceCell` state survives invocations — a
  cross-tenant leak if it caches per-request data.
- Rust runtime SQL: `sqlx::query(&format!(...))` / `diesel::sql_query(format!(...))` is injection; the
  **compile-time** `sqlx::query!("... {}", arg)` macro is parameterised and safe.

**Elixir / Phoenix** — pipelines (`pipeline :api do plug :auth end`) are the gate; a route in a `scope` without
the authenticated pipeline is public. `Phoenix.HTML.raw/1` skips escaping. `live_session` `on_mount` is where
LiveView auth runs — confirm the hook actually halts. `:erlang.binary_to_term/1` on external input is unsafe
deserialization; use `/2` with `[:safe]`.

**Swift / Vapor** — routes outside `app.grouped(User.guardMiddleware())` are public; `req.jwt.verify(...)`
needs algorithm pinning; `req.session.data` is server state, `req.content` is user input.

**Dart / Shelf** — no built-in auth; `Pipeline().addMiddleware()` order is the gate. `request.url.queryParameters`
and `readAsString()` are user input; `Response.ok(body)` does not escape HTML.

**Lua / OpenResty** — `ngx.exec`, `ngx.redirect`, `os.execute`, `io.popen` with concatenated request data are
RCE/redirect sinks. `ngx.shared` dictionaries written from request data persist across requests (cache
poisoning when the read path trusts them). `ngx.re.match(host, "^https://api\\.example\\.com")` with no `$`
anchor is a host-validation bypass.

**Clojure / Ring** — middleware composes with `wrap-*`; auth must be inside the chain before the handler.
`wrap-anti-forgery` is opt-in: session-cookie apps without it are CSRF-exposed. `ring.util.response/redirect`
to a request value is open redirect.

**Erlang / Cowboy** — `init/2` is the entry; the auth decision must precede any state change.
`cowboy_req:binding/2`, `read_body/1`, `parse_qs/1` are user input. `binary_to_term/1` on external input is
unsafe deserialization.

**Crystal / Kemal** — no built-in auth; every `get "/x" do … end` is public unless a `before_*` filter
intercepts. JSON mapping is type-safe but content-unvalidated.

**Apex / Salesforce** — `without sharing` classes bypass row-level security: each one needs a stated reason and
a caller that cannot be an unprivileged user. `@AuraEnabled` and `@RestResource` methods are reachable from
Lightning / `/services/apexrest/` by any authenticated org user. `Database.query('… ' + input + '…')` is SOQL
injection; `[SELECT … WHERE id = :input]` is bound. CRUD/FLS checks (`isAccessible()`, `isUpdateable()`) are
not automatic on DML.

**Android** — `WebView` with `setJavaScriptEnabled(true)` + `addJavascriptInterface` on an attacker-influenced
URL is code execution; exported components (`android:exported="true"`, or implicit intent filters before
API 31) without `android:permission` are an IPC surface; `allowBackup`, cleartext traffic and a debuggable
release manifest are configuration findings.

**iOS** — custom URL schemes (`CFBundleURLSchemes` → `application(_:open:)`) receive attacker-controlled URLs;
universal links depend on the `apple-app-site-association` host set; `WKWebView.loadHTMLString(_:baseURL:)`
with a `file://` base grants the page local-file access; Keychain items without `WhenUnlocked` (or stricter)
and `NSAllowsArbitraryLoads` in `Info.plist` are configuration findings.

**Serverless handlers (any language)** — the authorizer's claims (`event.requestContext.authorizer`, Cloud
IAM, Azure Easy Auth) are the identity; a handler that does not read them is unauthenticated. Function/host
keys authenticate the *caller app*, not a user. Cold-start global state survives invocations on one container
(tenant leakage). Queue/blob/topic triggers carry user input whenever any web path can write to the queue.
Over-permissioned execution roles turn any injection into account-level impact; `--allow-unauthenticated`
(GCP) and `AuthorizationLevel.Anonymous` (Azure) make the function public.

---

## Safe or non-reportable forms

- `sqlx::query!` / `query_as!` compile-time macros with `{}` placeholders — parameterised.
- Rust extractors rejecting malformed input (type errors) — not a validation finding by themselves; the
  question is content, not shape.
- A Phoenix route under a pipeline that includes the auth plug, resolved through the router's `scope` nesting.
- `binary_to_term(Bin, [safe])` — the safe form.
- Apex `with sharing` (default for Aura/LWC controllers) with bound SOQL — not a finding.
- An Android `exported="true"` component whose purpose is an intent-filter entry point **with** an
  `android:permission` or signature-level check.
- A Lambda whose only trigger is an internal queue nothing web-reachable can write to — cite the producer.

---

## Commands

```bash
# Rust
rg -n 'format!\(' --glob '*.rs' | rg -n 'query|sql_query|Statement::from_string'
rg -n '\.wrap\(|\.layer\(|\.merge\(|\.nest\(|FromRequest|\.and\(' --glob '*.rs'
rg -n 'lazy_static!|OnceCell|static mut' --glob '*.rs'
# Elixir / Erlang
rg -n 'pipe_through|pipeline\s+:|plug\s+:|Phoenix\.HTML\.raw|on_mount|binary_to_term' --glob '*.ex' --glob '*.exs' --glob '*.erl'
# Swift / Dart / Crystal / Clojure / Lua
rg -n 'guardMiddleware|grouped\(|req\.jwt|addMiddleware|before_all|before_get|wrap-anti-forgery|wrap-|ngx\.(exec|redirect|shared|re\.match)|os\.execute|io\.popen' --glob '*.swift' --glob '*.dart' --glob '*.cr' --glob '*.clj' --glob '*.lua'
# Apex
rg -n 'without sharing|@AuraEnabled|@RestResource|Database\.query\(' --glob '*.cls'
# Android / iOS
rg -n 'exported="true"|addJavascriptInterface|setJavaScriptEnabled\(true\)|allowBackup|usesCleartextTraffic' --glob 'AndroidManifest.xml' --glob '*.kt' --glob '*.java'
rg -n 'CFBundleURLSchemes|NSAllowsArbitraryLoads|loadHTMLString|kSecAttrAccessible' --glob '*.plist' --glob '*.swift' --glob '*.m'
# serverless
rg -n 'requestContext\.authorizer|allow-unauthenticated|AuthorizationLevel\.Anonymous|functions\.https\.onRequest' 
```
