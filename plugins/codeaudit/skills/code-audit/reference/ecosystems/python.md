# Python review reference

Load when `requirements.txt`, `pyproject.toml`, `Pipfile`, `setup.py` or `environment.yml` is present.
Covers Django, Django REST Framework, Flask, FastAPI, SQLAlchemy, Jinja2, PyYAML, pickle-family loaders,
`subprocess`, XML parsers, and `requests`/`urllib3`/`httpx`.

Resolve versions from `poetry.lock` / `Pipfile.lock` / pinned `requirements.txt` / `pip freeze` output in the
repo. A `>=` range is not a version. See `README.md` for the binding version-sensitivity rule.

---

## Version facts to check

**Django — SQL injection through column aliases (CVE-2022-28346) and `explain()` options (CVE-2022-28347).**
`QuerySet.annotate()`, `aggregate()` and `extra()` were injectable **through the column alias**, i.e. through a
crafted dict expanded into `**kwargs`. `QuerySet.explain()` was injectable through option names in `**options`
(PostgreSQL). Fixed in **2.2.28, 3.2.13, 4.0.4**.
Sources: <https://docs.djangoproject.com/en/stable/releases/3.2.13/>,
<https://docs.djangoproject.com/en/stable/releases/2.2.28/>
→ The exploitable shape is `**request_controlled_dict` reaching those methods. `annotate(total=Sum('x'))` with
literal keyword names is not reachable. **At any version**, a *dynamically built* alias name is still
attacker-controlled identifier input — the fix closed the framework's escaping, not your dynamic key.

**Django — SQL injection in `QuerySet.values()` / `values_list()` on `JSONField` (CVE-2024-42005).**
A crafted JSON object **key** passed as an argument injects into the column alias. Fixed in **5.0.8, 4.2.15**.
Sources: <https://www.wiz.io/vulnerability-database/cve/cve-2024-42005>,
<https://advisories.gitlab.com/pkg/pypi/django/CVE-2024-42005/>
→ Requires a model with a `JSONField` **and** request-controlled arguments to `values()`/`values_list()`.

**PyYAML — `yaml.load()` without an explicit `Loader` instantiates arbitrary Python objects** (CVE-2017-18342).
`5.1` made the no-Loader call warn; `6.0` requires `Loader`. `yaml.safe_load` / `SafeLoader` is the safe form;
`yaml.load(x, Loader=yaml.FullLoader)` is **not** `safe_load`, but it is **not arbitrary code execution at
>= 5.4** either: its two escapes (CVE-2020-1747, CVE-2020-14343) were fixed in 5.3.1 and 5.4. Compare the
pinned version before reporting it.
→ Report when untrusted bytes reach `yaml.load` with `Loader=UnsafeLoader`/`yaml.Loader` or
`yaml.unsafe_load` at any version, and with `FullLoader` **only below 5.4** (name the pinned version). On PyYAML ≥ 6, a bare `yaml.load(x)` raises rather than executing — check the version
before calling it RCE.

**`requests` — `Proxy-Authorization` leaked to the destination host across an HTTPS redirect**
(CVE-2023-32681, affects 2.3.0 ≤ v < **2.31.0**). `rebuild_proxies` re-attaches the header, which over HTTPS
belongs in `CONNECT` and therefore reaches the destination server instead of the proxy.
Source: <https://nvd.nist.gov/vuln/detail/CVE-2023-32681>
→ Only reachable when the app actually uses an authenticated proxy. No proxy config = not applicable; say so.

**`urllib3` — request body retained across a 301/302/303 that downgrades the method to GET**
(CVE-2023-45803). Fixed in **1.26.18** and **2.0.7**.
Source: <https://nvd.nist.gov/vuln/detail/CVE-2023-45803>
→ Needs a POST-style body carrying sensitive data **and** an attacker-influenceable redirect target. Low on
its own; it matters when chained with an SSRF finding — note it as a `chain` candidate.

**Jinja2 — HTML attribute injection via the `xmlattr` filter (CVE-2024-34064), fixed in 3.1.4.** The earlier
fix (CVE-2024-22195) addressed spaces only, not other non-attribute characters.
Source: <https://security-tracker.debian.org/tracker/CVE-2024-34064>
→ **Version-independent rule from the advisory**: passing user input as `xmlattr` **keys** is an unintended
use and insecure at any version. Passing user input as **values** remains safe. This is the slot distinction
from `SOURCE_TO_SINK.md`, encoded in an upstream advisory.

