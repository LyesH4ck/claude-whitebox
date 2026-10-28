#!/usr/bin/env node
// Preflight for a codeaudit run. Deterministic, zero-dependency, no model tokens.
//
//   node "$CA/preflight.mjs"                 # integrity of the plugin itself
//   node "$CA/preflight.mjs" --repo .        # + is the target in this directory auditable
//   node "$CA/preflight.mjs" --repo . --json
//
// Run it from anywhere, including from inside the repository you are about to audit — that is the supported
// shape. --cwd lets you ask "would an audit launched over there still resolve its methodology?".
//
// Why this exists: the plugin is markdown. The test suite covers the JS (judge, handoff, manifest) and
// asserts nothing about the prompts that ARE the product. Every failure mode this catches is silent at run
// time — an agent whose mount path does not resolve proceeds without its methodology and still writes a
// confident report, so the audit looks successful and is not.
//
// Exit: 0 clean · 1 warnings only · 2 at least one blocking problem.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const PLUGIN = path.dirname(fileURLToPath(import.meta.url));
const MARKET = path.resolve(PLUGIN, '../..');          // repo root holding .claude-plugin/
const REF = path.join(PLUGIN, 'skills/code-audit/reference');

const problems = [];
const add = (level, check, msg, hint) => problems.push({ level, check, msg, hint });
const blocking = (c, m, h) => add('BLOCK', c, m, h);
const warn = (c, m, h) => add('WARN', c, m, h);

const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
const mdFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => path.join(dir, f)) : []);
const agentFiles = () => mdFiles(path.join(PLUGIN, 'agents'));
const allPluginMd = () => [
  ...agentFiles(), ...mdFiles(path.join(PLUGIN, 'commands')), ...mdFiles(path.join(PLUGIN, 'docs')),
  path.join(PLUGIN, 'skills/code-audit/SKILL.md'), ...mdFiles(REF), ...mdFiles(path.join(REF, 'ecosystems')),
].filter(existsSync);

// ───────────────────────────────────────────────────────────── integrity

/**
 * Mount resolution. codeaudit is installed as a copy under ~/.claude/plugins/cache, while an audit runs in
 * whatever directory holds the target code — so a repo-relative `Read plugins/codeaudit/...` only worked by
 * the accident of the session's working directory, and failed SILENTLY everywhere else (the agent proceeds
 * with no methodology and still writes a confident report). Agents now resolve a root and read `$CA/...`.
 * This checks the three things that can break that: a relative path creeping back, a resolver that is
 * missing or unsafe, and a `$CA/` path that does not exist inside the plugin.
 */
