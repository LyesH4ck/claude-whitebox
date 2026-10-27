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

## coverage_gaps
- src/workers/*.ts — dynamic dispatch not traced → recommended: trace consumers
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
  assert.deepEqual(r.summary, { informational: 0, low: 1, medium: 1, high: 0, critical: 0, total: 2 });

  // evidence arrays: disposition enum enforced (missing → model_gap + violation), both halves of an assumption
  const tnv = r.tested_not_vulnerable;
  assert.equal(tnv.length, 2);
  assert.equal(tnv[0].disposition, 'guard_present');
  assert.equal(tnv[1].disposition, 'model_gap');
  assert.ok(r.contract_violations.some((v) => /without a valid \[disposition\]/.test(v.issue)));
  assert.ok(r.contract_violations.some((v) => /evidence needed/.test(v.issue)), 'the bare shrug is a violation');
  assert.equal(r.unverified_assumptions[0].evidence_needed, 'the deployed WAF body-size rule');
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