**`tarfile` extraction filters (PEP 706 / CVE-2007-4559).** In **3.12 and 3.13**, `extract()`/`extractall()`
with no `filter=` falls back to `fully_trusted` with a `DeprecationWarning`. **3.14** changes the default to
`'data'`. Red Hat/AlmaLinux builds ship their own earlier safer default plus an env/config override.
Source: <https://github.com/python/cpython/issues/121999>
→ So: on ≤ 3.13, `extractall(path)` with no filter **is** a traversal sink for untrusted archives. On 3.14+
the default is safe and an explicit `filter='fully_trusted'`/`'tar'` is what you report. **Read the interpreter
version from the project's own pin** (`python_requires`, `.python-version`, the Dockerfile base image) — the
verdict inverts across that line.

---

## Framework defaults

**Django.** The ORM parameterizes; raw escape hatches are `.raw()`, `.extra()`, `RawSQL()`,
`connection.cursor().execute(f"...")`, and `.annotate(**untrusted)`. Django templates **auto-escape HTML text**;
escape hatches are `|safe`, `mark_safe()`, `{% autoescape off %}`, and `format_html` with an unescaped arg.
`SafeString` is **not** sticky through concatenation: `SafeString.__add__` returns a plain `str` unless the
right operand is also `SafeData`, so `mark_safe(prefix) + user_value` is escaped at render. Do not report XSS
on that shape. The real sinks stay `|safe`, `mark_safe()` applied to the tainted value itself, and
`format_html` with an unescaped argument. Redirect safety is
`url_has_allowed_host_and_scheme()` (named `is_safe_url` before 3.0) — a hand-rolled `startswith('/')` check is
bypassable with `//evil.com` and `/\evil.com`.
DRF: `permission_classes` is **class-level**; a `@action` inherits it unless overridden. `DEFAULT_PERMISSION_CLASSES`
defaulting to `AllowAny` is the fail-open default — read `settings.py` before judging any viewset.
`ModelSerializer` with `fields = '__all__'` is the mass-assignment shape; `read_only_fields` is the fix.

**Flask.** No authentication by default; guards are decorators and `before_request` hooks — confirm the
decorator is applied to **every** sibling route, including `methods=['POST']` variants registered separately.
Jinja2 auto-escapes by template **name**: `.html`, `.htm`, `.xml`, `.xhtml`, `.svg`, **and the no-name case**
— Flask's `select_jinja_autoescape` returns `True` when the filename is `None`, which is exactly
`render_template_string`, so it **does** auto-escape its variables. A `.txt` template does not. Do not report
reflected XSS on a `render_template_string(TEMPLATE, user=…)` variable; its real risk is **SSTI** when the
*template source itself* is user-controlled, which is a different slot. `send_file`/`send_from_directory` with a computed path:
`send_from_directory` applies `safe_join` containment, `send_file` does **not**.
The Werkzeug debugger (`debug=True`) is RCE-adjacent and must never be reachable in production.

**FastAPI.** Pydantic validates **shape**, not **authority** — a `role: str` field that validates fine is still
mass assignment if it reaches persistence. Dependencies (`Depends(get_current_user)`) are the guard; check they
are on the router **and** that `dependencies=[...]` at `include_router` is not silently overridden. Response
models (`response_model=`) do filter output fields — that is a real defense against over-exposure, but only
where declared.

**SQLAlchemy.** `session.execute(text(f"..."))` is the injection form; `text("... :p")` with `params` is safe.
`filter_by(**request.args)` is operator/column injection plus mass assignment.

---

## Dangerous APIs

- **Command execution** — `subprocess.*` with `shell=True`, `os.system`, `os.popen`, `commands.getoutput`,
  `pty.spawn`, any wrapper taking one interpolated string.
- **Dynamic execution** — `eval`, `exec`, `compile`, `__import__(user)`, `importlib.import_module(user)`,
  `getattr(obj, user_name)` reaching a callable, `operator.attrgetter(user)`.
- **Deserialization** — `pickle.load(s)`, `cPickle`, `dill`, `joblib.load`, `shelve`, `marshal`,
  `numpy.load(allow_pickle=True)`, `torch.load` without `weights_only=True`, `yaml.load` with an unsafe loader.
- **Templates (SSTI)** — `render_template_string(user)`, `Template(user).render()`, `jinja2.Environment` with a
  user-supplied template source, Django `Template(user_string)`. `{{7*7}}` → `49` is the witness.
- **XML / XXE** — `xml.etree.ElementTree`, `minidom`, `xml.sax`, `lxml.etree` with `resolve_entities=True` or a
  custom resolver, `xmlrpc`. `defusedxml` is the defense.
