// Tests for the eval judge + a CONTRACT GUARD over the committed scenarios and fixtures.
//
// The judge is the only executable part of the eval harness, so it is the only part CI can check without
// spending model tokens. These tests pin its semantics (what counts as a false negative, a false positive,
// a recorded rule-out) and assert that every committed scenario is well-formed and points at a real fixture.
//
// Run:  node --test plugins/codeaudit/evals/judge.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { judge, loadScenario, matchFinding, matchRuleOut, findingPath, findingText,
  findingIdentity, lintNegativeTerms } from './judge.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS = path.join(HERE, 'scenarios');
const FIXTURES = path.join(HERE, 'fixtures');

const finding = (over = {}) => ({
  id: 'finding-ac-001', title: 'CSRF on state-changing GET', severity: 'high', confidence: 'high',
  status: 'open', vuln_class: 'access-control', owasp: 'A01:2021 Broken Access Control', cwe: 'CWE-352',
  location: { file: 'server.js', line: 34 }, source: "req.query.email (server.js:34)",
  sink: 'ACCOUNTS[s.username].email (server.js:36)', privilege_required: 'authenticated',
  trace: ['server.js:34'], ...over,
});

// ---------------------------------------------------------------- matching

test('matchFinding: unspecified criteria are not constraints', () => {
  const f = finding();
  assert.ok(matchFinding(f, {}, findingText(f)));
  assert.ok(matchFinding(f, { cwe: 'CWE-352' }, findingText(f)));
  assert.ok(!matchFinding(f, { cwe: 'CWE-79' }, findingText(f)));
});

test('matchFinding: path matches on suffix and substring, not only exact', () => {
  const f = finding({ location: { file: 'src/api/server.js', line: 34 } });
  const t = findingText(f);
  assert.ok(matchFinding(f, { path: 'server.js' }, t), 'suffix');
  assert.ok(matchFinding(f, { path: 'api/server.js' }, t), 'partial path');
  assert.ok(!matchFinding(f, { path: 'other.js' }, t));
});

test('matchFinding: evidence terms are matched case-insensitively across every narrative field', () => {
  const f = finding();
  const t = findingText(f, '## Why it is vulnerable\nSameSite=Lax still sends the cookie on navigation.');
  assert.ok(matchFinding(f, { evidence_contains: ['/api/email'] }, findingText(f, 'GET /api/email')));
  assert.ok(matchFinding(f, { evidence_contains: ['samesite'] }, t), 'from the description.md body');
  assert.ok(!matchFinding(f, { evidence_contains: ['nonexistent-term'] }, t));
});

test('matchFinding: min_severity is a floor', () => {
  const t = (f) => findingText(f);
  const med = finding({ severity: 'medium' });
  assert.ok(matchFinding(med, { min_severity: 'medium' }, t(med)));
  assert.ok(!matchFinding(med, { min_severity: 'high' }, t(med)));
  const crit = finding({ severity: 'critical' });
  assert.ok(matchFinding(crit, { min_severity: 'high' }, t(crit)));
});

test('findingPath tolerates both the object and the bare "file:line" string shapes', () => {
  assert.equal(findingPath({ location: { file: './src/a.js' } }), 'src/a.js');
  assert.equal(findingPath({ location: 'src/a.js:12' }), 'src/a.js');
  assert.equal(findingPath({}), '');
});

test('matchRuleOut keys on disposition and detail text', () => {
  const e = { vuln_class: 'injection', disposition: 'precondition_subsumes', detail: 'plugin dir is operator-owned (host.js:12)' };
  assert.ok(matchRuleOut(e, { disposition: 'precondition_subsumes' }));
  assert.ok(matchRuleOut(e, { evidence_contains: ['plugin'] }));
  assert.ok(!matchRuleOut(e, { disposition: 'guard_present' }));
});

// ---------------------------------------------------------------- judging

test('a planted true positive that is found passes; a missed one is a hard FAIL', () => {
  const scenario = { name: 's', given: 'g', fixture: 'f', should_find: [{ cwe: 'CWE-352', path: 'server.js' }] };
  assert.ok(judge(scenario, { findings: [finding()] }).passed);

  const missed = judge(scenario, { findings: [] });
  assert.ok(!missed.passed);
  assert.match(missed.results[0].detail, /FALSE NEGATIVE/);
});

test('a planted safe case that gets reported is a hard FAIL (false positive)', () => {
  const scenario = { name: 's', given: 'g', fixture: 'f',
    should_not_find: [{ path: 'server.js', evidence_contains: ['display-name'] }] };
  assert.ok(judge(scenario, { findings: [finding()] }).passed, 'unrelated finding does not trip it');

  const fp = judge(scenario, { findings: [finding({ sink: 'display-name handler (server.js:48)' })] });
  assert.ok(!fp.passed);
  assert.match(fp.results[0].detail, /FALSE POSITIVE/);
});

