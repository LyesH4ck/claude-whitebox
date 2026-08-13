// Minimal fixture test for sink-sweep.mjs — run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'sink-sweep.mjs');

function run(setup) {
  const root = mkdtempSync(join(tmpdir(), 'sinksweep-'));
  const repo = join(root, 'repo'); const out = join(root, 'out');
  mkdirSync(repo, { recursive: true }); mkdirSync(join(out, 'findings'), { recursive: true });
  setup(repo, out);
  const stdout = execFileSync('node', [SCRIPT, repo, out, 'tests/'], { encoding: 'utf8' });
  rmSync(root, { recursive: true, force: true });
  return JSON.parse(stdout);
}

test('flags an unverdicted high-signal SSRF sink; ignores a verdicted one', () => {
  const res = run((repo, out) => {
    mkdirSync(join(repo, 'topmod'), { recursive: true });
    // uncovered: a build_opener SSRF in a module with NO ssrf finding
    writeFileSync(join(repo, 'topmod', 'views.py'), 'def f(u):\n    return build_opener().open(u)\n');
    // covered: a urlopen SSRF that HAS a verdict at its line
    writeFileSync(join(repo, 'api.py'), 'x=1\ny=2\ndata = urlopen(url).read()\n');
    mkdirSync(join(out, 'findings', 'finding-ssrf-001'), { recursive: true });
    writeFileSync(join(out, 'findings', 'finding-ssrf-001', 'description.md'),
      'sink: urlopen at api.py:3\n');
  });
  const ssrf = res.uncovered.ssrf || [];
  const files = ssrf.map(f => f.file);
  assert.ok(files.some(f => f.endsWith('topmod/views.py')), 'topmod SSRF must be uncovered');
  assert.ok(!files.some(f => f.endsWith('api.py')), 'verdicted api.py SSRF must NOT be uncovered');
});

test('respects out_of_scope exclusion', () => {
  const res = run((repo) => {
    mkdirSync(join(repo, 'tests'), { recursive: true });
    writeFileSync(join(repo, 'tests', 'x.py'), 'build_opener().open(u)\n');
  });
  const files = (res.uncovered.ssrf || []).map(f => f.file);
  assert.ok(!files.some(f => f.includes('tests/')), 'excluded dir must not appear');
});

test('ubiquitous sinks are NOT swept (precision)', () => {
  const res = run((repo) => {
    writeFileSync(join(repo, 'a.py'), 'qs.query("select 1")\nel.innerHTML = x\nrequests.get(u)\n');
  });
  // none of these are high-signal → no uncovered entries
  assert.equal(res.summary.injection.uncovered_files, 0);
  assert.equal((res.uncovered.ssrf || []).length, 0);
});
