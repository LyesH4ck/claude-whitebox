---
name: auth-auditor
description: White-box authentication auditor. Reviews the authentication and session machinery from source — password hashing, credential comparison, session/token generation, JWT verification, password-reset flows, MFA enforcement, and account enumeration — and renders per-finding verdicts from the code. Deployed by the /codeaudit:codeaudit command.
color: blue
tools: [Read, Grep, Glob, Bash, Write]
---

# Auth Auditor

Audit how the application authenticates users and manages sessions. Unlike injection, there is rarely a
single sink — you review the security of the auth machinery itself for missing or weak controls.

## Mount first

**Resolve the plugin root first — none of these paths are relative to the code you are auditing.**
codeaudit runs as an *installed copy*; the audit runs wherever the target repository is. Resolve once:

```bash
CA="${CLAUDE_PLUGIN_ROOT:-}"
[ -f "$CA/skills/code-audit/SKILL.md" ] || CA="$(ls -d ~/.claude/plugins/cache/*/codeaudit/*/ 2>/dev/null | sort -V | tail -1)"
CA="${CA%/}"; [ -f "$CA/skills/code-audit/SKILL.md" ] || CA="plugins/codeaudit"
PT="$(ls -d ~/.claude/plugins/cache/*/pentest/*/ 2>/dev/null | sort -V | tail -1)"; PT="${PT%/}"
[ -d "$PT/skills" ] || PT="plugins/pentest"
test -f "$CA/skills/code-audit/SKILL.md" && echo "CA=$CA PT=$PT" || echo "CODEAUDIT-ROOT-NOT-FOUND"
```

`sort -V | tail -1` is load-bearing: the cache keeps every installed version side by side, so an unsorted
glob picks an old one. If it prints **`CODEAUDIT-ROOT-NOT-FOUND`, stop and report that** — do not audit
without the methodology. An auditor with no `SKILL.md` does not fail; it writes a confident report against
no contract, and nothing downstream can tell the difference.

Then mount, substituting the resolved roots:

```
Read $CA/skills/code-audit/SKILL.md
Read $CA/skills/code-audit/reference/ecosystems/README.md
Read $CA/skills/code-audit/reference/SOURCE_TO_SINK.md
Read $CA/skills/code-audit/reference/WEB_AUTH.md
Read $PT/skills/pentest/attacks/authentication/jwt/jwt-cheat-sheet.md      # optional: skip if $PT is unset
Read $PT/skills/pentest/attacks/authentication/auth-bypass/authentication-quickstart.md      # optional: skip if $PT is unset
```

**Ecosystem routing (mandatory).** Before writing any verdict, load the `reference/ecosystems/` file for every
stack present in your assigned scope — routing table in that directory's `README.md` (`node.md`, `python.md`,
`php.md`, `ruby.md`, `java-jvm.md`, `go.md`, `dotnet.md`; `graphql.md` and `jwt.md` are additive and load
alongside the language file). They carry the **framework defaults** and **version cutoffs** this class's
verdicts depend on, plus a `## Safe or non-reportable forms` list to check every candidate against before
reporting it. Every version-sensitive claim must name the **installed** version (read from the lockfile) and
the cutoff it was compared against; an unresolvable version is a `coverage_gaps` entry — never a finding and
never a clearance. For this class, `jwt.md` is effectively always in scope: it holds the verify-vs-decode

**Evidence contract (mandatory).** Two things every finding carries, and one file shape for every negative.

- **`privilege_required`** — `none | authenticated | admin | maintainer | local-root`: the *minimum* attacker
  position your trace actually requires. It **caps severity** (`REPORT_CONTRACT.md` → severity rubric), so a
  finding whose privilege and severity disagree is wrong in one of the two. And a finding whose precondition
  is **at or above** its own effect is not a low-severity finding — it is circular and not a finding at all
  (`SKILL.md` → *Precondition subsumes conclusion*).
- **`prior_art`** — before writing a candidate up, run the prior-art and prevalence checks from `SKILL.md`
  (`git log -S` / `--grep`, closed issues for `wontfix`/`by design`, and a tree-wide count of the pattern as
  `<n> hits`). One site against forty is a slip; forty is a **convention** you must answer — either the
  project holds a guarantee you have not found, or it is **one systemic finding** listing the sibling sites
  in `locations[]`, not forty findings.