function checkMounts(cwd) {
  let paths = 0;
  for (const f of allPluginMd()) {
    const body = read(f);
    const base = path.basename(f);

    // 1. a bare repo-relative mount is a regression, not a style issue
    for (const m of body.matchAll(/^\s*Read\s+(plugins\/[^\s#]+)/gm)) {
      blocking('mounts', `${base} mounts "${m[1]}" — a path relative to the working directory`,
        `codeaudit runs as an installed copy and the audit runs in the target repo, so this resolves only ` +
        `by accident of where the session happens to be. Use the resolved $CA/ form.`);
    }

    // 2. $CA/ and $PT/ targets must exist inside the plugin
    for (const m of body.matchAll(/^\s*Read\s+\$CA\/([^\s#]+)/gm)) {
      paths++;
      if (!existsSync(path.join(PLUGIN, m[1]))) {
        blocking('mounts', `${base} mounts $CA/${m[1]}, which does not exist in the plugin`, 'Fix the path.');
      }
    }

    // 3. an agent that reads $CA must define it, and must abort when resolution fails
    if (/^\s*Read\s+\$(CA|PT)\//m.test(body)) {
      if (!/CLAUDE_PLUGIN_ROOT/.test(body)) {
        blocking('mounts', `${base} reads $CA/ but never resolves it`, 'Add the plugin-root resolver block.');
      } else {
        // EVERY cache glob must be version-sorted, not just one of them: the resolver globs twice (the
        // codeaudit root and the pentest catalog) and a single sorted line is not evidence about the other.
        for (const g of body.match(/^.*ls -d ~\/\.claude\/plugins\/cache\/.*$/gm) || []) {
          if (!/sort -V/.test(g)) {
            blocking('mounts', `${base} globs the plugin cache without \`sort -V\`: ${g.trim().slice(0, 90)}`,
              `The cache keeps every installed version side by side (0.2.1 and 0.9.0 both exist here), so ` +
              `an unsorted glob picks an arbitrary one — silently auditing with an old methodology.`);
          }
        }
        if (!/CODEAUDIT-ROOT-NOT-FOUND/.test(body)) {
          blocking('mounts', `${base} resolves a root but never checks it was found`,
            `Without an explicit abort the agent proceeds with no methodology and still reports.`);
        }
      }
    }
  }

  // 4. exercise the resolver for real, from a directory that is not the checkout
  try {
    const script = `CA="\${CLAUDE_PLUGIN_ROOT:-}"
[ -f "$CA/skills/code-audit/SKILL.md" ] || CA="$(ls -d ~/.claude/plugins/cache/*/codeaudit/*/ 2>/dev/null | sort -V | tail -1)"
CA="\${CA%/}"; [ -f "$CA/skills/code-audit/SKILL.md" ] || CA="plugins/codeaudit"
test -f "$CA/skills/code-audit/SKILL.md" && echo "$CA" || echo "CODEAUDIT-ROOT-NOT-FOUND"`;
    const out = execFileSync('bash', ['-c', script], { cwd, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: '' } }).trim();
    if (out === 'CODEAUDIT-ROOT-NOT-FOUND') {
      blocking('mounts', `the plugin-root resolver finds nothing from ${cwd}`,
        `With no CLAUDE_PLUGIN_ROOT and no installed copy under ~/.claude/plugins/cache, agents launched ` +
        `from outside the checkout have no methodology. Install the plugin, or launch from the marketplace.`);
    } else if (!existsSync(path.join(out, 'skills/code-audit/SKILL.md'))) {
      blocking('mounts', `the resolver returned "${out}", which has no SKILL.md`, '');
    } else {
      const installed = read(path.join(out, '.claude-plugin/plugin.json'));
      const local = read(path.join(PLUGIN, '.claude-plugin/plugin.json'));
      const vOf = (b) => (/"version":\s*"([^"]+)"/.exec(b) || [])[1];
      if (vOf(installed) && vOf(local) && vOf(installed) !== vOf(local)) {
        warn('mounts', `agents would resolve to version ${vOf(installed)} (${out}), but this checkout is ${vOf(local)}`,
          `Run /plugin marketplace update then /reload-plugins, or the audit uses the older copy.`);
      }
    }
  } catch (e) {
    warn('mounts', `could not exercise the plugin-root resolver: ${e.message}`, '');
  }
  return paths;
}

/** Every agent the orchestrator dispatches must exist, with a frontmatter name that matches. */
function checkAgents() {
  const declared = new Map();
  for (const f of agentFiles()) {
    const m = /^---\n([\s\S]*?)\n---/.exec(read(f));
    if (!m) { blocking('agents', `${path.basename(f)} has no YAML frontmatter`, 'Claude Code will not load it.'); continue; }
    const name = (/^name:\s*(\S+)/m.exec(m[1]) || [])[1];
    if (!name) blocking('agents', `${path.basename(f)} frontmatter has no name:`, '');
    else {
      if (name !== path.basename(f, '.md')) {
        warn('agents', `${path.basename(f)} declares name: ${name}`, 'Filename and name usually match; check the dispatcher uses the right one.');
      }
      declared.set(name, f);
    }
    if (!/^tools:/m.test(m[1])) warn('agents', `${path.basename(f)} declares no tools:`, 'It inherits a default tool set.');
  }
  const cmd = read(path.join(PLUGIN, 'commands/codeaudit.md'));
  for (const m of cmd.matchAll(/\*\*([a-z][a-z0-9-]+)\*\* agent via `Task`|Dispatch the \*\*([a-z][a-z0-9-]+)\*\*/g)) {
    const n = m[1] || m[2];
    if (n && !declared.has(n)) {
      blocking('agents', `commands/codeaudit.md dispatches "${n}", which no agent declares`,
        `Known: ${[...declared.keys()].sort().join(', ')}`);
    }
  }
  return declared.size;
}

/** Enum drift between the files that declare a vocabulary and the files that use it. */
function checkEnums() {
  const contract = read(path.join(REF, 'REPORT_CONTRACT.md'));
  const corpus = allPluginMd().map(read).join('\n');

  const DISPOSITIONS = ['guard_present', 'not_attacker_controlled', 'not_reachable', 'by_design',
    'precondition_subsumes', 'model_gap', 'out_of_model_adversary', 'out_of_model_component',
    'out_of_model_non_default_build'];
  for (const d of DISPOSITIONS) {
    if (!contract.includes(d)) blocking('enums', `disposition "${d}" is used but REPORT_CONTRACT.md never defines it`, '');
  }
  for (const m of corpus.matchAll(/\b(out_of_model_[a-z_]+|precondition_subsumes|guard_present|not_attacker_controlled|model_gap)\b/g)) {
    if (!DISPOSITIONS.includes(m[1])) {
      blocking('enums', `disposition "${m[1]}" appears in the plugin but is not in the contract's closed enum`,
        `An auditor emitting it produces an entry the aggregator cannot classify.`);
    }
  }

  const PRIV = ['none', 'authenticated', 'admin', 'maintainer', 'local-root'];
  for (const p of PRIV) {
    if (!contract.includes(`\`${p}\``)) warn('enums', `privilege_required value "${p}" not found verbatim in the contract`, '');
  }

  // ecosystem routing keys must equal the files that exist
  const ecoDir = path.join(REF, 'ecosystems');
  const onDisk = mdFiles(ecoDir).map((f) => path.basename(f, '.md')).filter((n) => n !== 'README').sort();
  const recon = read(path.join(PLUGIN, 'agents/code-recon.md'));
  const em = /`key` must be one of `([^`]+)`/s.exec(recon.replace(/\n\s+/g, ' '));
  if (!em) warn('enums', 'code-recon declares no ecosystem key enum', 'Routing becomes inferred rather than mechanical.');
  else {
    const keys = em[1].split('|').map((k) => k.trim()).filter(Boolean).sort();
    const missing = onDisk.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !onDisk.includes(k));
    if (missing.length) blocking('enums', `ecosystems/${missing.join(', ')}.md exist but code-recon's key enum omits them`,
      'Recon will never route an auditor to those files.');
    if (extra.length) blocking('enums', `code-recon's key enum lists ${extra.join(', ')} with no matching ecosystems/*.md`,
      'An auditor told to load a non-existent file loses that routing silently.');
  }
  return onDisk.length;
}

