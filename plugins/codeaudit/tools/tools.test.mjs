// Tests for the three Step 6.5/6.6 mechanical tools (reconcile.py, aggregate.py, render.py).
//
// Every rule here was learned on a real engagement where its absence lost or distorted a result:
//   - a condensed evidence file using a declared path alias made 68 verdicted sources look uncited;
//   - `**Confidence**: probable (…)` was parsed as invalid and silently dropped a chain member;
//   - a class owner's severity revision and a follow-up's extra locations had nowhere to go.
// Each test is verified in both directions where it matters: the clean fixture passes, the defect fails.
//
// Run:  node --test plugins/codeaudit/tools/tools.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const py = (script, args, cwd) => execFileSync('python3', ['-I', path.join(HERE, script), ...args], { cwd, encoding: 'utf8' });
const w = (root, rel, body) => { mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), body); };

function finding(cls, title, { severity, confidence, privilege, src, sink, loc, slot = 'SQL-value', cwe = 'CWE-89' }) {
  return `# [${cls}] ${title}
**Severity**: ${severity}
**Confidence**: ${confidence}
**Privilege required**: ${privilege}
**OWASP**: A03:2021 Injection
**CWE**: ${cwe}

## Location
\`${loc}\`

## Source → Sink
- **Source**: ${src}
- **Sink**: ${sink}
- **Path**: a.ts:10 → svc.ts:5 → ${loc}
- slot \`${slot}\`

## Why it is vulnerable
The value is concatenated.

## Code
\`\`\`ts
db.raw("select " + q)
\`\`\`

## Remediation
Parameterise it.
`;
}

/** A minimal but complete engagement output tree. */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'codeaudit-tools-'));
  w(root, 'recon/sink-inventory.json', JSON.stringify({
    entry_points: [
      { method: 'GET', path: '/a', component: 'api', sources: [{ at: 'src/handlers/a.ts:10', name: 'q', in: 'query' }] },
      { method: 'GET', path: '/b', component: 'api', sources: [{ at: 'src/handlers/b.ts:20', name: 'id', in: 'path' }] },
      { method: 'GET', path: '/c', component: 'web', sources: [{ at: 'src/web/c.ts:30', name: 'x', in: 'json' }] },
      { method: 'GET', path: '/d', component: 'web', sources: [{ at: 'src/web/d.ts:40', name: 'y', in: 'json' }] },
    ],
  }));
  w(root, 'findings/finding-inj-001/description.md', finding('injection', 'SQLi in a', {
    severity: 'critical', confidence: 'high (helper fully read)', privilege: 'authenticated (any member)',
    src: '`req.query.q` (src/handlers/a.ts:10)', sink: '`db.raw` (src/db/repo.ts:99)', loc: 'src/db/repo.ts:99' }));
  // exact-key duplicate of inj-001 filed by another shard → merged
  w(root, 'findings/finding-inj-002/description.md', finding('injection', 'SQLi in a (again)', {
    severity: 'high', confidence: 'high', privilege: 'authenticated',
    src: '`req.query.q` (src/handlers/a.ts:10)', sink: '`db.raw` (src/db/repo.ts:99)', loc: 'src/db/repo.ts:99' }));
  // unconfirmed → coverage gap, not a finding
  w(root, 'findings/finding-xss-001/description.md', finding('xss', 'maybe XSS', {
    severity: 'medium', confidence: 'unconfirmed', privilege: 'none',
    src: '`req.body.x` (src/web/c.ts:30)', sink: '`innerHTML` (src/web/view.ts:3)', loc: 'src/web/view.ts:3', slot: 'HTML-body', cwe: 'CWE-79' }));
  // chain member whose confidence carries a parenthetical — must survive the gate
  w(root, 'findings/finding-ac-001/description.md', finding('access-control', 'IDOR on b', {
    severity: 'low', confidence: 'probable (platform fact outside the repo)', privilege: 'none',
    src: '`req.params.id` (src/mw/auth.ts:7)', sink: '`findById` (src/db/repo.ts:120)', loc: 'src/db/repo.ts:120', slot: 'authz-decision', cwe: 'CWE-639' }));
  w(root, 'findings/_safe-injection.md', `# Evidence — injection-auditor

Paths relative to \`src/\`; \`H/\` = \`src/handlers/\`.

## tested_not_vulnerable
- [guard_present] H/b.ts:22 — id is cast to int before the query (H/b.ts:21)
- H/a.ts:12 — line with no disposition bracket

## design_properties
- public read endpoints are intentionally unauthenticated (docs/api.md:3)

## unverified_assumptions
- investigated: the WAF config is referenced at infra/waf.md:1 but not in repo → still needs: the deployed WAF body-size rule
- bare shrug with no evidence half
- investigated: read the identity-service README and the verify call at src/mw/auth.ts:7 for issuer/audience
  options — none are set
  → still needs: the identity service's token format, to decide whether a cross-service replay is possible

## coverage_gaps
- src/workers/*.ts — dynamic dispatch not traced → recommended: trace consumers
- [skipped] src/legacy/exploit-samples.ts — declined: file is a payload corpus and the analysis was cut short
`);
  w(root, 'plan/_relations.json', JSON.stringify({
    duplicates: [], subsumed: [],
    chains: [{ finding_ids: ['finding-ac-001', 'finding-inj-001'], composed_severity: 'high', exploit_order: 'ac → inj', reason: 'composes' }],
    orchestrator_adjustments: {
      severity_overrides: [{ id: 'finding-inj-001', severity: 'medium', by: 'injection-auditor (class owner)', reason: 'addendum', evidence: 'findings/finding-inj-001/addendum.md' }],
      additional_locations: [{ id: 'finding-ac-001', note: 'same root cause', locations: [{ file: 'src/db/repo.ts', line: 140, channel: 'sibling' }] }],
    },
  }));
  w(root, 'plan/_meta.json', JSON.stringify({ engagement: 'fx', repo: '/tmp/fx', commit: 'abc1234', target_url: null, date: '2026-01-01',
    metadata: { scope: { code_paths: 'src', out_of_scope: 'tests' }, mode: 'static', depth: 'Thorough', classes_audited: ['injection', 'xss', 'access-control'], languages: ['typescript'], files_in_scope: 3, live_correlation: false } }));
  w(root, 'plan/_narrative.json', JSON.stringify({ plugin_version: 'test', executive_summary: ['Posture ok.'], exec_summary_page: ['One page.'], exec_boundaries: ['static only'],
    coverage_statement: 'all cited', reconciliation_statement: 'ran', sweep_statement: 'ran',
    remediation_groups: [{ title: 'Parameterise', priority: 'P0', area: 'db', finding_ids: ['finding-inj-001'], business_impact: 'data', fix: 'use params', acceptance: 'no raw' }] }));
  return root;
}

