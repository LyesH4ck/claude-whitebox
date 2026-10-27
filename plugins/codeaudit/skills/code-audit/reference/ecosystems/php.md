# PHP review reference

Load when `composer.json` is present, or for a WordPress/Drupal/Magento tree. Covers Laravel, Symfony, Twig,
Blade, Doctrine, Eloquent, `unserialize`/phar, process APIs, dynamic includes, and PHP's type-juggling traps.

Resolve versions from `composer.lock` (exact `version` per package) and the PHP runtime from the Dockerfile
base image / `composer.json` `require.php` / CI matrix. See `README.md` for the version-sensitivity rule.

---

## Version facts to check

**PHP-CGI argument injection (CVE-2024-4577)** — a bypass of the old CVE-2012-1823 protection. Windows
"Best-Fit" code-page conversion turns certain characters into option characters that PHP-CGI then reads as
command-line **options**, giving source disclosure or arbitrary PHP execution to an unauthenticated attacker.
Fixed in **8.3.8, 8.2.20, 8.1.29**; 8.0 and earlier are EOL and unpatched.
Sources: <https://nvd.nist.gov/vuln/detail/CVE-2024-4577>,
<https://www.rapid7.com/db/vulnerabilities/exploit/windows/http/php_cgi_arg_injection_rce_cve_2024_4577/>
→ **Three preconditions, all required**: Windows host, Apache + PHP-CGI (or php-cgi exposed), and a
vulnerable code page. On a Linux container running PHP-FPM this row is **not applicable** — record it in
`tested_not_vulnerable` with the deployment evidence rather than reporting it. Distro packages carry
backported fixes under different version numbers; check the vendor package, not the upstream number.

**Language-level removals that invert old verdicts.**
- `preg_replace` with the `/e` modifier (eval) — **removed in PHP 7.0**. On a PHP 7+ runtime this is not a
  code-execution sink; it is a fatal error.
- `assert()` evaluating a **string** argument — removed in **PHP 8.0**.
- `create_function()` — removed in **PHP 8.0**.
→ Finding one of these in a codebase that runs on PHP 8 is dead code, not RCE. Read the runtime pin first.
Conversely, a project still pinned to PHP 5.x/7.0 re-opens every one of them.

**`unserialize()` + phar deserialization.** `unserialize()` on attacker bytes instantiates objects and runs
magic methods (`__wakeup`, `__destruct`, `__toString`) — a POP-chain sink at **every** PHP version. Separately,
**any** filesystem function given a `phar://` path (`file_exists`, `is_dir`, `getimagesize`, `file_get_contents`,
`unlink`, …) deserializes the phar metadata. PHP 8.0 restricted some phar-stream behaviour, but treat a
user-controllable path reaching a filesystem function as a deserialization sink unless the scheme is
allowlisted. `unserialize($x, ['allowed_classes' => false])` is the safe form.

---

## Framework defaults

**Laravel.**
- **Eloquent/DB parameterizes** bound queries. Raw escape hatches: `DB::raw()`, `whereRaw`, `havingRaw`,
  `orderByRaw`, `selectRaw`, `DB::statement`, and `->orderBy($userColumn)` — **column/direction identifiers are
  not bindable**, so a request-controlled sort column is injection even inside the query builder.
- **Blade `{{ $v }}` escapes; `{!! $v !!}` does not.** Escaping covers the HTML-text slot only — `<a
  href="{{ $url }}">` still needs a scheme check, and `<script>var x = {{ $v }}</script>` is a JS slot.
- **Mass assignment** is governed by `$fillable` / `$guarded`. `$guarded = []` **disables protection
  entirely** and is the single highest-signal grep in a Laravel audit. `Model::unguarded()`, `forceFill()`
  and `->fill($request->all())` are the other forms. `$request->validated()` is a real defense **only** if the
  FormRequest rules omit the privileged fields *and* the validated array is what reaches `fill`/`update`.
- **Authorization** is Gates/Policies: `$this->authorize()`, `can:` middleware, `Gate::allows`. A policy method
  that is **not** named for the ability, or a model with no registered policy, silently falls through — check
  `AuthServiceProvider` registration, not just the policy file's existence.
- `APP_DEBUG=true` in production exposes stack traces and env values via the error page.

**Symfony.**
- Doctrine DQL/QueryBuilder parameterizes `:params`; `->where("x = $v")` and `->add('orderBy', $v)` do not.
- Twig **auto-escapes HTML by default**; escape hatches are `|raw`, `{% autoescape false %}`, and a wrong
  **escape strategy** for the slot (`|escape('html')` inside a `<script>` or `href` is the wrong strategy —
  `|escape('js')` / `|escape('url')` exist for a reason).
- Authorization is voters + `access_control` in `security.yaml` + `#[IsGranted]`. `access_control` matches
  **top-down, first match wins** — a broad `^/` rule above a specific one changes the effective policy.
  Verify the firewall's `stateless`, `anonymous`/`lazy` settings before judging a route unauthenticated.
- Twig sandbox (`SandboxExtension`) is the defense when template **source** is user-supplied — without it,
  user-supplied Twig is SSTI with a documented RCE path.

**WordPress.** `$wpdb->prepare()` is the parameterized form; `$wpdb->query("... $v")` is not. Output escaping
is slot-specific by design: `esc_html`, `esc_attr`, `esc_url`, `esc_js`, `wp_kses_post`. Capability checks
(`current_user_can`) and nonces (`check_admin_referer`, `wp_verify_nonce`) are **separate** controls — a nonce
is CSRF protection, **not** authorization, and an `admin-ajax`/REST callback with a nonce but no capability
check is a real authz finding.