/** The four _safe-file headings are a parsing contract; they must be byte-identical everywhere. */
function checkSafeFileContract() {
  const H = ['tested_not_vulnerable', 'design_properties', 'unverified_assumptions', 'coverage_gaps'];
  const sources = {
    'OUTPUT_STRUCTURE.md': read(path.join(REF, 'OUTPUT_STRUCTURE.md')),
    'commands/codeaudit.md': read(path.join(PLUGIN, 'commands/codeaudit.md')),
    'an auditor agent': read(path.join(PLUGIN, 'agents/injection-auditor.md')),
  };
  for (const [where, body] of Object.entries(sources)) {
    const missing = H.filter((h) => !body.includes(h));
    if (missing.length) {
      blocking('safe-file', `${where} does not mention ${missing.join(', ')}`,
        `The aggregator splits _safe-{class}.md on these four headings. A file that omits one loses that ` +
        `whole evidence category silently — empty reads as "nothing to report", not as "never written".`);
    }
  }
  return H.length;
}

/**
 * The skipped register. Every auditor must end its status with `SKIPPED: none|<n>` and write skipped paths
 * as `[skipped]` lines the aggregator parses. An agent that lost the instruction does not fail — it reports
 * `complete` over a file it never read, and the report prints "all in-scope sources traced" above it. The
 * three pieces (agent prompt, methodology, parser) must agree, so each is checked.
 */