test('reconcile: classifies line/file/uncited and expands a declared path alias', () => {
  const root = fixture();
  const out = JSON.parse(py('reconcile.py', [root, '--json'], root));
  assert.deepEqual(out.aliases_expanded, { 'H/': 'src/handlers/' });
  assert.equal(out.by_status['line-cited'], 2, 'a.ts:10 (inj-001) and c.ts:30 (xss-001, unconfirmed but still a verdict artifact)');
  assert.equal(out.by_status['file-cited'], 1, 'b.ts:20 is only reachable through the H/ alias');
  assert.equal(out.by_status['uncited'], 1, 'd.ts:40 has no verdict anywhere');
  assert.ok(existsSync(path.join(root, 'recon/_reconciliation.json')));
  rmSync(root, { recursive: true, force: true });
});

test('reconcile: without the alias expansion the same evidence file looks uncited (defect direction)', () => {
  const root = fixture();
  // Remove the declaration line only; the H/ citations stay → b.ts must drop to uncited.
  const p = path.join(root, 'findings/_safe-injection.md');
  writeFileSync(p, readFileSync(p, 'utf8').replace(/^Paths relative.*\n/m, ''));
  const out = JSON.parse(py('reconcile.py', [root, '--json'], root));
  assert.deepEqual(out.aliases_expanded, {});
  assert.equal(out.by_status['file-cited'] ?? 0, 0);
  assert.equal(out.by_status['uncited'], 2, 'b.ts:20 joins d.ts:40 as uncited');
  rmSync(root, { recursive: true, force: true });
});

