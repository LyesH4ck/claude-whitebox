#!/usr/bin/env node
// Deterministic judge for codeaudit eval scenarios.
//
// An eval scenario is a fixture (a tiny repo with a KNOWN planted bug and a KNOWN safe sibling) plus a set
// of assertions about the report an audit of that fixture must produce. This file does the judging only —
// it never runs an audit. Run the audit yourself against a fixture, then point the judge at its report.
//
//   node judge.mjs --scenario scenarios/csrf-state-changing-get.eval.json \
//                  --report  outputs/eval-csrf/codeaudit-report.json \
//                  [--findings-dir outputs/eval-csrf/findings] [--json]
//
// Exit 0 = every assertion satisfied. Exit 1 = at least one failed. Exit 2 = harness error (bad input).
//
// Design notes:
// - Zero dependencies. Scenarios are JSON, not YAML, because this repo's test harness has no YAML parser
//   and a hand-rolled one would be a bug farm. Less pretty, unambiguous.
// - The report is UNTRUSTED input: it is model-authored and may be truncated, malformed, or contain
//   garbage elements. Nothing here may throw on bad data — a malformed finding is counted, not fatal.
// - Assertions are a MINIMUM BAR. Extra findings do not fail a scenario unless they match should_not_find
//   or must_not_contain. This keeps evals stable as the plugin legitimately finds more.