function checkSkippedRegister() {
  let checked = 0;
  const agents = agentFiles().filter((f) => /-auditor\.md$|adversarial-sweep\.md$|finding-verifier\.md$/.test(f));
  for (const f of agents) {
    checked++;
    if (!/SKIPPED:\s*none/.test(read(f))) {
      blocking('skipped-register', `${path.basename(f)} never asks for the skipped register (SKIPPED: none|<n>)`,
        'An auditor that is not asked whether it skipped a file answers nothing, and nothing reads as "all traced".');
    }
  }
  const skill = read(path.join(PLUGIN, 'skills/code-audit/SKILL.md'));
  if (!/###\s+The skipped register/.test(skill)) blocking('skipped-register', 'SKILL.md has no "The skipped register" section', 'Agents point at it by name.');
  const agg = read(path.join(PLUGIN, 'tools/aggregate.py'));
  if (!agg.includes('[skipped]')) blocking('skipped-register', 'tools/aggregate.py does not parse `[skipped]` lines', 'Registers would be written and never surfaced.');
  return checked;
}

/** Cross-file pointers: reference/X.md and "→ *Section*" must resolve. */
function checkPointers() {
  const refNames = new Set(mdFiles(REF).map((f) => path.basename(f)));
  let checked = 0;
  for (const f of allPluginMd()) {
    const body = read(f);
    for (const m of body.matchAll(/`?reference\/([A-Z_]+\.md)`?/g)) {
      checked++;
      if (!refNames.has(m[1])) blocking('pointers', `${path.basename(f)} points at reference/${m[1]}, which does not exist`, '');
    }
  }
  // Named-section pointers. Only the explicit `X.md` → *Section* form is checked: a bare trailing phrase is
  // prose, and treating it as a pointer produced nothing but noise. Bold labels count as targets because
  // several reference files use `**Attack class**` rather than a heading for their sub-sections.
  const targets = new Map();
  for (const f of allPluginMd()) {
    const body = read(f);
    targets.set(path.basename(f), [
      ...[...body.matchAll(/^#{2,4}\s+(.+?)\s*$/gm)].map((m) => m[1]),
      ...[...body.matchAll(/^\*\*(.+?)\*\*\s*$/gm)].map((m) => m[1]),
    ].map((h) => h.toLowerCase().replace(/[`*]/g, '').trim()));
  }
  for (const f of allPluginMd()) {
    for (const m of read(f).matchAll(/`([A-Za-z_]+\.md)`\s*→\s*\*([^*\n]{4,70})\*/g)) {
      checked++;
      const target = targets.get(m[1]);
      if (!target) continue;
      const want = m[2].trim().toLowerCase().replace(/[`]/g, '').replace(/^the\s+/, '');
      if (!target.some((h) => h.includes(want) || want.includes(h))) {
        warn('pointers', `${path.basename(f)} points at ${m[1]} → "${m[2].trim()}", no matching section found`,
          `Sections in ${m[1]}: the agent will read the file but may not find what it was sent for.`);
      }
    }
  }
  return checked;
}

/** Every outputs/ artifact the orchestrator reads must have something that writes it. */
function checkArtifacts() {
  const corpus = allPluginMd().map((f) => [path.basename(f), read(f)]);
  const referenced = new Set();
  for (const [, body] of corpus) {
    for (const m of body.matchAll(/outputs\/\{engagement\}\/([A-Za-z0-9_\-./{}]+\.(?:json|md))/g)) referenced.add(m[1]);
  }
  // A producer is a file that mentions the artifact within ~300 chars of a write verb. The earlier
  // line-anchored regex flagged every artifact in the plugin, including ones with an obvious producer —
  // a preflight whose warnings are mostly its own false positives trains the operator to ignore it.
  const VERB = /\b(write|writes|writing|wrote|emit|emits|produce|produces|output|outputs|deliverable)\b/i;
  for (const art of referenced) {
    // Search on the stable prefix BEFORE any {placeholder}: '_safe-sweep-{mode}.md' must be looked up as
    // '_safe-sweep-', not as '_safe-sweep-.md', which appears nowhere and flags its own producer.
    const full = path.basename(art);
    const base = full.includes('{') ? full.slice(0, full.indexOf('{')) : full;
    if (!base || base.length < 4) continue;
    const produced = corpus.some(([n, b]) => {
      if (n === 'WORKFLOWS.md' || n === 'README.md') return false;       // docs describe, they do not produce
      let i = b.indexOf(base);
      while (i !== -1) {
        if (VERB.test(b.slice(Math.max(0, i - 300), i + 300))) return true;
        i = b.indexOf(base, i + 1);
      }
      return false;
    });
    if (!produced) {
      warn('artifacts', `outputs/{engagement}/${art} is read but nothing describes producing it`,
        'Either the producing step is missing, or its wording never says write/emit/produce near the path.');
    }
  }
  return referenced.size;
}

// ───────────────────────────────────────────────────────────── tools

/**
 * Steps 6.5 and 6.6 lean on three shipped Python tools (reconcile / aggregate / render). The command file
 * invokes them by path, so a missing file or a missing interpreter turns the mechanical half of the audit
 * back into prose — reconciliation by eye over hundreds of sources, hand-written reports that drop the
 * evidence sections. Blocking when a tool the command references is absent; warning when python3 is.
 */
const TOOLS = ['reconcile.py', 'aggregate.py', 'render.py', 'context.py', 'recon-coverage.py', 'resume.py', 'diff-scope.py'];
function checkTools() {
  // every command may invoke a tool (codeaudit.md owns most; codeaudit-diff.md owns diff-scope.py)
  const cmd = mdFiles(path.join(PLUGIN, 'commands')).map(read).join('\n');
  let present = 0;
  for (const t of TOOLS) {
    const p = path.join(PLUGIN, 'tools', t);
    if (!existsSync(p)) {
      blocking('tools', `tools/${t} is missing`, 'commands/codeaudit.md invokes it; without it the step degrades to prose.');
      continue;
    }
    present += 1;
    if (!cmd.includes(`tools/${t}`)) warn('tools', `tools/${t} ships but no command file invokes it`, 'Wire it into a command step or delete it.');
  }
  try { execFileSync('python3', ['-c', 'import sys; assert sys.version_info >= (3, 8)'], { stdio: 'ignore' }); }
  catch { warn('tools', 'python3 (>= 3.8) not found on PATH', 'reconcile/aggregate/render will not run; the orchestrator must do those steps by hand.'); }
  return present;
}

// ───────────────────────────────────────────────────────────── scanners

/**
 * Optional scanners the deps / secrets / config auditors prefer when present. The command probes these at
 * Step 4, but an orchestrator driving the pipeline by hand skips steps — and a brief that says
 * `tools_available: none` when gitleaks is installed makes an auditor record a coverage gap that is simply
 * false (seen on a real engagement: the secrets sweep ran pattern-only and declared "no real scanner
 * installed" while gitleaks, trufflehog, osv-scanner, trivy and semgrep were all on PATH). Reporting them
 * here means the one command every run starts with cannot leave that unsaid.
 */
const SCANNERS = {
  gitleaks: 'secrets', trufflehog: 'secrets',
  'osv-scanner': 'deps', 'pip-audit': 'deps', govulncheck: 'deps', trivy: 'deps + config (IaC)',
  pandoc: 'the optional PDF deliverable',
};

function checkScanners() {
  const found = {};
  for (const [bin, who] of Object.entries(SCANNERS)) {
    try { execFileSync('command', ['-v', bin], { stdio: 'ignore', shell: true }); found[bin] = who; }
    catch { /* absent */ }
  }
  const absent = Object.keys(SCANNERS).filter((b) => !(b in found));
  if (!found.gitleaks && !found.trufflehog) {
    warn('scanners', 'no secret scanner on PATH (gitleaks, trufflehog)',
      'The secrets auditor falls back to pattern + entropy review and records that as a coverage gap — which is correct only if it is true.');
  }
  if (!found['osv-scanner'] && !found['pip-audit'] && !found.govulncheck && !found.trivy) {
    warn('scanners', 'no vulnerability scanner on PATH (osv-scanner, pip-audit, govulncheck, trivy)',
      'The deps auditor falls back to lockfile version + advisory review; its SCA coverage is partial and must say so.');
  }
  return { found, absent };
}

// ───────────────────────────────────────────────────────────── target

const ECO_MARKERS = {
  node: ['package.json'], python: ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py'],
  php: ['composer.json'], ruby: ['Gemfile'], 'java-jvm': ['pom.xml', 'build.gradle', 'build.gradle.kts'],
  go: ['go.mod'], dotnet: null,
};
const LOCKFILES = {
  node: ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'], python: ['poetry.lock', 'Pipfile.lock'],
  php: ['composer.lock'], ruby: ['Gemfile.lock'], 'java-jvm': ['gradle.lockfile'], go: ['go.sum'],
  dotnet: ['packages.lock.json'],
};

function checkTarget(repo) {
  if (!existsSync(repo) || !statSync(repo).isDirectory()) {
    blocking('target', `repo "${repo}" does not exist or is not a directory`, '');
    return {};
  }
  // A subdirectory of a larger checkout (a service in a monorepo, a fixture nested in this repo) has no
  // .git of its own and is still fully tracked — ask git, and fall back to the directory test only when
  // git itself is unavailable.
  let isGit = existsSync(path.join(repo, '.git'));
  try {
    isGit = execFileSync('git', ['-C', repo, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true';
  } catch { /* git missing or not a work tree: keep the directory test's answer */ }
  if (!isGit) {
    warn('target', 'target is not inside a git work tree',
      'SKILL.md gates findings on `git ls-files` tracking: with no git history, every finding risks being ' +
      'demoted to informational, which is excluded from the headline count. Audit a checkout, or expect ' +
      'to override that rule.');
  }

  // The operator-owned project context, when present, must parse — a missing heading or a leftover seed
  // placeholder is carried into every brief as-is. Same rules as tools/context.py check.
  const ctx = path.join(repo, '.codeaudit-context.md');
  let contextFile = null;
  if (existsSync(ctx)) {
    const body = read(ctx);
    const lines = body.split('\n').length;
    const problems = [];
    for (const h of ['## What this codebase does', '## Auth shape', '## Trust boundaries and adversaries', '## Project-specific patterns to flag', '## Known non-findings']) {
      if (!new RegExp(`^${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(body)) problems.push(`missing heading "${h}"`);
    }
    if (lines > 120) problems.push(`${lines} lines (budget 120)`);
    if (body.length > 10000) problems.push(`${body.length} chars (budget 10000)`);
    for (const p of ['{project name}', '{what}', '3–5 bullets', '3-5 bullets', 'TODO']) if (body.includes(p)) problems.push(`placeholder "${p}" still present`);
    if (problems.length) {
      warn('target', `.codeaudit-context.md: ${problems.join('; ')}`,
        'It is injected into every agent brief as the operator\'s statement; fix it before launching (reference/PROJECT_CONTEXT.md).');
    }
    contextFile = { path: ctx, lines, problems };
  }

  const found = [];
  for (const [key, markers] of Object.entries(ECO_MARKERS)) {
    const hit = key === 'dotnet'
      ? readdirSync(repo).some((f) => f.endsWith('.csproj') || f.endsWith('.sln'))
      : markers.some((m) => existsSync(path.join(repo, m)));
    if (!hit) continue;
    const locks = (LOCKFILES[key] || []).filter((l) => existsSync(path.join(repo, l)));
    found.push({ key, locked: locks.length > 0, lockfile: locks[0] || null });
    if (!locks.length) {
      warn('target', `${key}: manifest present but no lockfile`,
        `Every version-gated row in ecosystems/${key}.md becomes a coverage_gaps entry instead of a ` +
        `verdict — the binding rule forbids guessing. Commit a lockfile for a sharper audit.`);
    }
  }
  if (!found.length) warn('target', 'no supported ecosystem manifest found at the repo root',
    'A monorepo keeps them in subdirectories — recon handles that, but version pinning may be partial.');

  let files = 0;
  try {
    files = Number(execFileSync('bash', ['-lc',
      `cd ${JSON.stringify(repo)} && git ls-files 2>/dev/null | wc -l || find . -type f | wc -l`],
      { encoding: 'utf8' }).trim()) || 0;
  } catch { /* best effort */ }

  return { isGit, ecosystems: found, files, contextFile };
}

// ───────────────────────────────────────────────────────────── main

function main(argv) {
  const repo = argv.includes('--repo') ? argv[argv.indexOf('--repo') + 1] : null;
  const cwd = argv.includes('--cwd') ? argv[argv.indexOf('--cwd') + 1] : process.cwd();

  const stats = {
    mounts: checkMounts(cwd), agents: checkAgents(), ecosystems: checkEnums(),
    safe_headings: checkSafeFileContract(), skipped_register: checkSkippedRegister(), pointers: checkPointers(),
    artifacts: checkArtifacts(), tools: checkTools(),
  };
  const scanners = checkScanners();
  const target = repo ? checkTarget(path.resolve(repo)) : null;

  const blocks = problems.filter((p) => p.level === 'BLOCK');
  const warns = problems.filter((p) => p.level === 'WARN');

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ stats, scanners, target, problems, ok: blocks.length === 0 }, null, 2));
  } else {
    console.log(`\ncodeaudit preflight — launch dir: ${cwd}`);
    console.log(`  plugin: ${stats.mounts} mount paths · ${stats.agents} agents · ${stats.ecosystems} ecosystem files · ` +
      `${stats.skipped_register} skipped registers · ${stats.pointers} pointers · ${stats.artifacts} artifacts · ${stats.tools} tools`);
    if (target) {
      console.log(`  target: ${path.resolve(repo)} — ${target.isGit ? 'git' : 'NOT git'} · ${target.files} files · ` +
        `ecosystems: ${(target.ecosystems || []).map((e) => e.key + (e.locked ? `(${e.lockfile})` : '(NO LOCKFILE)')).join(', ') || 'none'}`);
    }
    const sc = Object.keys(scanners.found);
    console.log(`  scanners: ${sc.length ? sc.join(', ') : 'none'}${scanners.absent.length ? ` · absent: ${scanners.absent.join(', ')}` : ''}`);
    console.log('            pass these to the auditors as `tools_available` — a brief that says "none" while one is installed makes an auditor record a coverage gap that is false.');
    console.log('');
    for (const p of [...blocks, ...warns]) {
      console.log(`  [${p.level === 'BLOCK' ? 'BLOCK' : ' WARN'}] ${p.check}: ${p.msg}`);
      if (p.hint) console.log(`          ${p.hint}`);
    }
    console.log(`\n  ${blocks.length} blocking · ${warns.length} warnings`);
    console.log(blocks.length ? '  DO NOT LAUNCH — a blocking problem makes the audit silently incomplete.\n'
      : warns.length ? '  Safe to launch; the warnings describe where the audit will be weaker.\n'
      : '  Clean.\n');
  }
  return blocks.length ? 2 : warns.length ? 1 : 0;
}

function isMainModule() {
  const a = process.argv[1];
  if (!a) return false;
  try { return import.meta.url === pathToFileURL(require('node:fs').realpathSync(a)).href; }
  catch { return import.meta.url === pathToFileURL(path.resolve(a)).href; }
}
if (isMainModule()) process.exit(main(process.argv.slice(2)));

export { checkMounts, checkAgents, checkEnums, checkSafeFileContract, checkSkippedRegister, checkPointers, checkArtifacts, checkTools, checkScanners, checkTarget, problems };