test('aggregate: lenient enum tokens, caps, overrides, extra locations, dedup, unconfirmed gate, dispositions', () => {
  const root = fixture();
  py('aggregate.py', [root, '--write', '--relations', 'plan/_relations.json', '--meta', 'plan/_meta.json'], root);
  const r = JSON.parse(readFileSync(path.join(root, 'codeaudit-report.json'), 'utf8'));
  const by = Object.fromEntries(r.findings.map((f) => [f.id, f]));

  // leading-token leniency: parentheticals become notes, never a dropped finding
  assert.equal(by['finding-ac-001'].confidence, 'probable');
  assert.match(by['finding-ac-001'].confidence_note, /platform fact/);
  assert.equal(by['finding-inj-001'].privilege_required, 'authenticated');
  assert.equal(by['finding-inj-001'].privilege_note, 'any member');

  // cap then override: critical → high (authenticated cap) → medium (class-owner revision), revision recorded
  assert.equal(by['finding-inj-001'].severity, 'medium');
  assert.equal(by['finding-inj-001'].severity_revision.from, 'critical');
  assert.equal(by['finding-inj-001'].severity_revision.to, 'medium');
  assert.equal(by['finding-inj-001'].severity_cap_applied, null, 'the override is below the cap, so no cap note remains');

  // follow-up locations attached, SARIF/report will carry them
  assert.equal(by['finding-ac-001'].locations.length, 1);
  assert.equal(by['finding-ac-001'].locations[0].line, 140);

  // exact-key duplicate merged, recorded as a relation; chains merged from the relations file
  assert.ok(!by['finding-inj-002'], 'inj-002 shares (class, sink, source, slot) with inj-001');
  assert.deepEqual(by['finding-inj-001'].merged_ids, ['finding-inj-002']);
  assert.equal(r.finding_relations.duplicates.length, 1);
  assert.equal(r.finding_relations.chains.length, 1);

  // unconfirmed never reaches findings[]; it lands in coverage_gaps
  assert.ok(!by['finding-xss-001']);
  assert.ok(r.coverage_gaps.some((g) => g.item.startsWith('finding-xss-001')));
  assert.deepEqual(r.summary, { informational: 0, low: 1, medium: 1, high: 0, critical: 0, total: 2, accepted_risk: 0 });

  // the skipped register: a `[skipped]` coverage_gaps line keeps its path verbatim and is surfaced separately
  const sk = r.coverage_gaps.find((g) => g.kind === 'skipped');
  assert.equal(sk.item, 'src/legacy/exploit-samples.ts');
  assert.match(sk.reason, /payload corpus/);
  assert.equal(r.skipped_paths.length, 1);
  assert.equal(r.aggregation_stats.skipped_paths, 1);

  // every finding carries a stable fingerprint; no --previous → change is null, run_diff is null
  for (const f of r.findings) assert.match(f.fingerprint, /^fp_[0-9a-f]{16}$/);
  assert.equal(r.run_diff, null);
  assert.ok(r.findings.every((f) => f.change === null));

  // evidence arrays: disposition enum enforced (missing → model_gap + violation), both halves of an assumption
  const tnv = r.tested_not_vulnerable;
  assert.equal(tnv.length, 2);
  assert.equal(tnv[0].disposition, 'guard_present');
  assert.equal(tnv[1].disposition, 'model_gap');
  assert.ok(r.contract_violations.some((v) => /without a valid \[disposition\]/.test(v.issue)));
  assert.ok(r.contract_violations.some((v) => /evidence needed/.test(v.issue)), 'the bare shrug is a violation');
  assert.equal(r.unverified_assumptions[0].evidence_needed, 'the deployed WAF body-size rule');
  // a bullet wrapped over three lines is one entry, with its "still needs" half intact (live-run regression)
  assert.equal(r.unverified_assumptions.length, 3);
  assert.match(r.unverified_assumptions[2].evidence_needed, /^the identity service's token format/);
  assert.equal(r.contract_violations.filter((v) => /evidence needed/.test(v.issue)).length, 1, 'only the bare shrug is a violation');
  assert.equal(r.coverage_gaps[0].recommended_action, 'trace consumers');
  assert.equal(r.engagement, 'fx', 'meta merged');
  rmSync(root, { recursive: true, force: true });
});

test('aggregate: an override naming an unknown finding is a recorded violation, not a crash', () => {
  const root = fixture();
  const p = path.join(root, 'plan/_relations.json');
  const rel = JSON.parse(readFileSync(p, 'utf8'));
  rel.orchestrator_adjustments.severity_overrides.push({ id: 'finding-nope-999', severity: 'low', reason: 'x' });
  writeFileSync(p, JSON.stringify(rel));
  py('aggregate.py', [root, '--write', '--relations', 'plan/_relations.json'], root);
  const r = JSON.parse(readFileSync(path.join(root, 'codeaudit-report.json'), 'utf8'));
  assert.ok(r.contract_violations.some((v) => v.where === 'finding-nope-999'));
  rmSync(root, { recursive: true, force: true });
});

test('fingerprint: survives a line move and an id renumbering, changes when the sink changes', () => {
  const root = fixture();
  py('aggregate.py', [root, '--write', '--meta', 'plan/_meta.json'], root);
  const r1 = JSON.parse(readFileSync(path.join(root, 'codeaudit-report.json'), 'utf8'));
  const fp1 = Object.fromEntries(r1.findings.map((f) => [f.title, f.fingerprint]));

  // second "run": same bugs, every line number shifted, ids renumbered, a finding's title reworded
  // (inj-002 is the fixture's exact-key duplicate of inj-001; it goes too, or it would survive dedup at the old line)
  const root2 = fixture();
  rmSync(path.join(root2, 'findings/finding-inj-001'), { recursive: true });
  rmSync(path.join(root2, 'findings/finding-inj-002'), { recursive: true });
  w(root2, 'findings/finding-inj-007/description.md', finding('injection', 'SQLi in a (reworded)', {
    severity: 'critical', confidence: 'high', privilege: 'authenticated',
    src: '`req.query.q` (src/handlers/a.ts:14)', sink: '`db.raw` (src/db/repo.ts:103)', loc: 'src/db/repo.ts:103' }));
  py('aggregate.py', [root2, '--write', '--meta', 'plan/_meta.json'], root2);
  const r2 = JSON.parse(readFileSync(path.join(root2, 'codeaudit-report.json'), 'utf8'));
  const inj = r2.findings.find((f) => f.id === 'finding-inj-007');
  assert.equal(inj.fingerprint, fp1['SQLi in a'], 'line move + renumber + reworded title → same identity');
  assert.equal(r2.findings.find((f) => f.id === 'finding-ac-001').fingerprint, fp1['IDOR on b']);

  // a different sink expression at the same place is a different finding
  const root3 = fixture();
  rmSync(path.join(root3, 'findings/finding-inj-001'), { recursive: true });
  w(root3, 'findings/finding-inj-001/description.md', finding('injection', 'SQLi in a', {
    severity: 'critical', confidence: 'high', privilege: 'authenticated',
    src: '`req.query.q` (src/handlers/a.ts:10)', sink: '`knex.whereRaw` (src/db/repo.ts:99)', loc: 'src/db/repo.ts:99' }));
  py('aggregate.py', [root3, '--write', '--meta', 'plan/_meta.json'], root3);
  const r3 = JSON.parse(readFileSync(path.join(root3, 'codeaudit-report.json'), 'utf8'));
  assert.notEqual(r3.findings.find((f) => f.id === 'finding-inj-001').fingerprint, fp1['SQLi in a']);
  for (const d of [root, root2, root3]) rmSync(d, { recursive: true, force: true });
});

test('fingerprint: two surviving findings with identical material get deterministic ordinal suffixes', () => {
  const root = fixture();
  // same sink expression, same source, one file, two lines — a real shape (the same raw query copy-pasted)
  w(root, 'findings/finding-inj-003/description.md', finding('injection', 'SQLi in a, second copy', {
    severity: 'high', confidence: 'high', privilege: 'authenticated',
    src: '`req.query.q` (src/handlers/a.ts:10)', sink: '`db.raw` (src/db/repo.ts:150)', loc: 'src/db/repo.ts:150' }));
  py('aggregate.py', [root, '--write'], root);
  const r = JSON.parse(readFileSync(path.join(root, 'codeaudit-report.json'), 'utf8'));
  const a = r.findings.find((f) => f.id === 'finding-inj-001').fingerprint;
  const b = r.findings.find((f) => f.id === 'finding-inj-003').fingerprint;
  assert.equal(b, `${a}-2`, 'the higher sink line takes the -2 suffix');
  rmSync(root, { recursive: true, force: true });
});

test('--previous: classifies new / persisting / not re-found by fingerprint and carries first_seen', () => {
  const prevRoot = fixture();
  py('aggregate.py', [prevRoot, '--write', '--meta', 'plan/_meta.json'], prevRoot);
  const prevReport = path.join(prevRoot, 'codeaudit-report.json');

  const root = fixture();
  // the IDOR is gone, the SQLi moved lines (its exact-key duplicate with it), one brand-new finding appears
  rmSync(path.join(root, 'findings/finding-ac-001'), { recursive: true });
  rmSync(path.join(root, 'findings/finding-inj-001'), { recursive: true });
  rmSync(path.join(root, 'findings/finding-inj-002'), { recursive: true });
  w(root, 'findings/finding-inj-001/description.md', finding('injection', 'SQLi in a', {
    severity: 'critical', confidence: 'high', privilege: 'authenticated',
    src: '`req.query.q` (src/handlers/a.ts:12)', sink: '`db.raw` (src/db/repo.ts:101)', loc: 'src/db/repo.ts:101' }));
  w(root, 'findings/finding-ssrf-001/description.md', finding('ssrf', 'SSRF in d', {
    severity: 'high', confidence: 'high', privilege: 'none',
    src: '`req.body.y` (src/web/d.ts:40)', sink: '`axios.get` (src/http/fetch.ts:12)', loc: 'src/http/fetch.ts:12', slot: 'URL-host', cwe: 'CWE-918' }));
  w(root, 'plan/_meta.json', JSON.stringify({ engagement: 'fx-2', repo: '/tmp/fx', commit: 'def5678', date: '2026-02-01', metadata: {} }));
  py('aggregate.py', [root, '--write', '--meta', 'plan/_meta.json', '--previous', prevReport], root);
  const r = JSON.parse(readFileSync(path.join(root, 'codeaudit-report.json'), 'utf8'));
  const by = Object.fromEntries(r.findings.map((f) => [f.id, f]));
  assert.equal(by['finding-inj-001'].change, 'persisting');
  assert.equal(by['finding-inj-001'].first_seen, '2026-01-01', 'first_seen is inherited from the previous report date');
  assert.equal(by['finding-inj-001'].previous_id, 'finding-inj-001');
  assert.equal(by['finding-ssrf-001'].change, 'new');
  assert.equal(by['finding-ssrf-001'].first_seen, '2026-02-01');
  assert.deepEqual(r.run_diff.new, ['finding-ssrf-001']);
  assert.deepEqual(r.run_diff.persisting, ['finding-inj-001']);
  assert.equal(r.run_diff.not_refound.length, 1);
  assert.equal(r.run_diff.not_refound[0].id, 'finding-ac-001');
  assert.equal(r.run_diff.previous_engagement, 'fx');
  assert.match(r.run_diff.note, /never a list of fixes/);

  // a previous report written before fingerprints existed is recomputed, not rejected
  const legacy = JSON.parse(readFileSync(prevReport, 'utf8'));
  for (const f of legacy.findings) delete f.fingerprint;
  writeFileSync(prevReport, JSON.stringify(legacy));
  py('aggregate.py', [root, '--write', '--meta', 'plan/_meta.json', '--previous', prevReport], root);
  const r2 = JSON.parse(readFileSync(path.join(root, 'codeaudit-report.json'), 'utf8'));
  assert.deepEqual(r2.run_diff.persisting, ['finding-inj-001']);
  assert.ok(!r2.contract_violations.some((v) => v.where === 'previous'));
  rmSync(prevRoot, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true });
});

