# Ruby review reference

Load when a `Gemfile` is present. Covers Rails, Sinatra, ActiveRecord, ERB/Slim/Haml, Pundit/CanCanCan,
Marshal/YAML, and Ruby's dynamic-dispatch primitives.

Resolve versions from `Gemfile.lock` (the `specs:` block has exact versions) and the Ruby version from
`.ruby-version` / `Gemfile`'s `ruby` directive. See `README.md` for the version-sensitivity rule.

---

## Version facts to check

**Active Record — RCE escalation through YAML serialized columns (CVE-2022-32224).**
`serialize :options` with the **default YAML coder** deserializes arbitrary objects from the column. Fixed in
**7.0.3.1, 6.1.6.1, 6.0.5.1, 5.2.8.1**; the fix switches serialized columns to safe loading.
Source: <https://groups.google.com/g/rubyonrails-security/c/MmFO3LYQE8U>
→ Three things invert the verdict even above the cutoff: `config.active_record.use_yaml_unsafe_load = true`
**restores the vulnerability** (grep for it), `yaml_column_permitted_classes` widens the allowlist, and
`serialize :values, JSON` was never affected. The exploitable precondition is an attacker-writable path into
that column — a serialized column only ever written by server-trusted code is a `design_properties` note.

**Psych / `YAML.load`.** Psych 4 (default on **Ruby 3.1+**) made `YAML.load` **safe by default**
(`safe_load` semantics); on Ruby ≤ 3.0 / Psych 3, `YAML.load` is `unsafe_load` and is an object-instantiation
sink. `YAML.unsafe_load` and `Psych.unsafe_load` are explicit sinks at every version.
→ Read `.ruby-version` before calling `YAML.load` RCE. This cutoff flips the verdict completely.

**`Marshal.load`** — instantiates arbitrary objects and is a gadget-chain sink at **every** Ruby version.
There is no safe mode. Any attacker-influenceable bytes reaching it is a finding; cookies/session stores using
the `:marshal` serializer are the classic reachable path (`config.action_dispatch.cookies_serializer`).

**Rails `render` with a user-controlled argument (CVE-2019-5418 lineage).** `render file:` / `render
template:` with request-derived values has produced path traversal and local file disclosure. Modern Rails
narrows `render file:` to absolute paths, but **`render inline:` is ERB evaluation** and `render` with a
user-chosen template name remains a template-selection sink. Confirm the Rails version's semantics before
reporting, and report the *selection* of the template, not `render` itself.

---

## Framework defaults

**Rails.**
- **ActiveRecord parameterizes** hash conditions and `?`/named placeholders. Injection lives in the string
  forms: `where("name = '#{p}'")`, `order(params[:sort])`, `pluck(params[:col])`, `group`, `having`, `joins`,
  `select`, `find_by_sql`, `exists?(string)`. **Identifiers are not bindable** — `order`/`pluck` take raw SQL,
  so a request-controlled sort column is injection even though no string interpolation is visible. The
  defense is an allowlist (`%w[name created_at].include?(params[:sort])`), not sanitization.
- **ERB auto-escapes** in `.html.erb`. Escape hatches: `raw()`, `.html_safe`, `<%== %>`, `sanitize()` with a
  permissive config, and `content_tag` with an unescaped attribute. `html_safe` is **not** a blanket pass
  through concatenation: `ActiveSupport::SafeBuffer#+`/`<<` **escape** an unsafe operand, so
  `helper.html_safe + params[:q]` is escaped — do not report XSS on that shape. The real sink is
  `.html_safe`/`raw()` applied to the **tainted value itself**, typically a helper that interpolates user
  data into a string and then marks the whole result safe.
- **Strong parameters** are the mass-assignment control: `params.require(:user).permit(:name)`. The shapes to
  flag are `params.permit!`, `params.require(:user).permit!`, and any `update(params[:user])` without
  `permit`. A `permit` list that **includes** `:role`/`:admin`/`:account_id`/`:user_id` is mass assignment
  even though `permit` was used — read the list, not the method name.
- **CSRF**: `protect_from_forgery` is on by default in `ApplicationController`. `skip_before_action
  :verify_authenticity_token` is the escape hatch — common on API controllers, and correct there **only** if
  that controller is not cookie-authenticated. A cookie-session controller with CSRF skipped is a finding.
  `protect_from_forgery with: :null_session` silently degrades rather than rejecting.
- **Authorization** is Pundit (`authorize @record`, `policy_scope`) or CanCanCan (`load_and_authorize_resource`,
  `Ability`). Pundit's `after_action :verify_authorized` is what makes a *missing* `authorize` call fail
  loudly — its absence means a forgotten `authorize` is silent. Check for it.
- `config.force_ssl`, `secure`/`httponly` cookie flags, and `filter_parameters` (which prevents secrets
  reaching the logs) live in `config/environments/production.rb` — read that file, not `development.rb`.

**Sinatra.** No guards by default; `before` filters are the only inherited control and are path-scoped by
their pattern. `send_file`/`File.read` with a computed path have no containment helper.

