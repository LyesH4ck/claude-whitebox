# Infrastructure and CI as code — Terraform · Dockerfile · Kubernetes · GitHub Actions

Load when the repository carries **any** of: `*.tf` / `*.tf.json` / `*.hcl`, a `Dockerfile*`, Kubernetes
manifests (`kind:` YAML, Helm `templates/`, Kustomize), `.github/workflows/*.yml` or composite actions. It is
**additive** — it loads alongside the language file, like `graphql.md` and `jwt.md` — and it is owned by three
auditors: **config** (misconfiguration, public exposure, root containers, workflow injection), **secrets**
(plaintext secrets in manifests, data blocks and workflow logs) and **deps** (unpinned modules, actions and
base images — supply chain). The planner routes these files to those three; nothing else grep-scans them.

Resolve "versions" from what is pinned: `.terraform.lock.hcl` (providers), the module `source` ref, the
`uses:` ref of an action, the `FROM` digest. A floating ref is not a version. The binding rule in `README.md`
applies: an unresolvable pin is a `coverage_gaps` entry, never a clearance.

---

## Version facts to check

**Terraform `aws_s3_bucket` — encryption at rest is on by default since 2023-01-05.** Every new bucket gets
SSE-S3 (AES-256) automatically; an `aws_s3_bucket` with no `server_side_encryption_configuration` is **not**
an unencrypted bucket. It is a finding only when the policy requires a KMS key (`aws:kms`) or when a
`bucket_key_enabled`/`kms_master_key_id` requirement is documented and absent.
Source: <https://aws.amazon.com/about-aws/whats-new/2023/01/amazon-s3-automatically-enable-encryption-new-objects/>
→ `aws_db_instance`, `aws_rds_cluster`, `aws_ebs_volume`, `aws_dynamodb_table`, `aws_sqs_queue`,
`aws_sns_topic`, `aws_elasticache_replication_group` have **no** such default — `storage_encrypted = true` /
`encrypted = true` / `server_side_encryption { enabled = true }` / `kms_master_key_id` / `at_rest_encryption_enabled`
must be present, or the resource is unencrypted at rest (`medium`; `high` when it holds credentials or PII).

**GitHub Actions — `pull_request_target` runs with the *base* repository's secrets and write token.** A
workflow on that trigger that **checks out the PR head** (`ref: ${{ github.event.pull_request.head.sha }}`,
`head_ref`) and then builds, installs or runs anything from it executes attacker code with those secrets.
Source: <https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/>
→ `pull_request` (no `_target`) on a fork gets a read-only token and no secrets: the same checkout there is
not the finding. `workflow_run` chained after a PR workflow inherits the same trust confusion — read the
artifact handling.

**GitHub Actions — expression injection into `run:`.** `${{ github.event.pull_request.title }}`,
`.body`, `.head.ref`, `github.head_ref`, `issue.title`, `comment.body`, `head_commit.message` interpolated
inside a `run:` script are shell-injected by whoever controls that field — a branch name or a PR title.
Source: <https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions#understanding-the-risk-of-script-injections>
→ The safe shape passes the value through `env:` and reads `"$VAR"` in the script. An expression inside
`with:` of a trusted action is not shell-injected (the action receives it as data) — do not report that
unless the action itself shells it out.

**Kubernetes `Secret` objects are base64, not encrypted.** `stringData:` / `data:` in a committed manifest is
a plaintext credential in git. Encryption at rest is a cluster setting (`EncryptionConfiguration`), not
something the manifest can assert.
→ A `secretKeyRef` / `secretName` **reference** is the correct shape (the value lives elsewhere) and is not a
finding; an `ExternalSecret`, a Vault injector annotation or a sealed-secret CRD is a design property.

---

## Framework defaults

**Docker runs as root unless told otherwise.** A final stage with no `USER` directive, or `USER root`, runs the
entrypoint as uid 0; a container escape or a write to a mounted volume is then root on the host side of the
mount. The finding needs the final stage — an intermediate build stage as root is normal.