test('--accepted: an accepted risk stays listed with its reason, leaves the tally, and an unmatched entry is reported', () => {
  const root = fixture();
  py('aggregate.py', [root, '--write', '--meta', 'plan/_meta.json'], root);
  const r0 = JSON.parse(readFileSync(path.join(root, 'codeaudit-report.json'), 'utf8'));
  const fp = r0.findings.find((f) => f.id === 'finding-ac-001').fingerprint;
  w(root, '.codeaudit-accepted.json', JSON.stringify({ accepted: [
    { fingerprint: fp, reason: 'object ids are unguessable UUIDs; tracked in SEC-42', by: 'security lead', date: '2026-01-15' },
    { fingerprint: 'fp_0000000000000000', reason: 'stale entry' },
    { reason: 'no fingerprint at all' },
  ] }));
  py('aggregate.py', [root, '--write', '--meta', 'plan/_meta.json', '--accepted', '.codeaudit-accepted.json'], root);
  const r = JSON.parse(readFileSync(path.join(root, 'codeaudit-report.json'), 'utf8'));
  const ac = r.findings.find((f) => f.id === 'finding-ac-001');
  assert.equal(ac.status, 'accepted-risk');
  assert.equal(ac.accepted.by, 'security lead');
  assert.equal(ac.severity, 'low', 'the rating is kept — acceptance is a decision, not a re-assessment');
  // without --relations there is no class-owner override: inj-001 is critical, capped to high by `authenticated`
  assert.deepEqual(r.summary, { informational: 0, low: 0, medium: 0, high: 1, critical: 0, total: 1, accepted_risk: 1 });
  assert.deepEqual(r.aggregation_stats.accepted_unmatched, ['fp_0000000000000000']);
  assert.ok(r.contract_violations.some((v) => v.where === 'accepted' && /lacks fingerprint/.test(v.issue)));
  rmSync(root, { recursive: true, force: true });
});

test('--previous + --accepted: a risk accepted last run but not covered now is a recorded violation', () => {
  const prevRoot = fixture();
  py('aggregate.py', [prevRoot, '--write', '--meta', 'plan/_meta.json'], prevRoot);
  const prev = JSON.parse(readFileSync(path.join(prevRoot, 'codeaudit-report.json'), 'utf8'));
  prev.findings.find((f) => f.id === 'finding-ac-001').status = 'accepted-risk';
  writeFileSync(path.join(prevRoot, 'codeaudit-report.json'), JSON.stringify(prev));
  const root = fixture();
  py('aggregate.py', [root, '--write', '--meta', 'plan/_meta.json', '--previous', path.join(prevRoot, 'codeaudit-report.json')], root);
  const r = JSON.parse(readFileSync(path.join(root, 'codeaudit-report.json'), 'utf8'));
  assert.ok(r.contract_violations.some((v) => v.where === 'finding-ac-001' && /accepted-risk in the previous report/.test(v.issue)));
  assert.equal(r.findings.find((f) => f.id === 'finding-ac-001').status, 'open', 'acceptance is never inherited silently');
  rmSync(prevRoot, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true });
});