---

## Dangerous APIs

- **Command execution** — backticks, `%x[]`, `system`, `exec`, `Kernel.open("|cmd")`, `IO.popen`,
  `Open3.capture*` with a single string, `spawn` with a string. `Kernel#open` with a `|`-prefixed string
  executes — that is why `open(params[:url])` is command injection, not just SSRF.
- **Dynamic dispatch** — `eval`, `instance_eval`, `class_eval`, `send`/`public_send` with a computed method
  name, `const_get(user)`, `Object.const_get`, `define_method` from input, `Marshal.load`.
- **Deserialization** — `Marshal.load`, `YAML.load` (version-dependent, above), `YAML.unsafe_load`,
  `Oj.load` in default (object) mode — `Oj.safe_load` / `:mode => :strict` is the safe form.
- **Templates** — `ERB.new(user).result(binding)`, `render inline:`, Slim/Haml from user source.
- **Path / archive** — `File.read`/`File.open`/`send_file` with a computed path, `FileUtils` on user paths,
  `Zip::File` extraction without entry containment, `Dir.glob` on user input.
- **SSRF** — `Net::HTTP`, `open-uri`'s `URI.open`, `HTTParty`, `Faraday`, `RestClient` with a computed URL.
  `URI.open` on `file://` reads local files; `URI.open` on a `|` string can execute.
- **Crypto** — `rand`/`SecureRandom` confusion (`rand` is not a CSPRNG), `Digest::MD5`/`SHA1` for passwords,
  `OpenSSL::SSL::VERIFY_NONE`, `==` on secrets instead of `ActiveSupport::SecurityUtils.secure_compare`.
- **Regex** — Ruby's `^`/`$` match **line** boundaries, not string boundaries. A validator written as
  `/^https?:\/\/trusted\.com/` is bypassable with a newline (`\nhttps://evil.com`). `\A`/`\z` are the correct
  anchors. This is a real, recurring Rails auth/redirect bypass — check every validation regex's anchors.

---

## Safe or non-reportable forms

- `where(name: p)`, `where("name = ?", p)`, `where("name = :n", n: p)` — parameterized.
- `order(params[:sort])` **with an allowlist check before it** — safe; cite the allowlist line.
- `YAML.load` on **Ruby 3.1+ / Psych 4** — safe-by-default. Only `unsafe_load` and an explicit
  `permitted_classes` widening are sinks there.
- `serialize :values, JSON` or `serialize :values, coder: JSON` — never affected by CVE-2022-32224.
- `<%= v %>` in `.html.erb` — escaped HTML-text slot. Not XSS without `raw`/`html_safe`/a different slot.
- `skip_before_action :verify_authenticity_token` on a **token-authenticated** API controller with no cookie
  session — not CSRF. On a cookie-session controller it is.
- `permit(:name, :email)` — strong parameters applied correctly. Only `permit!`, a missing `permit`, or a
  privileged field inside the list are findings.
- `SecureRandom.hex`/`uuid` for tokens — correct. `rand`/`Random.new` for them is not.
- `Digest::MD5` as a cache key or ETag — not a crypto finding.

---

## Commands

```bash
# versions first
rg -n '^\s{4}(rails|activerecord|actionpack|psych|oj|nokogiri|puma) \(' Gemfile.lock
cat .ruby-version 2>/dev/null; rg -n '^ruby ' Gemfile

# SQL injection (string forms + identifier slots)
rg -n 'where\(["'\'']|find_by_sql|execute\(|order\(|reorder\(|pluck\(|group\(|having\(|select\(' app lib

# command / dynamic dispatch / deserialization
rg -n '`|%x\[|system\(|IO\.popen|Open3\.|Kernel\.open|\bopen\('  app lib
rg -n '\beval\(|instance_eval|class_eval|\.send\(|public_send\(|const_get\(' app lib
rg -n 'Marshal\.load|YAML\.(unsafe_)?load|Psych\.(unsafe_)?load|Oj\.load' app lib config

# CVE-2022-32224 triggers
rg -n 'serialize\s+:|use_yaml_unsafe_load|yaml_column_permitted_classes|cookies_serializer' app config

# XSS slots
rg -n '\.html_safe|\braw\(|<%==|sanitize\(|content_tag' app

# mass assignment + authz + CSRF
rg -n 'permit!|\.permit\(|params\[:\w+\]\)' app/controllers
rg -n 'authorize |policy_scope|load_and_authorize_resource|verify_authorized|skip_before_action|protect_from_forgery' app/controllers

# regex anchors (^ / $ instead of \A / \z)
rg -n 'format:\s*/\^|=~ /\^|match\?\(/\^|validates.*\^' app

# SSRF / TLS / crypto
rg -n 'Net::HTTP|URI\.open|HTTParty|Faraday|RestClient|VERIFY_NONE' app lib
rg -n '\brand\(|Digest::(MD5|SHA1)|secure_compare|==\s*@?(token|secret|digest)' app lib
```
