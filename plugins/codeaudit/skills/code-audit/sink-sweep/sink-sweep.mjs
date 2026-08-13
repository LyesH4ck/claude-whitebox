#!/usr/bin/env node
// sink-sweep.mjs — deterministic, ADDITIVE coverage backstop for /codeaudit.
//
// Greps the whole in-scope tree for every taint class's sink patterns, diffs the
// hits against the VERDICTED set (findings + _safe-*.md, at file:line + class
// granularity), and prints the UNCOVERED sinks per class as JSON.
//
// It is a backstop, NOT a scoper: it never constrains what auditors explore. It
// only tells the orchestrator which sinks still need a verdict after the normal
// free-exploration pass — so sinks in modules outside a guessed scope, or buried
// deep in a huge file, cannot silently escape. A grep is cheap; only genuinely
// uncovered sinks trigger extra auditor work.
//
// Because it is a SCRIPT, it cannot "skip the tedious class" the way an LLM pass
// can — every class is swept every time.
//
// Usage:  node sink-sweep.mjs <repoDir> <engagementOutputsDir> [outOfScopeCsv]
// Output: JSON { summary:{<class>:{grepped,verdicted,uncovered}}, uncovered:{<class>:[{file,line,pattern}]} }
//
// Exit 0 always (the caller reads the JSON). Requires ripgrep (`rg`) on PATH.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const [repo, outDir, outOfScopeCsv = ''] = process.argv.slice(2);
if (!repo || !outDir) {
  console.error('usage: node sink-sweep.mjs <repoDir> <engagementOutputsDir> [outOfScopeCsv]');
  process.exit(2);
}

// HIGH-SIGNAL patterns only — rare, near-always-dangerous APIs whose mere presence
// in an UN-audited file is a real coverage gap. Ubiquitous sinks (SQL `.query`, XSS
// `.innerHTML`/`.append`, `requests.get`/`fetch`) are DELIBERATELY excluded: grep
// can't tell those apart from idiomatic-safe use, so they belong to the auditors'
// context-aware exploration, not a mechanical sweep. This keeps the sweep precise
// (dozens of files, not thousands) so its uncovered list is actually actionable.
const PATTERNS = {
  injection: [
    String.raw`(os\.system|os\.popen)\(|subprocess\.(call|run|Popen|check_output)\(|shell_exec\(|passthru\(|proc_open\(`,
    String.raw`(pickle|marshal)\.loads?\(|yaml\.load\(|unserialize\(|\.readObject\(|Marshal\.load\(`,
    String.raw`render_template_string\(`,
    String.raw`(DocumentBuilderFactory|SAXParserFactory|XMLInputFactory|simplexml_load|lxml\.etree|xml\.sax|Nokogiri::XML)`,
  ],
  xss: [ // only the rare escape-hatches (not ubiquitous .innerHTML/.append)
    String.raw`dangerouslySetInnerHTML|v-html|bypassSecurityTrust|mark_safe\(|\|\s*safe\b|autoescape\s+false`,
  ],
  ssrf: [ // opener/builder forms + Py2 file:// vectors — rare and dangerous
    String.raw`build_opener\(|\bOpenerDirector\.open\(|\burlopen\(|\burlretrieve\(|FancyURLopener\(|pycurl\.Curl\(\)\.setopt\(.*URL`,
  ],
  'access-control': [ // open redirect, CWE-601 — Django class forms + shortcut
    String.raw`HttpResponseRedirect\(|HttpResponsePermanentRedirect\(|redirect_to\(|res\.redirect\(|\bredirect\(`,
  ],
};

// finding-<prefix>-... dir  → class
const PREFIX_CLASS = { inj: 'injection', xss: 'xss', ssrf: 'ssrf', ac: 'access-control' };