test('render: run diff, skipped register, fingerprints and accepted risks reach every deliverable', () => {
  const prevRoot = fixture();
  py('aggregate.py', [prevRoot, '--write', '--meta', 'plan/_meta.json'], prevRoot);
  const root = fixture();
  rmSync(path.join(root, 'findings/finding-ac-001'), { recursive: true });
  w(root, 'findings/finding-ssrf-001/description.md', finding('ssrf', 'SSRF in d', {
    severity: 'high', confidence: 'high', privilege: 'none',
    src: '`req.body.y` (src/web/d.ts:40)', sink: '`axios.get` (src/http/fetch.ts:12)', loc: 'src/http/fetch.ts:12', slot: 'URL-host', cwe: 'CWE-918' }));
  py('aggregate.py', [root, '--write', '--meta', 'plan/_meta.json'], root);
  const fpInj = JSON.parse(readFileSync(path.join(root, 'codeaudit-report.json'), 'utf8')).findings.find((f) => f.id === 'finding-inj-001').fingerprint;
  w(root, '.codeaudit-accepted.json', JSON.stringify({ accepted: [{ fingerprint: fpInj, reason: 'legacy admin tool, retired next quarter', by: 'CTO', date: '2026-01-20' }] }));
  py('aggregate.py', [root, '--write', '--meta', 'plan/_meta.json', '--relations', 'plan/_relations.json',
    '--previous', path.join(prevRoot, 'codeaudit-report.json'), '--accepted', '.codeaudit-accepted.json'], root);
  py('render.py', [root], root);
  const md = readFileSync(path.join(root, 'report.md'), 'utf8');
  assert.ok(md.includes('## Changes Since Previous Run'));
  assert.ok(md.includes('**1 new**, **1 persisting**, **1 not re-found**'));
  assert.ok(md.includes('Not re-found (verify before calling any of these fixed)'));
  assert.ok(md.includes('## Paths an Auditor Did Not Fully Analyse'));
  assert.ok(md.includes('`src/legacy/exploit-samples.ts`'));
  assert.ok(md.includes('**Status:** accepted-risk — legacy admin tool, retired next quarter (by CTO, 2026-01-20)'));
  assert.ok(md.includes('| accepted risk (listed, excluded from the tally) | 1 |'));
  assert.ok(md.includes('**Change:** new since the previous run'));
  assert.match(md, /\*\*Fingerprint:\*\* `fp_[0-9a-f]{16}`/);
  const csv = readFileSync(path.join(root, 'findings.csv'), 'utf8').split('\n');
  assert.ok(csv[0].startsWith('id,fingerprint,status,change,first_seen,'));
  const sarif = JSON.parse(readFileSync(path.join(root, 'codeaudit.sarif'), 'utf8'));
  const inj = sarif.runs[0].results.find((x) => x.partialFingerprints['codeaudit/id'] === 'finding-inj-001');
  assert.equal(inj.partialFingerprints['codeaudit/fingerprint'], fpInj);
  assert.equal(inj.baselineState, 'unchanged');
  assert.equal(inj.suppressions[0].kind, 'external');
  const ssrf = sarif.runs[0].results.find((x) => x.partialFingerprints['codeaudit/id'] === 'finding-ssrf-001');
  assert.equal(ssrf.baselineState, 'new');
  assert.ok(!ssrf.suppressions);
  rmSync(prevRoot, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true });
});

function verification(verdict, { disposition = 'none', cited = 'none', sev = 'none', conf = 'none', reasoning = 'Rebuilt the path; the guard is on the same variable.' } = {}) {
  return `# Verification — x
**Verdict**: ${verdict}
**Disposition**: ${disposition}
**Cited**: ${cited}
**Adjusted severity**: ${sev}
**Adjusted confidence**: ${conf}
**Verifier**: finding-verifier (batch v1)

## Reasoning
${reasoning}

## Rebuilt trace
src/handlers/a.ts:10 → src/db/repo.ts:99
`;
}

test('verification: confirmed adjusts, uncertain demotes, refuted leaves findings[] into tested_not_vulnerable + refuted[]', () => {
  const root = fixture();
  // inj-001: confirmed with a severity correction down to high and confidence held
  w(root, 'findings/finding-inj-001/verification.md', verification('confirmed', { sev: 'high', reasoning: 'Rebuilt; reachable only after login, so critical overstates it.' }));
  // ac-001: refuted with a cited guard
  w(root, 'findings/finding-ac-001/verification.md', verification('refuted', { disposition: 'guard_present', cited: 'src/mw/auth.ts:9', reasoning: 'ownerId is compared to the session principal at auth.ts:9 before findById.' }));
  // xss-001 is unconfirmed anyway; give it an uncertain verdict to check it stays out of findings[]
  w(root, 'findings/finding-xss-001/verification.md', verification('uncertain'));
  py('aggregate.py', [root, '--write', '--meta', 'plan/_meta.json', '--verified-min', 'high'], root);
  const r = JSON.parse(readFileSync(path.join(root, 'codeaudit-report.json'), 'utf8'));
  const by = Object.fromEntries(r.findings.map((f) => [f.id, f]));

  assert.equal(by['finding-inj-001'].revalidation.verdict, 'confirmed');
  assert.equal(by['finding-inj-001'].severity, 'high');
  assert.equal(by['finding-inj-001'].severity_revision.by, 'finding-verifier (batch v1)');
  assert.equal(by['finding-inj-001'].severity_revision.from, 'critical');
  assert.equal(by['finding-inj-001'].severity_cap_applied, null, 'the verifier brought it below the authenticated cap');

  assert.ok(!by['finding-ac-001'], 'a cited refutation removes the finding');
  assert.equal(r.refuted.length, 1);
  assert.equal(r.refuted[0].id, 'finding-ac-001');
  assert.equal(r.refuted[0].cited, 'src/mw/auth.ts:9');
  const tnv = r.tested_not_vulnerable.find((t) => t.refuted_finding === 'finding-ac-001');
  assert.equal(tnv.disposition, 'guard_present');
  assert.match(tnv.detail, /refuted by independent verification/);
  assert.deepEqual(r.summary, { informational: 0, low: 0, medium: 0, high: 1, critical: 0, total: 1, accepted_risk: 0 });
  assert.equal(r.aggregation_stats.verified, 2, 'inj-001 + ac-001 (xss-001 never reached findings[])');
  assert.equal(r.aggregation_stats.refuted, 1);
  assert.equal(r.aggregation_stats.unverified_at_or_above_min, 0);
  rmSync(root, { recursive: true, force: true });
});