import { readFileSync, existsSync, readdirSync, statSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DISPOSITIONS = new Set(['guard_present', 'not_attacker_controlled', 'not_reachable', 'by_design',
  'precondition_subsumes', 'model_gap', 'out_of_model_adversary', 'out_of_model_component',
  'out_of_model_non_default_build']);

const SEVERITY_ORDER = ['informational', 'low', 'medium', 'high', 'critical'];

// Words that appear in (nearly) EVERY finding because they are enum values the report contract requires:
// severity, confidence, status, privilege_required, endpoint.in. A negative assertion keyed on one of these
// matches the scenario's own true positive, so the judge reports FALSE POSITIVE against a correct audit.
// `none` is the one that actually bit: it is the privilege_required value for an unauthenticated finding.
const UBIQUITOUS_TERMS = new Set([
  'informational', 'low', 'medium', 'high', 'critical',
  'probable', 'unconfirmed', 'open', 'remediated', 'accepted-risk',
  'none', 'authenticated', 'admin', 'maintainer', 'local-root',
  'query', 'path', 'header', 'cookie', 'json', 'form',
  'source', 'sink', 'trace', 'finding', 'severity', 'cwe', 'owasp',
]);
const MIN_NEGATIVE_TERM = 4;

/**
 * Negative assertions (`should_not_find`, `must_not_contain`) are matched against the SAME wide text as
 * positive ones, so a term that is short or ubiquitous silently inverts the test: it fires on the finding
 * the scenario wanted. Positive assertions are not linted — over-matching there only makes them easier to
 * satisfy, which is visible, whereas over-matching on a negative fails a correct run.
 */
export function lintNegativeTerms(scenario) {
  const errs = [];
  const check = (term, where) => {
    const t = String(term || '').toLowerCase().trim();
    if (!t) { errs.push(`${where}: empty term`); return; }
    if (t.length < MIN_NEGATIVE_TERM) {
      errs.push(`${where}: "${term}" is ${t.length} chars — too short to discriminate ` +
        `(e.g. "alg" matches the word "algorithms"). Use >= ${MIN_NEGATIVE_TERM} chars and a term that ` +
        `can ONLY appear if the thing you are forbidding happened.`);
    } else if (UBIQUITOUS_TERMS.has(t)) {
      errs.push(`${where}: "${term}" is a report-contract enum value present in nearly every finding ` +
        `(severity/confidence/status/privilege_required/endpoint.in). A negative assertion on it fires on ` +
        `the scenario's own true positive and reports a false positive against a correct audit.`);
    }
  };
  for (const c of scenario.should_not_find ?? []) {
    for (const t of c.evidence_contains ?? []) check(t, 'should_not_find.evidence_contains');
  }
  for (const t of scenario.must_not_contain ?? []) check(t, 'must_not_contain');
  return errs;
}

// ---------------------------------------------------------------- helpers

const low = (v) => (typeof v === 'string' ? v.toLowerCase() : '');

/** Normalise a path for comparison: forward slashes, no leading ./ */
export function normPath(p) {
  if (typeof p !== 'string') return '';
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** A finding's file path, tolerating both {location:{file}} and a bare "file:line" string. */
export function findingPath(f) {
  if (f?.location && typeof f.location === 'object') return normPath(f.location.file);
  if (typeof f?.location === 'string') return normPath(f.location.split(':')[0]);
  return '';
}

/**
 * Every text the judge will search for `evidence_contains` terms. Deliberately wide: the same fact can
 * legitimately land in the trace, the sink expression or the prose, and an eval that only looked at the
 * title would fail a correct report for cosmetic reasons.
 */
export function findingText(f, extra = '') {
  const parts = [f?.title, f?.source, f?.sink, f?.slot_type, f?.vuln_class, f?.cwe, f?.owasp,
    f?.witness_payload, f?.prior_art, f?.write_site, f?.privilege_required,
    typeof f?.location === 'string' ? f.location : `${f?.location?.file ?? ''}:${f?.location?.line ?? ''}`];
  if (Array.isArray(f?.trace)) parts.push(f.trace.join(' '));
  if (Array.isArray(f?.locations)) parts.push(f.locations.join(' '));
  if (f?.endpoint) parts.push(`${f.endpoint.method ?? ''} ${f.endpoint.path ?? ''} ${f.endpoint.param ?? ''}`);
  return (parts.filter((x) => typeof x === 'string').join(' \n ') + ' \n ' + extra).toLowerCase();
}

/**
 * The subset of a finding that says WHAT WAS REPORTED, excluding narrative fields and the description.md
 * body. Negative assertions match against this, positive ones against the full text.
 *
 * Why the asymmetry: a `should_not_find` asks "was a finding filed about the safe sibling?", which is a
 * question about the finding's identity — its title, location, source and sink. It is NOT a question about
 * what the write-up discusses. The plugin's own rules require contrastive reasoning (`prior_art` must say
 * why the version-fixed pattern is NOT a finding), so a correct report mentions the safe sibling by name
 * while filing nothing against it. Searching the narrative for a negative scored that discipline as a false
 * positive — punishing the audit for explaining itself. A positive assertion has the opposite failure mode:
 * over-matching only makes it easier to satisfy, which is visible, so it keeps the wide text.
 */
export function findingIdentity(f) {
  const parts = [f?.title, f?.vuln_class, f?.cwe, f?.slot_type, f?.source, f?.sink,
    typeof f?.location === 'string' ? f.location : `${f?.location?.file ?? ''}:${f?.location?.line ?? ''}`];
  if (Array.isArray(f?.locations)) parts.push(f.locations.join(' '));
  if (f?.endpoint) parts.push(`${f.endpoint.method ?? ''} ${f.endpoint.path ?? ''} ${f.endpoint.param ?? ''}`);
  return parts.filter((x) => typeof x === 'string').join(' \n ').toLowerCase();
}

/** Does one finding satisfy one criteria object? Unspecified criteria are not constraints. */
export function matchFinding(f, c, text) {
  if (!f || typeof f !== 'object') return false;
  if (c.vuln_class && low(f.vuln_class) !== low(c.vuln_class)) return false;
  if (c.cwe && low(f.cwe) !== low(c.cwe)) return false;
  if (c.slot_type && low(f.slot_type) !== low(c.slot_type)) return false;
  if (c.privilege_required && low(f.privilege_required) !== low(c.privilege_required)) return false;
  if (c.path) {
    const fp = findingPath(f), want = normPath(c.path);
    if (!fp || !(fp === want || fp.endsWith('/' + want) || fp.includes(want))) return false;
  }
  if (c.title_contains && !low(f.title).includes(low(c.title_contains))) return false;
  if (c.min_severity) {
    const have = SEVERITY_ORDER.indexOf(low(f.severity));
    const need = SEVERITY_ORDER.indexOf(low(c.min_severity));
    if (have < 0 || need < 0 || have < need) return false;
  }
  for (const term of c.evidence_contains ?? []) {
    if (!text.includes(low(term))) return false;
  }
  return true;
}

/** Does one tested_not_vulnerable entry satisfy a should_rule_out criteria object? */
export function matchRuleOut(e, c) {
  if (!e || typeof e !== 'object') return false;
  if (c.vuln_class && low(e.vuln_class) !== low(c.vuln_class)) return false;
  if (c.disposition && low(e.disposition) !== low(c.disposition)) return false;
  const text = low([e.detail, e.vuln_class, e.disposition].filter((x) => typeof x === 'string').join(' '));
  if (c.path && !text.includes(normPath(c.path).toLowerCase())) return false;
  for (const term of c.evidence_contains ?? []) if (!text.includes(low(term))) return false;
  return true;
}

// ---------------------------------------------------------------- loading

export function loadScenario(file) {
  const s = JSON.parse(readFileSync(file, 'utf8'));
  const errs = [];
  if (!s.name) errs.push('missing "name"');
  if (!s.given) errs.push('missing "given" (one line saying what this fixture plants)');
  if (!s.fixture) errs.push('missing "fixture"');
  const lists = ['should_find', 'should_not_find', 'should_rule_out'];
  if (!lists.some((k) => Array.isArray(s[k]) && s[k].length)) {
    errs.push(`a scenario asserts nothing: needs at least one of ${lists.join(', ')}`);
  }
  for (const k of [...lists, 'must_not_contain']) {
    if (s[k] !== undefined && !Array.isArray(s[k])) errs.push(`"${k}" must be an array`);
  }
  for (const c of s.should_rule_out ?? []) {
    if (c?.disposition && !DISPOSITIONS.has(c.disposition)) {
      errs.push(`should_rule_out uses disposition "${c.disposition}", which is not in the report contract`);
    }
  }
  errs.push(...lintNegativeTerms(s));
  if (errs.length) throw new Error(`${path.basename(file)}: ${errs.join('; ')}`);
  return s;
}

/** Read the per-finding description.md bodies so evidence terms can match the depth layer too. */
function readFindingBodies(dir) {
  const out = new Map();
  if (!dir || !existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('finding-')) continue;
    const f = path.join(dir, entry.name, 'description.md');
    try { if (statSync(f).isFile()) out.set(entry.name, readFileSync(f, 'utf8')); } catch { /* optional */ }
  }
  return out;
}

// ---------------------------------------------------------------- judging

export function judge(scenario, report, bodies = new Map()) {
  const results = [], warnings = [];
  const findings = Array.isArray(report?.findings) ? report.findings : [];
  if (report && !Array.isArray(report?.findings)) warnings.push('report.findings is not an array — treated as empty');

  let malformed = 0;
  const prepared = findings.map((f) => {
    if (!f || typeof f !== 'object') { malformed++; return null; }
    return { f, text: findingText(f, bodies.get(f.id) ?? '') };
  }).filter(Boolean);
  if (malformed) warnings.push(`${malformed} finding element(s) were not objects — skipped`);

  // should_find: at least one finding matches. required:false downgrades a miss to a warning.
  for (const c of scenario.should_find ?? []) {
    const hit = prepared.find(({ f, text }) => matchFinding(f, c, text));
    const required = c.required !== false;
    results.push({
      kind: 'should_find', criteria: c, ok: Boolean(hit) || !required,
      hard: required,
      detail: hit ? `matched ${hit.f.id ?? '(unnamed finding)'}`
                  : (required ? 'FALSE NEGATIVE — no finding matched' : 'not found (optional)'),
    });
  }

  // should_not_find: a match is a false positive. Matched against the finding's IDENTITY, not its
  // narrative — see findingIdentity() for why.
  for (const c of scenario.should_not_find ?? []) {
    const hit = prepared.find(({ f }) => matchFinding(f, c, findingIdentity(f)));
    results.push({
      kind: 'should_not_find', criteria: c, ok: !hit, hard: true,
      detail: hit ? `FALSE POSITIVE — ${hit.f.id ?? '(unnamed finding)'} matched a planted safe case`
                  : 'correctly absent',
    });
  }

  // should_rule_out: the safe sibling must be RECORDED as checked, not merely absent.
  const ruled = Array.isArray(report?.tested_not_vulnerable) ? report.tested_not_vulnerable : [];
  for (const c of scenario.should_rule_out ?? []) {
    const hit = ruled.find((e) => matchRuleOut(e, c));
    const required = c.required !== false;
    results.push({
      kind: 'should_rule_out', criteria: c, ok: Boolean(hit) || !required, hard: required,
      detail: hit ? `recorded as ${hit.disposition ?? '(no disposition)'}`
                  : 'NOT RECORDED — absent from the report is not the same as checked and ruled out',
    });
  }

  // must_not_contain: hallucination guard over the whole serialized report.
  const whole = JSON.stringify(report ?? {}).toLowerCase() + ' ' + [...bodies.values()].join(' ').toLowerCase();
  for (const term of scenario.must_not_contain ?? []) {
    const present = whole.includes(low(term));
    results.push({
      kind: 'must_not_contain', criteria: { term }, ok: !present, hard: true,
      detail: present ? `HALLUCINATION GUARD — "${term}" appears in the report but is not in the fixture`
                      : 'absent as required',
    });
  }

  const failed = results.filter((r) => !r.ok);
  return {
    scenario: scenario.name, given: scenario.given, fixture: scenario.fixture,
    findings_in_report: prepared.length, results, warnings,
    passed: failed.length === 0, failed: failed.length,
  };
}

// ---------------------------------------------------------------- cli

function arg(flag, argv) { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; }

function main(argv) {
  const scenarioPath = arg('--scenario', argv);
  const reportPath = arg('--report', argv);
  if (!scenarioPath || !reportPath) {
    console.error('usage: judge.mjs --scenario <file.eval.json> --report <codeaudit-report.json> ' +
                  '[--findings-dir <dir>] [--json]');
    return 2;
  }
  let scenario, report;
  try { scenario = loadScenario(scenarioPath); }
  catch (e) { console.error(`scenario error: ${e.message}`); return 2; }
  try { report = JSON.parse(readFileSync(reportPath, 'utf8')); }
  catch (e) { console.error(`report error: ${reportPath}: ${e.message}`); return 2; }

  const findingsDir = arg('--findings-dir', argv)
    ?? path.join(path.dirname(path.resolve(reportPath)), 'findings');
  const out = judge(scenario, report, readFindingBodies(findingsDir));

  if (argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); return out.passed ? 0 : 1; }

  console.log(`\n${out.passed ? 'PASS' : 'FAIL'}  ${out.scenario}`);
  console.log(`      given: ${out.given}`);
  console.log(`      ${out.findings_in_report} finding(s) in report\n`);
  for (const r of out.results) {
    const mark = r.ok ? ' ok ' : 'FAIL';
    const what = r.kind === 'must_not_contain' ? r.criteria.term : JSON.stringify(r.criteria);
    console.log(`  [${mark}] ${r.kind}: ${what}\n         ${r.detail}`);
  }
  for (const w of out.warnings) console.log(`  [warn] ${w}`);
  console.log('');
  return out.passed ? 0 : 1;
}

// Entry guard. A naive `import.meta.url === \`file://${process.argv[1]}\`` silently fails when the install
// path contains a space or a symlink (file:// needs percent-encoding, and argv[1] is not resolved) — main()
// never runs, nothing is printed, and the process exits 0. For a judge, a silent exit 0 reads as PASS, so
// that bug turns "found none of the planted bugs" into a green CI. Resolve both sides before comparing.
function isMainModule() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return import.meta.url === pathToFileURL(path.resolve(argv1)).href;
  }
}

if (isMainModule()) process.exit(main(process.argv.slice(2)));