**`FROM image:tag` is mutable; `FROM image@sha256:…` is not.** A tag (`latest`, `3.12`, `v1`) can be
re-pointed by the registry owner; `node:20-alpine` today is not `node:20-alpine` next week. Supply-chain
finding (`low` for a well-known base, `medium` for a third-party image), `informational` when the project
pins elsewhere (a Renovate/Dependabot digest-pin policy) — cite it.

**`RUN curl … | sh` / `wget … | bash` / `curl … | tar` with no checksum.** The install script is whatever the
URL serves at build time; TLS proves the host, not the content. Safe only with a `sha256sum -c` /
`--checksum` / signature verification before execution. Same for `pip install` from a raw URL.

**Terraform IAM — wildcards compose.** `actions = ["*"]` **and** `resources = ["*"]` in one statement is
admin; `Principal: "*"` / `"AWS": "*"` in a trust or bucket policy with no `Condition` is public. One
wildcard alone can be intentional (`s3:*` on one bucket; `resources = ["*"]` for a `Describe*` read) — the
pair, or a wildcard on a mutating action, is the finding.

**Terraform ingress — `0.0.0.0/0` / `::/0`.** On 80/443 for a public load balancer it is the design. On SSH
(22), RDP (3389), databases (3306, 5432, 6379, 27017, 9200), Kubernetes API (`endpoint_public_access = true`
without `endpoint_public_access_cidrs`) it is public exposure of an administrative surface.

**Terraform module and provider sources float unless pinned.** `source = "github.com/org/mod"` or
`git::…` with no `?ref=<sha>` (a tag is better than nothing, a branch is nothing) resolves to the branch tip at
apply time; a registry source with no `version = "…"` likewise. `.terraform.lock.hcl` pins providers — its
absence from the repo means provider versions are unresolvable.

**GitHub Actions — `uses: owner/action@v4` is a mutable tag.** Only a full commit SHA is immutable. Pinning
by major tag is the ecosystem's norm and is `informational` for first-party and widely-audited actions
(`actions/checkout`), `low`–`medium` for third-party actions with secrets in scope. `permissions: write-all`
or an absent `permissions:` block (default write on older repos) widens whatever an injection reaches;
`id-token: write` turns a compromised job into a cloud OIDC identity.

---

## Dangerous patterns

- `pull_request_target` + checkout of `head.sha`/`head_ref` + any build/install/test step.
- `run:` block containing `${{ github.event.* }}` / `${{ github.head_ref }}` / `${{ inputs.* }}` from a
  `workflow_dispatch` an untrusted collaborator can trigger.
- `secrets.*` echoed, written to an artifact, or passed to a third-party action pinned by tag.
- Terraform: `kubernetes_secret` with literal `data`/`stringData` values; `aws_iam_policy_document` with
  `actions = ["*"]`; `aws_security_group` ingress `0.0.0.0/0` on a sensitive port; `aws_eks_cluster`
  `endpoint_public_access = true` without CIDRs; `publicly_accessible = true` on `aws_db_instance`;
  `acl = "public-read"` / `block_public_acls = false` on S3.
- Kubernetes: `stringData:` / long base64 `value:` in a committed manifest; `privileged: true`,
  `hostNetwork: true`, `hostPID: true`, `allowPrivilegeEscalation: true`, `runAsUser: 0`; a `Secret` mounted
  into a pod that also runs user code; an `initContainer` decryption pipeline whose decrypted volume outlives
  the init step.
- Dockerfile: no `USER` in the final stage; `FROM …:latest`; `ADD http://…`; `curl | sh`; `--privileged`
  hints in compose; secrets passed as `ARG`/`ENV` (they persist in image layers — use `--mount=type=secret`).

---

## Safe or non-reportable forms

- `aws_s3_bucket` with no encryption block on a provider dated after 2023-01 — encrypted by default (see
  above); report only a documented KMS requirement.