test('verification: an uncited refutation is downgraded to uncertain, demotes high→probable, and is a violation', () => {
  const root = fixture();
  w(root, 'findings/finding-inj-001/verification.md', verification('refuted', { reasoning: 'Looks parameterised to me.' }));
  py('aggregate.py', [root, '--write', '--meta', 'plan/_meta.json'], root);
  const r = JSON.parse(readFileSync(path.join(root, 'codeaudit-report.json'), 'utf8'));
  const inj = r.findings.find((f) => f.id === 'finding-inj-001');
  assert.ok(inj, 'the finding stays');
  assert.equal(inj.revalidation.verdict, 'uncertain');
  assert.equal(inj.confidence, 'probable');
  assert.match(inj.confidence_note, /verifier uncertain/);
  assert.equal(r.refuted.length, 0);
  assert.ok(r.contract_violations.some((v) => v.where === 'finding-inj-001' && /refutes without/.test(v.issue)));
  rmSync(root, { recursive: true, force: true });
});

test('verification: --verified-min flags an unverified high finding; a verification_overrides entry reinstates a refuted one', () => {
  const root = fixture();
  w(root, 'findings/finding-ac-001/verification.md', verification('refuted', { disposition: 'not_attacker_controlled', cited: 'src/mw/auth.ts:9', reasoning: 'id comes from a server enum.' }));
  const relp = path.join(root, 'plan/_relations.json');
  const rel = JSON.parse(readFileSync(relp, 'utf8'));
  rel.orchestrator_adjustments.verification_overrides = [
    { id: 'finding-ac-001', reason: 'the "enum" at auth.ts:9 is filled from req.body upstream (users.ts:30)', by: 'orchestrator', evidence: 'src/api/users.ts:30' },
    { id: 'finding-inj-001', reason: 'not refuted at all', by: 'orchestrator' },
  ];
  writeFileSync(relp, JSON.stringify(rel));
  py('aggregate.py', [root, '--write', '--meta', 'plan/_meta.json', '--relations', 'plan/_relations.json', '--verified-min', 'high'], root);
  const r = JSON.parse(readFileSync(path.join(root, 'codeaudit-report.json'), 'utf8'));
  const by = Object.fromEntries(r.findings.map((f) => [f.id, f]));
  assert.ok(by['finding-ac-001'], 'reinstated');
  assert.equal(by['finding-ac-001'].revalidation.verdict, 'uncertain');
  assert.match(by['finding-ac-001'].revalidation.overridden.reason, /req\.body upstream/);
  assert.equal(r.refuted.length, 0);
  assert.ok(r.contract_violations.some((v) => v.where === 'finding-inj-001' && /not refuted/.test(v.issue)));
  // inj-001 ends at medium (class-owner override in the fixture) so it is below the high threshold; raise it to check the gap
  const gap = r.coverage_gaps.filter((g) => g.kind === 'unverified');
  assert.equal(gap.length, 0, 'nothing open at/above high is unverified in this fixture');
  const rel2 = JSON.parse(readFileSync(relp, 'utf8')); rel2.orchestrator_adjustments.severity_overrides = []; rel2.orchestrator_adjustments.verification_overrides = [];
  writeFileSync(relp, JSON.stringify(rel2));
  py('aggregate.py', [root, '--write', '--meta', 'plan/_meta.json', '--relations', 'plan/_relations.json', '--verified-min', 'high'], root);
  const r2 = JSON.parse(readFileSync(path.join(root, 'codeaudit-report.json'), 'utf8'));
  const gap2 = r2.coverage_gaps.filter((g) => g.kind === 'unverified');
  assert.equal(gap2.length, 1);
  assert.match(gap2[0].item, /^finding-inj-001/);
  assert.equal(r2.aggregation_stats.unverified_at_or_above_min, 1);
  rmSync(root, { recursive: true, force: true });
});

test('render: verification reaches the report, the CSV and SARIF', () => {
  const root = fixture();
  w(root, 'findings/finding-inj-001/verification.md', verification('confirmed'));
  w(root, 'findings/finding-ac-001/verification.md', verification('refuted', { disposition: 'guard_present', cited: 'src/mw/auth.ts:9', reasoning: 'compared to the session principal at auth.ts:9.' }));
  py('aggregate.py', [root, '--write', '--meta', 'plan/_meta.json', '--relations', 'plan/_relations.json'], root);
  py('render.py', [root], root);
  const md = readFileSync(path.join(root, 'report.md'), 'utf8');
  assert.ok(md.includes('## Refuted by Independent Verification'));
  assert.ok(md.includes('`finding-ac-001` (access-control, filed low)'));
  assert.ok(md.includes('- **Independent verification:** confirmed —'));
  assert.ok(md.includes('Independent verification: 2 verdicts'));
  const csv = readFileSync(path.join(root, 'findings.csv'), 'utf8').split('\n');
  assert.ok(csv[0].includes(',verification,'));
  assert.ok(csv[1].includes(',confirmed,'));
  const sarif = JSON.parse(readFileSync(path.join(root, 'codeaudit.sarif'), 'utf8'));
  assert.equal(sarif.runs[0].results.length, 1, 'the refuted finding is not a SARIF result');
  assert.equal(sarif.runs[0].results[0].properties.codeaudit.verification, 'confirmed');
  rmSync(root, { recursive: true, force: true });
});