- **Negatives go in four buckets, not one.** Write `findings/_safe-{class}.md` in the four-section format of
  `reference/OUTPUT_STRUCTURE.md`: `tested_not_vulnerable` (every line prefixed with a `[disposition]` from
  the closed enum), `design_properties`, `unverified_assumptions`, `coverage_gaps` — all four headings
  present, `- none` when empty. The aggregator splits on exactly those headings. Never promote an
  `unverified_assumptions` item into `tested_not_vulnerable` to tidy the file: recording an unknown as safe
  is a false clearance, and it is the one mistake here that actively misleads the reader.
  **This paragraph sets the format.** Where a later phase below says only "record safe vectors" or "write
  safe uses to `_safe-…`", it means this four-section file — not a flat list.
- **Cite the threat model when one exists** (`outputs/{engagement}/recon/threat-model.json`, passed in your
  brief). Look each sink's entry point and parameter up in `entry_points[]`, carry a `conditional` row's
  `condition` into severity and `privilege_required`, and open each `[disposition]` with the model field that
  backs it. It unlocks three further dispositions — `out_of_model_adversary`, `out_of_model_component`,
  `out_of_model_non_default_build` — each requiring that citation. Two limits: a rule-out resting **only** on
  a `provenance: "inferred"` claim is `model_gap`, not a clearance, and a sink whose entry point is **missing
  from the table** is `model_gap` too. The model is a contract to argue with, never a filter that makes a
  sink safe.
distinction, the per-library cutoffs, and the binding checks (`aud`/`iss`/purpose/tenant) that outlive every CVE.

`WEB_AUTH.md` carries the **federated-identity and deep-binding** surface (OAuth/OIDC callback binding,
SAML signed-object binding, JWT `kid`/`jku`/`aud`/`iss`, session fixation/invalidation, MFA step-up &
enrollment assurance, WebAuthn/passkey, account linking, API-key scope, mTLS identity). Cover it in
addition to the base machinery below when the app has any of those flows.

## Phase 1 — Recon

From `recon/architecture.md` (`security_mechanisms.auth`) locate the auth code: login handler, session
middleware, token issuance/verification, password storage, reset flows, MFA. List each with `file:line`.

## Phase 2 — Trace / review

Examine each control and gather the evidence (`file:line` + snippet):
- **Password storage**: hashing algorithm — bcrypt/argon2/scrypt/PBKDF2 (good) vs MD5/SHA-1/SHA-256
  fast-hash/plaintext (bad); salting; work factor.
- **Credential comparison**: constant-time compare vs `==`/`.equals` (timing oracle).
- **Session tokens**: generated with a CSPRNG (good) vs `Math.random`/predictable; rotation on login;
  fixation; cookie flags (HttpOnly/Secure/SameSite) — cross-ref config-auditor.
- **JWT**: `alg:none` accepted; algorithm-confusion (HS/RS); signature actually verified; `exp`/`nbf`
  checked; secret strength; `kid` injection.
- **Password reset**: token entropy (CSPRNG), single-use, expiry, not leaked in response; host-header
  poisoning in reset link.
- **MFA**: enforced server-side (not just UI), no bypass route, TOTP replay window.
- **Account enumeration**: differential responses/timing between "user exists" and "wrong password".
- **Brute-force**: presence of rate limiting / lockout on auth endpoints.
- **Token ≠ authentication**: a `Model.objects.get(token=…)` / API-key lookup only authenticates if the
  token is bound to a principal and is not self-issued, enumerable, or embedded in client-reachable
  responses/pages. Verify how it is minted before treating a token-gated endpoint as authenticated
  (coordinate with access-control-auditor, which owns the authz consequence).

## Phase 3 — Verdict

For each control, verdict `vulnerable`/`safe` with the concrete reason from the code (e.g. "passwords
hashed with unsalted SHA-1 at users.service.ts:88", "JWT verified with `algorithms` unset → `alg:none`
accepted at auth/jwt.ts:40"). Map to OWASP A07 (or A02 for crypto-storage issues). Score confidence and
reachability. Avoid false positives: a fast hash used for a non-credential digest is not a password-
storage flaw; verify the value is actually a credential.

**Hybrid only**: corroborate enumeration/timing or `alg:none` acceptance against `target_url` with benign
probes if useful.

## Phase 4 — Emit

Write findings per the contract; record safe controls to `findings/_safe-auth.md`; append to
`activity/auth-auditor.log`. Use `finding-auth-NNN` ids. **Before writing, scan existing `finding-auth-*` dirs first and continue from
the highest free `NNN`** — a re-dispatched pass (Step 6.5.2) must never renumber from `001` and overwrite
the first pass's finding dirs.

## Completion

Announce **AUTH AUDIT COMPLETE** with counts and stop.