const EXCLUDE_DIRS = ['tests', 'test', '__tests__', 'migrations', 'node_modules', 'vendor', 'dist', 'build', '.git'];
const EXCLUDE_FILES = ['*.min.js'];
for (const p of outOfScopeCsv.split(',').map(s => s.trim()).filter(Boolean)) {
  const name = p.replace(/\/+$/, '').replace(/^\.?\//, '').split('/').pop();
  if (name) EXCLUDE_DIRS.push(name);
}
const grepExcludes = [...EXCLUDE_DIRS.map(d => `--exclude-dir=${d}`), ...EXCLUDE_FILES.map(f => `--exclude=${f}`)];

// normalize a path to a repo-relative-ish form ending in the meaningful suffix
const rel = (f) => f.replace(repo.replace(/\/$/, '') + '/', '').replace(/^\.\//, '');
const key = (f, line) => `${basename(f)}:${line}`; // basename+line: robust to path-format drift

function grepClass(patterns) {
  const hits = new Map(); // key -> {file,line}
  const eArgs = patterns.flatMap(p => ['-e', p]);
  let out = '';
  try {
    // one grep per class (all patterns OR-ed via multiple -e). grep is a universal
    // real binary — unlike `rg`, which may be a shell function/absent to a script.
    out = execFileSync('grep', ['-rEn', '--binary-files=without-match', ...grepExcludes, ...eArgs, repo],
      { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  } catch (e) { if (e.status !== 1) throw e; /* status 1 = no match */ }
  for (const line of out.split('\n')) {
    const m = line.match(/^(.+?):(\d+):/);
    if (!m) continue;
    const file = rel(m[1]); const ln = +m[2];
    hits.set(key(file, ln), { file, line: ln });
  }
  return hits;
}

// Build a per-class VERDICTED set of basename:line keys from findings + _safe files.
function verdictedByClass() {
  const v = {}; for (const c of Object.keys(PATTERNS)) v[c] = new Set();
  const fdir = join(outDir, 'findings');
  if (!existsSync(fdir)) return v;
  const tokenRe = /[A-Za-z0-9_./-]+\.(?:py|js|ts|jsx|tsx|php|rb|go|java|cs|html|htm|mjs):\d+/g;
  const addTokens = (cls, text) => {
    for (const t of text.match(tokenRe) || []) {
      const i = t.lastIndexOf(':');
      v[cls].add(key(t.slice(0, i), +t.slice(i + 1)));
    }
  };
  for (const entry of readdirSync(fdir)) {
    const full = join(fdir, entry);
    let st; try { st = statSync(full); } catch { continue; }
    if (st.isDirectory() && entry.startsWith('finding-')) {
      const cls = PREFIX_CLASS[entry.split('-')[1]];
      if (!cls) continue; // not one of the swept classes
      for (const f of ['description.md', 'trace.md', 'snippet.txt']) {
        const p = join(full, f);
        if (existsSync(p)) addTokens(cls, readFileSync(p, 'utf8'));
      }
    } else if (st.isFile() && /^_safe-/.test(entry)) {
      // _safe-injection*.md / _safe-xss*.md / _safe-ssrf*.md / _safe-access-control*.md
      const cls = Object.keys(PATTERNS).find(c => entry.startsWith('_safe-' + c))
        || (entry.includes('inj') ? 'injection' : null);
      if (cls) addTokens(cls, readFileSync(full, 'utf8'));
    }
  }
  return v;
}

const verdicted = verdictedByClass();
const summary = {}; const uncovered = {};
for (const [cls, patterns] of Object.entries(PATTERNS)) {
  const hits = grepClass(patterns);
  const byFile = new Map(); // file -> {count, lines[]}
  for (const [k, hit] of hits) {
    if (verdicted[cls].has(k)) continue;
    const e = byFile.get(hit.file) || { file: hit.file, count: 0, lines: [] };
    e.count++; if (e.lines.length < 20) e.lines.push(hit.line);
    byFile.set(hit.file, e);
  }
  const files = [...byFile.values()].sort((a, b) => b.count - a.count);
  summary[cls] = { grepped: hits.size, verdicted: verdicted[cls].size,
    uncovered_files: files.length, uncovered_sinks: files.reduce((n, f) => n + f.count, 0) };
  if (files.length) uncovered[cls] = files; // one entry per under-covered FILE — the dispatch unit
}

console.log(JSON.stringify({ summary, uncovered }, null, 2));