test('reconcile: a route-less module reconciles its exported_surface sources, not "nothing to check"', () => {
  const root = fixture();
  w(root, 'recon/sink-inventory.json', JSON.stringify({
    entry_points: [],
    exported_surface: [
      { name: 'currentUser', handler: 'auth.js:4', sources: [{ in: 'header', name: 'authorization', at: 'auth.js:5' }] },
      { name: 'isAdmin', handler: 'auth.js:13', sources: [{ in: 'header', name: 'authorization', at: 'auth.js:14' }] },
    ],
  }));
  w(root, 'findings/_safe-auth.md', '# Evidence — auth-auditor\n\n## tested_not_vulnerable\n- [guard_present] auth.js:5 verify path fails closed (auth.js:7)\n\n## design_properties\n- none\n\n## unverified_assumptions\n- none\n\n## coverage_gaps\n- none\n');
  const out = JSON.parse(py('reconcile.py', [root, '--json'], root));
  assert.equal(out.by_status['line-cited'], 1, 'auth.js:5');
  assert.equal((out.by_status['file-cited'] ?? 0) + (out.by_status['uncited'] ?? 0), 1, 'auth.js:14 is enumerated too');
  rmSync(root, { recursive: true, force: true });
});

/** A small polyglot repo for the recon-coverage gate: four Express route files in src/api, a worker, helpers. */
function repoFixture() {
  const repo = mkdtempSync(path.join(tmpdir(), 'codeaudit-repo-'));
  for (const n of ['users', 'orders', 'billing', 'admin']) {
    w(repo, `src/api/${n}.js`, `const r = require('express').Router();\nr.get('/${n}', (req, res) => res.json([]));\nmodule.exports = r;\n`);
  }
  w(repo, 'src/workers/mailer.js', `const { Worker } = require('bullmq');\nnew Worker('mail', async (job) => send(job.data));\n`);
  w(repo, 'src/lib/util.js', 'module.exports = { add: (a, b) => a + b };\n');
  w(repo, 'src/api/users.test.js', "r.get('/x', () => {});\n");                 // ignored: test file
  w(repo, 'vendor/thing.js', "app.get('/vendored', () => {});\n");             // ignored: vendored
  w(repo, 'README.md', '# svc\n');
  return repo;
}

test('recon-coverage: a whole route family missed by recon fails the gate; covering it passes with the residue listed', () => {
  const repo = repoFixture();
  const out = mkdtempSync(path.join(tmpdir(), 'codeaudit-cov-'));
  const run = (inv) => {
    w(out, 'recon/sink-inventory.json', JSON.stringify(inv));
    let code = 0, text = '';
    try { text = py('recon-coverage.py', [out, '--repo', repo, '--json'], out); } catch (e) { code = e.status; text = e.stdout; }
    return { code, r: JSON.parse(text) };
  };
  // recon saw only the worker: the whole src/api family is missing → FAIL
  let { code, r } = run({ entry_points: [], exported_surface: [{ name: 'mailer', handler: 'src/workers/mailer.js:2', sources: [{ in: 'json', name: 'job.data', at: 'src/workers/mailer.js:2' }] }] });
  assert.equal(code, 1);
  assert.equal(r.route_shaped_files, 5, '4 api files + the worker; test and vendored files are not counted');
  assert.equal(r.covered, 1);
  assert.ok(r.failures.some((f) => /src\/api\/ — 4 route-shaped files, none/.test(f)));
  assert.ok(r.failures.some((f) => /overall: 1\/5/.test(f)));
  assert.ok(existsSync(path.join(out, 'recon/_coverage.json')));

  // recon covers three of the four api files + the worker → PASS, one uncovered file listed by directory
  ({ code, r } = run({ entry_points: ['users', 'orders', 'billing'].map((n) => ({ method: 'GET', path: `/${n}`, handler: `${n} (src/api/${n}.js:2)`, sources: [{ in: 'query', name: 'q', at: `src/api/${n}.js:2` }] })),
    exported_surface: [{ name: 'mailer', handler: 'src/workers/mailer.js:2', sources: [] }] }));
  assert.equal(code, 0);
  assert.equal(r.passed, true);
  assert.deepEqual(r.uncovered.map((u) => u.file), ['src/api/admin.js']);
  assert.equal(r.families['src/api'].covered, 3);

  // handler paths given absolute (under the repo) still match
  ({ code, r } = run({ entry_points: ['users', 'orders', 'billing', 'admin'].map((n) => ({ handler: `${path.join(repo, 'src/api', n + '.js')}:2`, sources: [] })),
    exported_surface: [{ handler: 'src/workers/mailer.js:2', sources: [] }] }));
  assert.equal(r.covered, 5);
  assert.equal(r.uncovered.length, 0);

  // no inventory at all is a failed gate, not a crash
  rmSync(path.join(out, 'recon/sink-inventory.json'));
  let code2 = 0;
  try { py('recon-coverage.py', [out, '--repo', repo], out); } catch (e) { code2 = e.status; }
  assert.equal(code2, 1);
  rmSync(repo, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true });
});

test('recon-coverage: out_of_scope directories are excluded and a silent language is a warning, not a failure', () => {
  const repo = repoFixture();
  for (let i = 0; i < 20; i++) w(repo, `svc/py/m${i}.py`, 'def helper(x):\n    return x\n');   // python with no route markers
  const out = mkdtempSync(path.join(tmpdir(), 'codeaudit-cov-'));
  w(out, 'recon/sink-inventory.json', JSON.stringify({ entry_points: [], exported_surface: [{ handler: 'src/workers/mailer.js:2', sources: [] }] }));
  let text = '';
  try { text = py('recon-coverage.py', [out, '--repo', repo, '--out-of-scope', 'src/api,docs', '--json'], out); } catch (e) { text = e.stdout; }
  const r = JSON.parse(text);
  assert.equal(r.route_shaped_files, 1, 'src/api is out of scope; only the worker remains');
  assert.equal(r.passed, true);
  assert.ok(r.warnings.some((w_) => /^python: 20 source files and no route-shaped marker/.test(w_)));
  rmSync(repo, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true });
});