- **Path / archive** — `os.path.join(root, user)` without `os.path.realpath` containment,
  `zipfile.extractall`, `tarfile.extractall` (see the filter row above), `shutil.unpack_archive`.
- **SSRF** — `requests`, `httpx`, `urllib.request.urlopen`, `aiohttp`, `urllib3` with a computed URL.
  `urlopen` accepts `file://` — a scheme allowlist is mandatory, not optional.
- **Crypto** — `random` / `uuid1` for tokens, `hashlib.md5`/`sha1` for passwords, `verify=False` on requests,
  `ssl._create_unverified_context`, `==` on secrets instead of `hmac.compare_digest`.

---

## Safe or non-reportable forms

- Django ORM `filter()`/`exclude()`/`get()` with keyword lookups — parameterized. Only `raw`/`extra`/`RawSQL`/
  cursor interpolation / `**untrusted` aliases are injection sinks.
- `yaml.safe_load` / `yaml.load(x, Loader=SafeLoader)` — safe. On PyYAML ≥ 6, bare `yaml.load(x)` raises.
- `subprocess.run(["bin", user_arg])` with a **literal** program and `shell=False` (the default) — not
  shell-parsed. **But argv is not a free pass**: the argument still reaches the program's own option parser, so a
  user-controlled value that can begin with `-`/`--` is **argument injection** (CWE-88) against a
  flag-rich binary — `git --upload-pack=`, `curl -o`, `tar --checkpoint-action=exec=`, `find -exec`,
  `ffmpeg -f lavfi`. Safe only with a literal program **and** a value that cannot start with a dash
  (validate, or pass `--` first where the program supports it).
- `pickle.load` on a **first-party, non-attacker-writable** file (a build artifact, a model checkpoint shipped
  in the image) — record as `design_properties` with the write-path evidence, not as a finding. If **any**
  write path to that file is user-controllable, it is second-order deserialization and **is** a finding.
- `render_template("page.html", v=user)` — auto-escaped HTML-text slot. Not XSS unless `v` lands in an
  `href`/`<script>`/event-handler slot or passes through `|safe`.
- `send_from_directory(dir, user_name)` — contained. `send_file(os.path.join(dir, user_name))` is not.
- `random` for jitter, sampling, shuffling display order, or test data — not a crypto finding.
- A `@login_required` / `Depends(...)` guard on the **router or class**, inherited by the handler — resolve the
  inheritance before claiming a missing check.
- `hashlib.md5(...)` used as a **non-security digest** (cache key, ETag, content-addressing, dedup fingerprint)
  — `usedforsecurity=False` makes the intent explicit; without a password/signature/integrity role it is not a
  crypto finding.

---

## Commands

```bash
# installed versions first
rg -n '^(django|djangorestframework|flask|fastapi|pyyaml|requests|urllib3|jinja2|lxml)' -i requirements*.txt
rg -n 'name = "(django|flask|fastapi|pyyaml|requests|urllib3|jinja2)"' -A2 poetry.lock
rg -n 'python_requires|requires-python|FROM python:' setup.py pyproject.toml Dockerfile* 2>/dev/null

# command / dynamic execution
rg -n 'shell\s*=\s*True|os\.system|os\.popen|subprocess\.' 
rg -n '\beval\(|\bexec\(|__import__\(|importlib\.import_module\(|getattr\('

# deserialization
rg -n 'pickle\.load|cPickle|joblib\.load|dill\.|marshal\.|allow_pickle\s*=\s*True|torch\.load'
rg -n 'yaml\.load\(|yaml\.unsafe_load|UnsafeLoader|FullLoader'

# SQL raw escape hatches + alias injection
rg -n '\.raw\(|\.extra\(|RawSQL|cursor\(\)\.execute|text\(f["'\'']|\.annotate\(\*\*|\.aggregate\(\*\*|\.values\(\*'

# SSTI + XSS slots
rg -n 'render_template_string|Template\(|\|safe|mark_safe|autoescape off|format_html'

# XML / archives / paths
rg -n 'etree|minidom|xml\.sax|resolve_entities|extractall|unpack_archive|os\.path\.join\('

# SSRF + TLS + crypto
rg -n 'requests\.(get|post|put|request)|httpx\.|urlopen\(|aiohttp\.|verify\s*=\s*False|_create_unverified'
rg -n 'random\.|uuid1\(|md5\(|sha1\(|==\s*(token|secret|password|signature)'

# authz surface
rg -n 'login_required|permission_classes|IsAuthenticated|AllowAny|DEFAULT_PERMISSION_CLASSES|before_request|Depends\('
rg -n "fields\s*=\s*['\"]__all__['\"]|read_only_fields"
```
