# .NET / C# review reference

Load when `*.csproj`, `*.sln`, `*.fsproj` or `web.config` is present. Covers ASP.NET Core, legacy ASP.NET
(MVC/WebForms/Web API), Entity Framework / EF Core, Dapper, Razor, Newtonsoft.Json, `BinaryFormatter`, and
`System.Xml`.

Resolve versions from `packages.lock.json` / `*.csproj` `<PackageReference Version=...>` / `Directory.Packages.props`
and the runtime from `<TargetFramework>`. See `README.md` for the version-sensitivity rule.

---

## Version facts to check

**`BinaryFormatter` is removed in .NET 9.** The in-box implementation now **throws** on use, and the
`AppContext`/`runtimeconfig` switches that previously re-enabled it were removed too. Microsoft's stated reason
is that it "is an insecure format and the cause of many security bugs". The legacy behaviour survives only via
the unsupported `System.Runtime.Serialization.Formatters` compatibility package.
Sources: <https://learn.microsoft.com/dotnet/core/compatibility/serialization/9.0/binaryformatter-removal>,
<https://devblogs.microsoft.com/dotnet/binaryformatter-removed-from-dotnet-9>
→ Verdict inverts on `<TargetFramework>`: on **net9.0+**, a `BinaryFormatter.Deserialize` call is dead code
that throws — report it as hardening/code-quality. On **net8.0 and below, and on .NET Framework**, it is a live
RCE sink on untrusted bytes. **If the compatibility package is referenced on net9.0+, the sink is live again** —
grep for that package reference; it is exactly the "scanner-silencing" pattern the removal was meant to end.
Same family: `LosFormatter`, `ObjectStateFormatter`, `NetDataContractSerializer`, `SoapFormatter`.

**`Newtonsoft.Json` `TypeNameHandling`** — `Auto`, `All`, `Objects` or `Arrays` on a deserializer fed untrusted
JSON allows `$type`-directed instantiation (gadget chains). `TypeNameHandling.None` is the default and is safe;
a `SerializationBinder`/`ISerializationBinder` with a closed allowlist is the mitigation. This is
**configuration, not version** — there is no cutoff to check, which makes it easy to miss in a `deps` sweep
that only looks at versions. `System.Text.Json` has no equivalent by default.

**ViewState (WebForms / legacy ASP.NET).** `enableViewStateMac="false"` or a leaked/weak
`<machineKey>` in `web.config` turns `__VIEWSTATE` into a deserialization RCE sink. `ViewStateUserKey` is the
CSRF binding. These live in config, not code — read `web.config` and every `Web.*.config` transform.

---

## Framework defaults

**ASP.NET Core authorization.**
- `[Authorize]` is **opt-in per controller/action** unless a global filter or a fallback policy is registered
  (`options.Filters.Add(new AuthorizeFilter(...))`, or `.RequireAuthorization()` / `FallbackPolicy`). Without
  one, an action with no attribute is **anonymous**. `[AllowAnonymous]` **overrides** `[Authorize]` anywhere
  in the chain, including on the controller — a single stray `[AllowAnonymous]` opens the action.
- Minimal APIs: `app.MapGet(...)` is anonymous unless `.RequireAuthorization()` is chained — per endpoint or
  per `MapGroup`.
- Authorization **handlers**: an `AuthorizationHandler<TRequirement, TResource>` that never calls
  `context.Fail()` and conditionally calls `context.Succeed()` is fine; one that calls `Succeed()` in a
  `catch` or on a missing claim is fail-open.
- **Antiforgery** (`[ValidateAntiForgeryToken]`, `[AutoValidateAntiforgeryToken]`) is not automatic on
  Web API controllers. Cookie-authenticated POST endpoints without it are CSRF.

**Razor / output encoding.** `@model.Value` HTML-encodes by default. `@Html.Raw(v)`, `HtmlString`,
`MvcHtmlString`, and `@:`/`<text>` raw blocks are the escape hatches. Encoding is HTML-text only: `href="@v"`,
`<script>var x = @v</script>` and `onclick="@v"` are different slots. `@Html.Raw(Json.Serialize(v))` inside
`<script>` does not escape `</script>`; `JavaScriptEncoder` / `@Json.Serialize` with the correct encoder does.

**Data access.** EF/EF Core parameterize LINQ and `FromSqlInterpolated($"... {v}")` (the interpolated-string
overload builds parameters — it is **safe**, and mistaking it for concatenation is a common false positive).
`FromSqlRaw($"... {v}")` with a C# interpolated string **is** concatenation and is injection. Dapper
parameterizes `@p` with an anonymous object; string-built SQL is not. `ExecuteSqlRaw` same rule.
Identifiers (`ORDER BY`, table names) are not parameterizable — allowlist them.

**Mass assignment / over-posting.** Binding a request body straight to an EF entity
(`public IActionResult Update(User user)`) lets the client set `IsAdmin`, `RoleId`, `TenantId`.
`[Bind(nameof(...))]`, `[FromBody] UserDto` with an explicit DTO, and `TryUpdateModel` with an allowlist are
the controls. `[BindNever]` on the entity property is the per-field form.

**Path handling.** `Path.Combine(root, userPath)` **discards `root` entirely if `userPath` is absolute**
(`Path.Combine("/app", "/etc/passwd")` → `/etc/passwd`). That behaviour is the finding, and it is unique
enough to .NET that it is routinely missed. Containment requires `Path.GetFullPath` + a prefix check.

---

## Dangerous APIs

- **Command execution** — `Process.Start(string)`, `ProcessStartInfo` with `UseShellExecute = true` or
  `Arguments` built by concatenation (note `ArgumentList` is the safe argv form).