test('should_rule_out distinguishes "checked and ruled out" from merely absent', () => {
  const scenario = { name: 's', given: 'g', fixture: 'f',
    should_rule_out: [{ disposition: 'precondition_subsumes' }] };

  const absent = judge(scenario, { findings: [], tested_not_vulnerable: [] });
  assert.ok(!absent.passed, 'an empty report must not satisfy a rule-out assertion');
  assert.match(absent.results[0].detail, /NOT RECORDED/);

  const recorded = judge(scenario, { findings: [],
    tested_not_vulnerable: [{ vuln_class: 'injection', disposition: 'precondition_subsumes', detail: 'operator-owned dir' }] });
  assert.ok(recorded.passed);
});

test('required:false downgrades a miss to a non-blocking result', () => {
  const scenario = { name: 's', given: 'g', fixture: 'f', should_find: [{ cwe: 'CWE-352', required: false }] };
  const r = judge(scenario, { findings: [] });
  assert.ok(r.passed, 'optional assertions do not fail the scenario');
  assert.equal(r.results[0].hard, false);
});

test('must_not_contain catches a hallucinated framework anywhere in the report', () => {
  const scenario = { name: 's', given: 'g', fixture: 'f', must_not_contain: ['django'] };
  assert.ok(judge(scenario, { findings: [finding()] }).passed);

  const halluc = judge(scenario, { findings: [finding({ sink: 'Django ORM .extra() (server.js:9)' })] });
  assert.ok(!halluc.passed);
  assert.match(halluc.results[0].detail, /HALLUCINATION GUARD/);
});

test('extra findings beyond the assertions do not fail a scenario', () => {
  const scenario = { name: 's', given: 'g', fixture: 'f', should_find: [{ cwe: 'CWE-352' }] };
  const r = judge(scenario, { findings: [finding(), finding({ id: 'x', cwe: 'CWE-89', vuln_class: 'injection' })] });
  assert.ok(r.passed, 'assertions are a minimum bar, not an exact-match list');
});

test('UNTRUSTED REPORT: malformed input is counted, never fatal', () => {
  const scenario = { name: 's', given: 'g', fixture: 'f', should_find: [{ cwe: 'CWE-352' }] };
  for (const bad of [null, undefined, {}, { findings: 'nope' }, { findings: [null, 7, 'x'] }]) {
    const r = judge(scenario, bad);
    assert.equal(typeof r.passed, 'boolean', `judge survived ${JSON.stringify(bad)}`);
  }
  const mixed = judge(scenario, { findings: [null, finding(), 'garbage'] });
  assert.ok(mixed.passed, 'a valid finding among garbage still satisfies the assertion');
  assert.ok(mixed.warnings.some((w) => /not objects/.test(w)));
});

// ---------------------------------------------------------------- regressions (adversarial review)

test('REGRESSION: a negative assertion must not fire on the true positive\'s own narrative', () => {
  // The plugin REQUIRES contrastive reasoning: prior_art must say why the version-fixed pattern is not a
  // finding. Matching should_not_find against the narrative scored that discipline as a false positive.
  const correct = {
    id: 'finding-auth-001', title: 'Unverified JWT claims decide an admin role', severity: 'high',
    vuln_class: 'auth', cwe: 'CWE-287', location: { file: 'auth.js', line: 20 },
    source: 'req.headers.authorization (auth.js:19)', sink: 'jwt.decode() claims -> role check (auth.js:20)',
    privilege_required: 'none',
    prior_art: 'pinned 9.0.2; unlike currentUser(), the missing algorithms option is not CVE-2022-23540 here',
  };
  const scenario = { name: 's', given: 'g', fixture: 'f',
    should_not_find: [{ path: 'auth.js', evidence_contains: ['currentuser'] }] };
  assert.ok(judge(scenario, { findings: [correct] }).passed,
    'a correct audit that merely MENTIONS the safe sibling in prior_art must not be scored a false positive');

  // ...while a finding actually FILED against the safe sibling still fails.
  const fp = { ...correct, id: 'x', title: 'alg:none bypass in currentUser',
    sink: 'jwt.verify without algorithms (auth.js:12)', location: { file: 'auth.js', line: 12 } };
  assert.ok(!judge(scenario, { findings: [correct, fp] }).passed, 'the precision check must still bite');
});

test('REGRESSION: findingIdentity excludes narrative fields, findingText includes them', () => {
  const f = { title: 'T', sink: 'S', location: { file: 'a.js', line: 1 }, prior_art: 'MENTIONSAFESIBLING' };
  assert.ok(!findingIdentity(f).includes('mentionsafesibling'));
  assert.ok(findingText(f).includes('mentionsafesibling'));
});

