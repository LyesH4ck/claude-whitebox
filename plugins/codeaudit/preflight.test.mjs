// Tests for the codeaudit preflight — and, through it, the first mechanical coverage of the plugin's
// MARKDOWN, which is the actual product. The rest of the suite tests the JS tooling and asserts nothing
// about the prompts.
//
// Every check here must be verified in BOTH directions: clean on the real plugin, and failing when the
// defect it guards is reintroduced. A preflight that cannot fail is decoration.
//
// Run:  node --test plugins/codeaudit/preflight.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'preflight.mjs');
const MARKET = path.resolve(HERE, '../..');

// The mount check exercises the resolver for real, and the resolver globs ~/.claude/plugins/cache — the
// OPERATOR'S machine. Left to the ambient HOME these assertions test that machine rather than the plugin:
// they warn whenever the installed copy lags the checkout (the normal state right after a version bump),
// and on a CI runner there is no installed copy at all, so the resolver legitimately finds nothing from an
// unrelated directory and blocks. Stage a HOME holding exactly this checkout's version instead. The warning
// itself still fires for real operators, which is where that signal belongs.
const VERSION = JSON.parse(readFileSync(path.join(HERE, '.claude-plugin/plugin.json'), 'utf8')).version;
const HOME_STUB = mkdtempSync(path.join(tmpdir(), 'pf-home-'));
{
  const installed = path.join(HOME_STUB, '.claude/plugins/cache/claude-whitebox/codeaudit', VERSION);
  mkdirSync(path.join(installed, 'skills/code-audit'), { recursive: true });
  mkdirSync(path.join(installed, '.claude-plugin'), { recursive: true });
  writeFileSync(path.join(installed, 'skills/code-audit/SKILL.md'), '# stub: only its presence is resolved\n');
  cpSync(path.join(HERE, '.claude-plugin/plugin.json'), path.join(installed, '.claude-plugin/plugin.json'));
}
process.on('exit', () => rmSync(HOME_STUB, { recursive: true, force: true }));

/** Run the preflight; returns {code, out}. Never throws on a non-zero exit — that is the signal. */
function run(args = [], cwd = MARKET) {
  const env = { ...process.env, HOME: HOME_STUB };
  try {
    return { code: 0, out: execFileSync('node', [SCRIPT, '--json', ...args], { cwd, encoding: 'utf8', env }) };
  } catch (e) {
    return { code: e.status, out: e.stdout || '' };
  }
}
const parse = (r) => JSON.parse(r.out);

test('the real plugin passes its own preflight with no blocking problem', () => {
  const r = run();
  const o = parse(r);
  assert.equal(o.problems.filter((p) => p.level === 'BLOCK').length, 0,
    'blocking: ' + JSON.stringify(o.problems.filter((p) => p.level === 'BLOCK'), null, 1));
  assert.ok(o.stats.agents >= 20, `expected the full agent set, saw ${o.stats.agents}`);
  assert.ok(o.stats.mounts > 50, 'mount paths should be discovered, not zero');
  assert.ok(o.stats.ecosystems >= 9, 'ecosystem reference files should be discovered');
});

test('the preflight produces NO warnings on the real plugin', () => {
  // A preflight whose baseline is noisy trains the operator to ignore it, which is worse than not having
  // one. The clean baseline is the feature: any warning on a real run is then a real signal.
  const o = parse(run());
  assert.deepEqual(o.problems, [], 'baseline must be silent; got: ' + JSON.stringify(o.problems, null, 1));
});

test('the audit resolves its methodology from ANY directory, including the target repo', () => {
  // The whole point. codeaudit is installed as a copy under ~/.claude/plugins/cache while the audit runs
  // wherever the target code is, so repo-relative mounts resolved only by accident of the session's working
  // directory — and failed SILENTLY elsewhere: the agent proceeds with no methodology and still writes a
  // confident report. Agents resolve a root instead; this proves it holds from unrelated directories.
  for (const cwd of [tmpdir(), process.env.HOME || '/', path.parse(process.cwd()).root]) {
    const r = run([], cwd);
    assert.equal(r.code, 0, `preflight must be clean from ${cwd}; got exit ${r.code}: ${r.out.slice(0, 400)}`);
  }
});