---

## Dangerous APIs

- **Command execution** — `system`, `exec`, `shell_exec`, `passthru`, `popen`, `proc_open`, backticks,
  `pcntl_exec`. `escapeshellarg` is the per-argument defense; `escapeshellcmd` is **not** equivalent and is
  routinely misapplied.
- **Dynamic execution / include** — `eval`, `include`/`require` with a computed path, `$$var`, `$fn()` with a
  computed name, `call_user_func($user, ...)`, `array_map($user, ...)`, `usort($a, $user)`.
- **Deserialization** — `unserialize`, `phar://` reaching any filesystem function, `yaml_parse` with
  `YAML_PARSE_OBJECTS`.
- **SSTI** — `twig_template_from_string` / `createTemplate` on user source, Blade `@php`, Smarty
  `{php}`/`display($userTemplate)`.
- **XXE** — `simplexml_load_string`, `DOMDocument::loadXML`, `XMLReader` when external entities are enabled.
  On libxml2 ≥ 2.9 entity loading defaults off; `libxml_disable_entity_loader(false)` or
  `LIBXML_NOENT` re-enables it — **that flag is the finding**, not the parser call.
- **Path / upload** — `file_get_contents`/`fopen`/`unlink`/`move_uploaded_file` with a computed path,
  `$_FILES['f']['name']` used as the stored filename, `ZipArchive::extractTo` without entry containment.
- **SSRF** — `curl_exec` with a computed URL and `CURLOPT_FOLLOWLOCATION`, `file_get_contents('http://...')`,
  `fsockopen`. `allow_url_fopen` turns every file read into a potential fetch.
- **Type juggling & comparison** — `==` / `in_array($x, $a)` / `switch` with loose comparison on tokens,
  hashes or secrets. `"0e123" == "0e456"` is **true** (magic hashes). Use `===` and `hash_equals()`.
  `strcmp()` returning `null` on an array argument has been a real auth-bypass primitive.

---

## Safe or non-reportable forms

- `$wpdb->prepare("... %s", $v)`, Eloquent `where('c', $v)`, Doctrine `setParameter()` — parameterized.
- `escapeshellarg($v)` around **each** argument of an otherwise literal command — safe. Note it does not
  protect the *program name* or an argument that is itself an option (`--output=...`).
- `{{ $v }}` (Blade) / `{{ v }}` (Twig) in an HTML-text slot — escaped. Not XSS without a different slot or a
  `|raw` / `{!! !!}`.
- `unserialize($x, ['allowed_classes' => false])` — no object instantiation.
- `preg_replace` `/e`, string `assert()`, `create_function()` on a **PHP 8 runtime** — removed; dead code, not
  RCE. Report as code quality at most.
- `md5`/`sha1` as a cache key, ETag, or content fingerprint — not a crypto finding. As a **password hash** or
  a signature it is. `password_hash()`/`password_verify()` is the correct password primitive.
- `$guarded` left at its **default** (`['*']`-equivalent protection via `$fillable`) — only `$guarded = []`,
  `unguarded()`, `forceFill()` and `fill($request->all())` are the mass-assignment shapes.
- CVE-2024-4577 on a non-Windows / non-CGI deployment — not applicable.

---

## Commands

```bash
# versions first
rg -n '"(laravel/framework|symfony/\w+|twig/twig|guzzlehttp/guzzle)"' composer.json
rg -n '"name": "(laravel/framework|symfony/http-kernel|twig/twig)"' -A3 composer.lock
rg -n '"php"\s*:|FROM php:' composer.json Dockerfile* 2>/dev/null

# command / dynamic execution / include
rg -n '\b(system|exec|shell_exec|passthru|popen|proc_open|pcntl_exec)\s*\(' --glob '!vendor'
rg -n '\beval\s*\(|\binclude\s*[\(\$]|\brequire\s*[\(\$]|call_user_func|\$\$|\$[a-zA-Z_]+\s*\(' --glob '!vendor'
rg -n 'preg_replace\s*\(.*/e|create_function|assert\s*\(\s*\$' --glob '!vendor'

# deserialization / phar
rg -n 'unserialize\s*\(|phar://|yaml_parse|YAML_PARSE_OBJECTS' --glob '!vendor'

# SQL raw escape hatches (identifiers included)
rg -n 'DB::raw|whereRaw|havingRaw|orderByRaw|selectRaw|DB::statement|->query\(|\$wpdb->query' --glob '!vendor'
rg -n 'orderBy\(\$|->add\(.orderBy|ORDER BY \{?\$' --glob '!vendor'

# mass assignment / authz
rg -n '\$guarded\s*=\s*\[\s*\]|unguarded\(|forceFill\(|->fill\(\$request|\$request->all\(\)' --glob '!vendor'
rg -n 'authorize\(|Gate::|#\[IsGranted|access_control|current_user_can|wp_verify_nonce|check_admin_referer' --glob '!vendor'

# XSS slots
rg -n '\{!!|\|raw\b|autoescape false|echo \$_|print \$_' --glob '!vendor'

# XXE / uploads / SSRF
rg -n 'libxml_disable_entity_loader|LIBXML_NOENT|simplexml_load|loadXML' --glob '!vendor'
rg -n 'move_uploaded_file|\$_FILES|extractTo' --glob '!vendor'
rg -n 'curl_setopt|CURLOPT_FOLLOWLOCATION|file_get_contents\(.https\?://|fsockopen|allow_url_fopen' --glob '!vendor'

# type juggling on secrets
rg -n '==\s*\$?(token|hash|secret|password|signature|sig)|in_array\(|strcmp\(' --glob '!vendor'
```