const CONTEXT = `# Audit context — fx
<!-- codeaudit-context v1 — operator-owned. -->

## What this codebase does
A small API that lists users and lets admins edit them.

## Auth shape
- requireUser middleware on every /api route
- isAdmin() role check from the verified session

## Trust boundaries and adversaries
- anonymous network peers reach /api/users only
- the ops team edits config; not an adversary here

## Project-specific patterns to flag
- raw() query builder in src/db — only safe with allowlisted identifiers

## Known non-findings
- [by_design] public read endpoints are intentionally unauthenticated (docs/api.md:3)
`;

test('context: check validates the contract; propose turns the run into Known non-findings; apply is idempotent', () => {
  const root = fixture();
  const ctx = path.join(root, '.codeaudit-context.md');
  writeFileSync(ctx, CONTEXT);
  assert.match(py('context.py', ['check', ctx], root), /^ok:/);

  // a file with a leftover seed placeholder and a missing heading fails check
  writeFileSync(path.join(root, 'bad.md'), CONTEXT.replace('## Auth shape', '## Auth').replace('A small API', 'One paragraph: {what}'));
  let code = 0, out = '';
  try { out = py('context.py', ['check', path.join(root, 'bad.md')], root); } catch (e) { code = e.status; out = e.stdout; }
  assert.equal(code, 1);
  assert.match(out, /missing heading: ## Auth shape/);
  assert.match(out, /placeholder still present/);

  // a report with a design property (already in the file), an accepted risk, and a version-gated rule-out
  py('aggregate.py', [root, '--write', '--meta', 'plan/_meta.json'], root);
  const r0 = JSON.parse(readFileSync(path.join(root, 'codeaudit-report.json'), 'utf8'));
  const fp = r0.findings.find((f) => f.id === 'finding-ac-001').fingerprint;
  w(root, '.codeaudit-accepted.json', JSON.stringify({ accepted: [{ fingerprint: fp, reason: 'ids are UUIDs', by: 'lead', date: '2026-01-15' }] }));
  w(root, 'findings/_safe-auth.md', '# Evidence — auth-auditor\n\n## tested_not_vulnerable\n- [guard_present] jwt.verify without algorithms is safe on jsonwebtoken 9.0.2 (package-lock.json:9) ≥ 9.0.0 cutoff (src/auth.ts:7)\n\n## design_properties\n- none\n\n## unverified_assumptions\n- none\n\n## coverage_gaps\n- none\n');
  py('aggregate.py', [root, '--write', '--meta', 'plan/_meta.json', '--accepted', '.codeaudit-accepted.json'], root);
  const prop = JSON.parse(py('context.py', ['propose', root, '--context', ctx, '--json'], root));
  assert.equal(prop.additions.length, 2, 'the design property already in the file is skipped');
  assert.ok(prop.additions.some((l) => l.startsWith('- [accepted-risk] IDOR on b at src/db/repo.ts — ids are UUIDs')));
  assert.ok(prop.additions.some((l) => l.startsWith('- [version-gated] jwt.verify without algorithms')));
  assert.ok(existsSync(path.join(root, 'plan/_context-additions.md')));

  assert.match(py('context.py', ['apply', root, '--context', ctx], root), /appended 2 line/);
  const after = readFileSync(ctx, 'utf8');
  assert.ok(after.includes('- [accepted-risk] IDOR on b'));
  assert.ok(after.indexOf('## Known non-findings') < after.indexOf('- [accepted-risk]'));
  assert.ok(after.includes('- [by_design] public read endpoints'), 'existing lines untouched');
  assert.match(py('context.py', ['apply', root, '--context', ctx], root), /appended 0 line/);
  assert.match(py('context.py', ['check', ctx], root), /^ok:/);
  rmSync(root, { recursive: true, force: true });
});

test('render: produces the five deliverables from the report and the narrative', () => {
  const root = fixture();
  py('aggregate.py', [root, '--write', '--relations', 'plan/_relations.json', '--meta', 'plan/_meta.json'], root);
  py('render.py', [root], root);
  for (const f of ['report.md', 'exec-summary.md', 'remediation-plan.md', 'findings.csv', 'codeaudit.sarif']) {
    assert.ok(existsSync(path.join(root, f)), f);
  }
  const md = readFileSync(path.join(root, 'report.md'), 'utf8');
  for (const h of ['## Executive Summary', '## Findings by Severity', '## Vectors Tested — Not Vulnerable', '## Related & Chained Findings',
    '## Design Properties — Intentional Behaviour', '## Unverified Assumptions — Not Decidable From Source', '## Coverage Gaps & Recommendations', '## Appendix — Methodology & Scope']) {
    assert.ok(md.includes(h), h);
  }
  assert.ok(md.includes('### [MEDIUM] SQLi in a'), 'override severity is what the reader sees');
  assert.ok(md.includes('**Severity revision:** critical → medium'));
  assert.ok(md.includes('**Additional locations (1, same root cause):**'));
  const sarif = JSON.parse(readFileSync(path.join(root, 'codeaudit.sarif'), 'utf8'));
  assert.equal(sarif.runs[0].results.length, 2);
  const ac = sarif.runs[0].results.find((x) => x.partialFingerprints['codeaudit/id'] === 'finding-ac-001');
  assert.equal(ac.relatedLocations.length, 1);
  const csv = readFileSync(path.join(root, 'findings.csv'), 'utf8').trim().split('\n');
  assert.equal(csv.length, 3, 'header + 2 findings');
  rmSync(root, { recursive: true, force: true });
});

test('render: a missing narrative degrades to visible TODO markers, never to a crash or a silent blank', () => {
  const root = fixture();
  rmSync(path.join(root, 'plan/_narrative.json'));
  py('aggregate.py', [root, '--write', '--meta', 'plan/_meta.json'], root);
  py('render.py', [root], root);
  const md = readFileSync(path.join(root, 'report.md'), 'utf8');
  assert.ok(md.includes('TODO-ORCHESTRATOR'));
  rmSync(root, { recursive: true, force: true });
});