- **Deserialization** — `BinaryFormatter`/`LosFormatter`/`ObjectStateFormatter`/`SoapFormatter`/
  `NetDataContractSerializer`, `JavaScriptSerializer` with a `SimpleTypeResolver`, `XmlSerializer` with a
  caller-chosen type, `Newtonsoft` `TypeNameHandling` (above), `JsonConvert.DeserializeObject<T>` with
  `TypeNameHandling` in `JsonSerializerSettings`.
- **Dynamic execution** — `CSharpCodeProvider`/`Roslyn` compiling user input, `Assembly.Load`/`LoadFrom` on a
  computed path, `Activator.CreateInstance(Type.GetType(user))`, `DataTable.Compute` / `DataColumn.Expression`
  with user input (an under-known injection sink).
- **XXE** — `XmlDocument`/`XmlTextReader` with a non-null `XmlResolver` (null since .NET 4.5.2 defaults, but
  explicitly set in older/ported code), `XmlReaderSettings { DtdProcessing = DtdProcessing.Parse }`,
  `XPathDocument` over untrusted XML.
- **SSRF** — `HttpClient`, `WebClient`, `WebRequest.Create` with a computed URL. `HttpClientHandler`
  `AllowAutoRedirect` is **true** by default — re-validate the host after redirects.
- **Crypto** — `System.Random` for tokens (`RandomNumberGenerator` is correct), `MD5`/`SHA1` for passwords
  (`Rfc2898DeriveBytes`/ASP.NET Identity's hasher is correct), `ECB` mode, CBC without a MAC,
  `ServerCertificateCustomValidationCallback = (…) => true`, `==` on secrets instead of
  `CryptographicOperations.FixedTimeEquals`.

---

## Safe or non-reportable forms

- `FromSqlInterpolated($"SELECT * FROM T WHERE Id = {id}")` and `ExecuteSqlInterpolated` — **parameterized**.
  Only the `...Raw` variants given an interpolated/concatenated string are injection.
- EF LINQ (`Where(x => x.Id == id)`), Dapper with `new { id }` — parameterized.
- `Process.Start(new ProcessStartInfo { FileName = "git", ArgumentList = { "clone", url } })` — argv form,
  not shell-parsed. **But argv is not a free pass**: the argument still reaches the program's own option parser, so a
  user-controlled value that can begin with `-`/`--` is **argument injection** (CWE-88) against a
  flag-rich binary — `git --upload-pack=`, `curl -o`, `tar --checkpoint-action=exec=`, `find -exec`,
  `ffmpeg -f lavfi`. Safe only with a literal program **and** a value that cannot start with a dash
  (validate, or pass `--` first where the program supports it).
- `@model.Value` in a Razor HTML-text slot — encoded. Not XSS without `Html.Raw` or a non-text slot.
- `BinaryFormatter` on **net9.0+** without the compatibility package — throws; hardening, not RCE.
- `TypeNameHandling.None` (the default) or a closed `SerializationBinder` — safe.
- `System.Random` for jitter, shuffling, sampling or test data — not a crypto finding.
- MD5/SHA1 as a cache key, ETag or content fingerprint — not a crypto finding.
- An action without `[Authorize]` when a **global** `AuthorizeFilter` or `FallbackPolicy` is registered in
  `Program.cs`/`Startup.cs` — read the pipeline registration before claiming an anonymous endpoint.

---

## Commands

```bash
# target framework + package versions first (BinaryFormatter verdict depends on it)
rg -n '<TargetFramework' --glob '*.csproj'
rg -n 'System\.Runtime\.Serialization\.Formatters|Newtonsoft\.Json|PackageReference' --glob '*.csproj' --glob 'Directory.Packages.props'

# deserialization
rg -n 'BinaryFormatter|LosFormatter|ObjectStateFormatter|SoapFormatter|NetDataContractSerializer|SimpleTypeResolver'
rg -n 'TypeNameHandling|SerializationBinder|Type\.GetType\(|Activator\.CreateInstance\('

# viewstate / config
rg -n 'enableViewStateMac|machineKey|ViewStateUserKey|customErrors|<compilation.*debug="true"' --glob '*.config'

# command / dynamic execution
rg -n 'Process\.Start|ProcessStartInfo|UseShellExecute|ArgumentList'
rg -n 'DataTable\.Compute|DataColumn.*Expression|CSharpCodeProvider|Assembly\.Load'

# SQL — distinguish Interpolated (safe) from Raw (sink)
rg -n 'FromSqlRaw|ExecuteSqlRaw|SqlCommand\(|CommandText\s*=|string\.Format.*SELECT'
rg -n 'FromSqlInterpolated|ExecuteSqlInterpolated'   # expected SAFE — confirm before flagging

# authz surface
rg -n '\[Authorize|\[AllowAnonymous|RequireAuthorization\(|FallbackPolicy|AuthorizeFilter|MapGroup\('
rg -n '\[ValidateAntiForgeryToken|AutoValidateAntiforgeryToken'
rg -n 'context\.Succeed\(' -B3                        # fail-open handler shapes

# over-posting
rg -n '\[Bind\(|\[BindNever\]|TryUpdateModel|\[FromBody\]'

# XSS slots
rg -n 'Html\.Raw|HtmlString|MvcHtmlString|@Json\.Serialize|JavaScriptEncoder'

# path / XXE / SSRF / crypto
rg -n 'Path\.Combine\(|Path\.GetFullPath\(|ZipFile\.ExtractToDirectory'
rg -n 'XmlResolver|DtdProcessing|XmlTextReader|XmlDocument'
rg -n 'HttpClient|WebClient|WebRequest\.Create|AllowAutoRedirect|ServerCertificateCustomValidationCallback'
rg -n 'new Random\(|MD5\.Create|SHA1\.Create|CipherMode\.ECB|FixedTimeEquals'
```