- `resources = ["*"]` on read-only `Describe*`/`List*`/`Get*` actions scoped by a `Condition` — usually
  intentional; cite the condition.
- `0.0.0.0/0` on 80/443 of a resource whose name/tags say load balancer or CDN origin.
- `pull_request` (not `_target`) workflows checking out the PR — read-only token, no secrets on forks.
- `uses: actions/checkout@v4`, `actions/setup-node@v4` by major tag — note as informational supply-chain
  hygiene, not a finding, unless secrets flow into a *third-party* tag-pinned action.
- `secretKeyRef` / `secretName` / `envFrom.secretRef` — references, not values.
- A `USER root` **followed** by a later `USER app` in the same final stage — the last directive wins.
- `${{ secrets.X }}` passed via `env:` into a `run:` that uses `"$X"` — not shell-injected; the secret in the
  job log is a separate (masking) question.

---

## Commands

```bash
# what IaC/CI surface exists
rg -l --glob '*.tf' --glob '*.tf.json' --glob '*.hcl' -n '' ; ls .terraform.lock.hcl 2>/dev/null
fd -g 'Dockerfile*' ; rg -l '^kind:\s' --glob '*.y*ml' ; ls .github/workflows 2>/dev/null

# Terraform
rg -n 'actions\s*=\s*\[\s*"\*"|"Action"\s*:\s*"\*"|resources\s*=\s*\[\s*"\*"|"Principal"\s*:\s*"\*"|"AWS"\s*:\s*"\*"|identifiers\s*=\s*\[\s*"\*"' --glob '*.tf' --glob '*.tf.json'
rg -n 'cidr_blocks\s*=\s*\[\s*"0\.0\.0\.0/0"|::/0|endpoint_public_access\s*=\s*true|publicly_accessible\s*=\s*true|acl\s*=\s*"public' --glob '*.tf'
rg -n -A12 'resource\s+"aws_(db_instance|rds_cluster|ebs_volume|dynamodb_table|sqs_queue|sns_topic|elasticache_replication_group)"' --glob '*.tf' | rg -v 'encrypt|kms'
rg -n 'resource\s+"kubernetes_secret' --glob '*.tf' ; rg -n 'source\s*=\s*"(git::|github\.com|https?://)' --glob '*.tf' | rg -v 'ref=[0-9a-f]{7,40}'

# Dockerfile
rg -n '^\s*FROM\s' --glob 'Dockerfile*' | rg -v '@sha256:'
rg -n '^\s*USER\s' --glob 'Dockerfile*'                      # absent in the final stage = root
rg -n '^\s*RUN\s.*(curl|wget).*\|\s*(sh|bash|tar)' --glob 'Dockerfile*' | rg -v 'sha256sum|--checksum|gpg'
rg -n '^\s*(ARG|ENV)\s+\w*(SECRET|TOKEN|PASSWORD|KEY)' --glob 'Dockerfile*'

# Kubernetes
rg -n '^\s*stringData\s*:|^\s*value\s*:\s*["'"'"']?[A-Za-z0-9+/=_-]{24,}' --glob '*.y*ml' --glob '!**/charts/**'
rg -n 'privileged:\s*true|hostNetwork:\s*true|hostPID:\s*true|allowPrivilegeEscalation:\s*true|runAsUser:\s*0' --glob '*.y*ml'

# GitHub Actions
rg -n 'pull_request_target|workflow_run' .github/workflows
rg -n 'ref:\s*\$\{\{\s*github\.event\.pull_request\.head' .github/workflows
rg -n '\$\{\{\s*github\.(event\.(pull_request|issue|comment|review|head_commit)\.|head_ref)' .github/workflows
rg -n 'uses:\s*[\w-]+/[\w./-]+@(main|master|develop|v?\d+)\s*$' .github/workflows
rg -n 'permissions:\s*write-all|id-token:\s*write' .github/workflows
```
