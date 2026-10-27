# Ecosystem References — framework defaults, version cutoffs, and non-findings

`SINK_CATALOG.md` tells you **what a dangerous sink looks like** in any language. These files tell you
**what it means in this stack, at this version**. They exist because the two most expensive audit errors are
version-shaped:

- **False positive** — reporting `lodash.merge` as prototype pollution on a pinned 4.17.21, or `jwt.verify`
  as `alg:none` on `jsonwebtoken@9`. The pattern matched; the vulnerability was fixed years ago.
- **False negative** — clearing `spawn(bin, [arg])` as "argv form, safe" on a Windows deployment running
  Node 18.20.0, where `.bat`/`.cmd` resolution reopens shell parsing (BatBadBut).

Neither is decidable from the sink line alone. Both are decidable from the lockfile.

## The version-sensitivity rule (binding on every auditor)

> **Every version-sensitive claim must name the installed version and the cutoff it was compared against.**
> Read the version from the **lockfile** (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `poetry.lock`,
> `requirements.txt` with pins, `composer.lock`, `Gemfile.lock`, `go.sum`, `packages.lock.json`), not from the
> manifest range and never from memory. If the installed version cannot be resolved, **do not guess**: record a
> `coverage_gaps` entry naming the package and the unresolved question. An unresolved version is a gap, never a
> finding and never a clearance.

Write the comparison into the finding's `description.md` explicitly:
`jsonwebtoken 8.5.1 (package-lock.json:3312) < 9.0.0 cutoff; verify() called without algorithms at auth/jwt.ts:41`.

## These facts are dated, not eternal

Every **advisory-based** entry under `## Version facts to check` carries a source URL; entries that state a
language or library *semantic* instead (Psych 4 made `YAML.load` safe, `text/template` never escapes, PHP 7
removed `preg_replace /e`, `Path.Combine` discards the root on an absolute second argument) are verifiable
from the official docs and carry none. All of them were verified on **2026-10-10**.
A fact here is a **starting point that tells you which question to ask** — it is not a substitute for the
advisory. Before using one to *clear* a finding (the dangerous direction), open the source URL and confirm
the cutoff still reads the way it does here. Before using one to *condemn*, confirm the **precondition**:
almost every entry below is conditional, and the version alone is not the vulnerability.

## Routing

| Load | When |
|---|---|
| `node.md` | `package.json` present — Express, Fastify, Koa, Hono, NestJS, Next.js, tRPC, React/Vue/Angular, Prisma/Sequelize/Mongoose |
| `python.md` | `requirements.txt` / `pyproject.toml` / `Pipfile` — Django, DRF, Flask, FastAPI, SQLAlchemy, Jinja2 |
| `php.md` | `composer.json` — Laravel, Symfony, Twig, Blade, Doctrine, Eloquent, WordPress |
| `ruby.md` | `Gemfile` — Rails, Sinatra, ActiveRecord, ERB, Pundit, CanCanCan |
| `java-jvm.md` | `pom.xml` / `build.gradle` — Spring (MVC/Boot/Security/WebFlux), Jakarta, Jackson, Hibernate, Thymeleaf |
| `go.md` | `go.mod` — net/http, chi, Gin, Echo, Fiber, database/sql, html/template, gorilla |
| `dotnet.md` | `*.csproj` / `*.sln` — ASP.NET Core, ASP.NET Framework, EF Core, Razor, Newtonsoft.Json |
| `graphql.md` | **any** GraphQL schema, resolver, SDL, or client — additive, load alongside the language file |
| `jwt.md` | **any** JWT/JWS/JWE header or claim that influences a principal, tenant, role, scope, or resource decision — additive |
| `iac.md` | **any** `*.tf`/`*.hcl`, `Dockerfile*`, Kubernetes manifest or `.github/workflows/*.yml` — additive; owned by the config, secrets and deps auditors |
| `other.md` | a language or runtime with no file above — Rust, Elixir, Swift, Dart, Lua, Clojure, Erlang, Crystal, Apex, Android/iOS, serverless handlers. **Threat highlights only, no version cutoffs**: recon routes here *and* records the stack under `uncovered_relevant_categories` |

**Polyglot repositories load several.** A Next.js front end against a Spring API loads `node.md` *and*
`java-jvm.md`; the interesting bugs live at the seam (what the front end guarantees vs what the API assumes —
see the cross-component diff in `SKILL.md`).

## How to use the four sections

1. **`## Version facts to check`** — resolve the installed version first, then read only the rows that apply.
2. **`## Framework defaults`** — what the framework does *for free*. This decides most XSS and authz verdicts:
   auto-escaping scope, middleware ordering semantics, ORM parameterization, guard inheritance. A default is a
   **real defense** — treat it as one — but read its exact scope: React escapes HTML text and **not** `href`,
   inline handlers, or prop spreads.
3. **`## Safe or non-reportable forms`** — the explicit non-finding list. Before writing a finding, check it
   here. If your candidate matches a row, it is `tested_not_vulnerable`, not a finding. Adding to this list as
   you learn the stack is encouraged; it is the cheapest false-positive control in the plugin.
4. **`## Commands`** — `rg` seeds. They locate candidates; they never produce verdicts. Every hit still runs the
   full source→sink verdict process from `SKILL.md`.

## What does not belong here

Generic OWASP prose, payload lists (those live in `plugins/pentest/skills/pentest/attacks/**`), and
language-agnostic sink taxonomy (`SINK_CATALOG.md`). A line belongs in these files only if it is
**specific to this ecosystem and actionable at verdict time**.