test('REGRESSION: lint rejects short and report-ubiquitous negative terms', () => {
  // Both of these shipped in a committed scenario and inverted it.
  assert.match(lintNegativeTerms({ should_not_find: [{ evidence_contains: ['alg'] }] })[0], /too short/);
  assert.match(lintNegativeTerms({ should_not_find: [{ evidence_contains: ['none'] }] })[0], /enum value/);
  assert.match(lintNegativeTerms({ must_not_contain: ['high'] })[0], /enum value/);
  assert.equal(lintNegativeTerms({ should_not_find: [{ evidence_contains: ['loadPlugins'] }] }).length, 0);
  assert.throws(() => loadScenario(path.join(HERE, 'judge.test.mjs')), /./, 'loadScenario rejects non-scenarios');
});

test('REGRESSION: the CLI entry guard resolves symlinks and spaces', () => {
  // A naive `import.meta.url === \`file://${process.argv[1]}\`` left main() unrun under such a path:
  // nothing printed, exit 0 — which a CI wrapper reads as PASS for a run that found nothing.
  const src = readFileSync(path.join(HERE, 'judge.mjs'), 'utf8');
  assert.ok(src.includes('pathToFileURL'), 'entry guard must normalise through pathToFileURL');
  assert.ok(src.includes('realpathSync'), 'entry guard must resolve symlinks');
  assert.ok(!/import\.meta\.url === `file:\/\/\$\{process\.argv\[1\]\}`/.test(src),
    'the naive string comparison must not come back');
});

// ---------------------------------------------------------------- contract guard

test('CONTRACT GUARD: every committed scenario is well-formed and points at a real fixture', () => {
  const files = readdirSync(SCENARIOS).filter((f) => f.endsWith('.eval.json'));
  assert.ok(files.length > 0, 'no scenarios committed');

  for (const file of files) {
    const s = loadScenario(path.join(SCENARIOS, file));          // throws on a malformed scenario
    assert.equal(s.name, file.replace(/\.eval\.json$/, ''), `${file}: "name" must match the filename`);

    const fixture = path.join(HERE, s.fixture);
    assert.ok(existsSync(fixture), `${file}: fixture ${s.fixture} does not exist`);
    assert.ok(existsSync(path.join(fixture, 'README.md')),
      `${file}: fixture ${s.fixture} has no README.md — every realistic project has one, and a fixture ` +
      `without it is not the shape an audit actually meets`);

    // The answer key lives OUTSIDE the audited tree. Inside it, it voids both halves of the measurement:
    // should_find passes because the README names the bug, and should_not_find passes because a "// SAFE:"
    // comment is exactly what the report contract accepts as a `by_design` rule-out. The threat-modeler is
    // explicitly instructed to read README* first, so the leak is guaranteed, not incidental.
    assert.ok(existsSync(path.join(HERE, 'answers', `${s.name}.md`)),
      `${file}: no answers/${s.name}.md — the planted bug must be documented for reviewers OUTSIDE the ` +
      `fixture tree the audit reads`);

    const leak = /VULNERABLE|SAFE:|planted|not a finding|CIRCULAR/;
    for (const f of readdirSync(fixture, { withFileTypes: true })) {
      if (!f.isFile()) continue;
      const body = readFileSync(path.join(fixture, f.name), 'utf8');
      assert.ok(!leak.test(body),
        `${s.fixture}/${f.name} leaks the answer key into the audited tree (matched ${leak}). ` +
        `Move it to answers/${s.name}.md — an audit that reads the answer measures nothing.`);
    }

    assert.ok(s.rationale && s.rationale.length > 40,
      `${file}: needs a "rationale" explaining which audit error this scenario catches`);

    // A scenario with only positive assertions measures recall and says nothing about precision.
    const negatives = (s.should_not_find?.length ?? 0) + (s.must_not_contain?.length ?? 0);
    assert.ok(negatives > 0,
      `${file}: has no should_not_find / must_not_contain. Every fixture must plant a safe sibling, ` +
      `otherwise the eval rewards a run that reports everything.`);
  }
});

test('CONTRACT GUARD: every fixture is referenced by at least one scenario', () => {
  const referenced = new Set(readdirSync(SCENARIOS)
    .filter((f) => f.endsWith('.eval.json'))
    .map((f) => path.basename(JSON.parse(readFileSync(path.join(SCENARIOS, f), 'utf8')).fixture)));

  for (const entry of readdirSync(FIXTURES, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    assert.ok(referenced.has(entry.name),
      `fixtures/${entry.name} is not referenced by any scenario — an orphan fixture is never run`);
  }
});