test('BLOCKS if a repo-relative mount creeps back into any agent', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pf-rel-'));
  try {
    cpSync(HERE, path.join(dir, 'plugins', 'codeaudit'), { recursive: true });
    const agent = path.join(dir, 'plugins/codeaudit/agents/crypto-auditor.md');
    writeFileSync(agent, readFileSync(agent, 'utf8')
      .replace('Read $CA/skills/code-audit/SKILL.md', 'Read plugins/codeaudit/skills/code-audit/SKILL.md'));
    let out, code = 0;
    try { out = execFileSync('node', [path.join(dir, 'plugins/codeaudit/preflight.mjs'), '--json'], { cwd: dir, encoding: 'utf8' }); }
    catch (e) { code = e.status; out = e.stdout; }
    assert.equal(code, 2, 'a repo-relative mount is a regression and must block');
    assert.ok(JSON.parse(out).problems.some((p) => /relative to the working directory/.test(p.msg)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('BLOCKS an agent whose root resolver cannot fail loudly, or globs the cache unsorted', () => {
  // Both of these degrade silently: an unsorted glob picks an arbitrary installed version (the cache keeps
  // every one side by side), and a resolver with no NOT-FOUND branch lets the agent audit with nothing.
  const dir = mkdtempSync(path.join(tmpdir(), 'pf-res-'));
  try {
    cpSync(HERE, path.join(dir, 'plugins', 'codeaudit'), { recursive: true });
    const agent = path.join(dir, 'plugins/codeaudit/agents/crypto-auditor.md');
    const body = readFileSync(agent, 'utf8');
    writeFileSync(agent, body.replaceAll('sort -V | tail -1', 'head -1').replace(/CODEAUDIT-ROOT-NOT-FOUND/g, 'ok'));
    let out, code = 0;
    try { out = execFileSync('node', [path.join(dir, 'plugins/codeaudit/preflight.mjs'), '--json'], { cwd: dir, encoding: 'utf8' }); }
    catch (e) { code = e.status; out = e.stdout; }
    assert.equal(code, 2);
    const msgs = JSON.parse(out).problems.map((p) => p.msg).join(' ');
    assert.match(msgs, /sort -V/, 'unsorted cache glob must block');
    assert.match(msgs, /never checks it was found/, 'a resolver with no abort must block');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('BLOCKS an auditor that no longer asks for the skipped register', () => {
  // The failure is silent in the worst direction: an auditor never asked whether it skipped a file reports
  // `complete`, and the report prints "all in-scope sources traced" over a file nobody read.
  const dir = mkdtempSync(path.join(tmpdir(), 'pf-skip-'));
  try {
    cpSync(HERE, path.join(dir, 'plugins', 'codeaudit'), { recursive: true });
    const agent = path.join(dir, 'plugins/codeaudit/agents/crypto-auditor.md');
    writeFileSync(agent, readFileSync(agent, 'utf8').replaceAll('SKIPPED:', 'DONE:'));
    let out, code = 0;
    try { out = execFileSync('node', [path.join(dir, 'plugins/codeaudit/preflight.mjs'), '--json'], { cwd: dir, encoding: 'utf8' }); }
    catch (e) { code = e.status; out = e.stdout; }
    assert.equal(code, 2);
    assert.ok(JSON.parse(out).problems.some((p) => p.check === 'skipped-register' && /crypto-auditor\.md never asks/.test(p.msg)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('BLOCKS on a disposition that is not in the report contract', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pf-'));
  try {
    cpSync(HERE, path.join(dir, 'plugins', 'codeaudit'), { recursive: true });
    const agent = path.join(dir, 'plugins/codeaudit/agents/injection-auditor.md');
    writeFileSync(agent, readFileSync(agent, 'utf8') + '\n\nUse `out_of_model_invented_label` when unsure.\n');
    const r = run([], dir);
    // run() invokes the ORIGINAL script; point it at the copy instead
    const r2 = (() => {
      try {
        return { code: 0, out: execFileSync('node', [path.join(dir, 'plugins/codeaudit/preflight.mjs'), '--json'],
          { cwd: dir, encoding: 'utf8' }) };
      } catch (e) { return { code: e.status, out: e.stdout || '' }; }
    })();
    assert.equal(r2.code, 2, 'an invented disposition must block');
    assert.ok(parse(r2).problems.some((p) => p.check === 'enums' && /out_of_model_invented_label/.test(p.msg)));
    assert.ok(r.code >= 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('BLOCKS when an ecosystem reference file exists but code-recon cannot route to it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pf-'));
  try {
    cpSync(HERE, path.join(dir, 'plugins', 'codeaudit'), { recursive: true });
    writeFileSync(path.join(dir, 'plugins/codeaudit/skills/code-audit/reference/ecosystems/elixir.md'),
      '# Elixir\n\n## Version facts to check\n## Safe or non-reportable forms\n## Commands\n');
    let out, code = 0;
    try {
      out = execFileSync('node', [path.join(dir, 'plugins/codeaudit/preflight.mjs'), '--json'],
        { cwd: dir, encoding: 'utf8' });
    } catch (e) { code = e.status; out = e.stdout; }
    assert.equal(code, 2, 'an unroutable ecosystem file must block — recon would never send an auditor to it');
    assert.ok(JSON.parse(out).problems.some((p) => /elixir/.test(p.msg)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('target mode reports git and lockfile state, which change what the audit can conclude', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pf-target-'));
  try {
    writeFileSync(path.join(dir, 'package.json'), '{"name":"t","dependencies":{"express":"^4"}}');
    const noLock = parse(run(['--repo', dir]));
    assert.ok(noLock.target.ecosystems.some((e) => e.key === 'node' && !e.locked));
    assert.ok(noLock.problems.some((p) => /no lockfile/.test(p.msg)),
      'a missing lockfile turns every version-gated row into a coverage gap — the operator must know before launching');
    assert.ok(noLock.problems.some((p) => /not a git repository/.test(p.msg)));

    writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3}');
    const locked = parse(run(['--repo', dir]));
    assert.ok(locked.target.ecosystems.some((e) => e.key === 'node' && e.locked));
    assert.ok(!locked.problems.some((p) => /no lockfile/.test(p.msg)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('target mode BLOCKS on a repo that does not exist', () => {
  const r = run(['--repo', path.join(tmpdir(), 'definitely-not-here-' + process.pid)]);
  assert.equal(r.code, 2);
  assert.ok(parse(r).problems.some((p) => p.check === 'target' && p.level === 'BLOCK'));
});

test('exit codes are the contract: 0 clean, 1 warnings only, 2 blocking', () => {
  assert.equal(run().code, 0, 'clean baseline must exit 0');
  const dir = mkdtempSync(path.join(tmpdir(), 'pf-warn-'));
  try {
    writeFileSync(path.join(dir, 'package.json'), '{"name":"t"}');   // manifest, no lockfile, no git
    assert.equal(run(['--repo', dir]).code, 1, 'warnings only must exit 1');
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const bad = mkdtempSync(path.join(tmpdir(), 'pf-block-'));
  try {
    cpSync(HERE, path.join(bad, 'plugins', 'codeaudit'), { recursive: true });
    const a = path.join(bad, 'plugins/codeaudit/agents/crypto-auditor.md');
    writeFileSync(a, readFileSync(a, 'utf8').replace('Read $CA/skills/code-audit/SKILL.md', 'Read $CA/does-not-exist.md'));
    let code = 0;
    try { execFileSync('node', [path.join(bad, 'plugins/codeaudit/preflight.mjs'), '--json'], { cwd: bad, encoding: 'utf8' }); }
    catch (e) { code = e.status; }
    assert.equal(code, 2, 'blocking must exit 2');
  } finally { rmSync(bad, { recursive: true, force: true }); }
});

test('tools: the three Step 6.5/6.6 tools ship and are invoked by the command; a missing one blocks', () => {
  const clean = parse(run());
  assert.equal(clean.stats.tools, 3);
  assert.ok(!clean.problems.some((p) => p.check === 'tools'), 'clean plugin has no tools problem');

  const tmp = mkdtempSync(path.join(tmpdir(), 'codeaudit-pf-'));
  cpSync(MARKET, tmp, { recursive: true, filter: (s) => !s.includes('node_modules') && !s.includes('/.git') });
  rmSync(path.join(tmp, 'plugins/codeaudit/tools/aggregate.py'));
  let out;
  try { out = execFileSync('node', [path.join(tmp, 'plugins/codeaudit/preflight.mjs'), '--json'], { cwd: tmp, encoding: 'utf8' }); }
  catch (e) { out = e.stdout; }
  const broken = JSON.parse(out);
  assert.ok(broken.problems.some((p) => p.check === 'tools' && p.level === 'BLOCK' && /aggregate\.py/.test(p.msg)));
  rmSync(tmp, { recursive: true, force: true });
});
