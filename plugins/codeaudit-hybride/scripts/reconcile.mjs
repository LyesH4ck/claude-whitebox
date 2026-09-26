#!/usr/bin/env node
// reconcile.mjs — deterministic Claude ↔ Codex reconciliation for codeaudit-hybride.
// The orchestrator (an LLM) only EXTRACTS Claude findings into hybrid/claude-index.json; every
// matching / agreement / calibration decision is made here, so two runs over the same inputs agree.
//
//   match         --out O --claude-index F --dual-classes a,b [--repo R] [--tolerance 3]
//   safe-input    --out O --class C
//   overturn-input --out O --class C
//   finalize      --out O --claude-index F

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Findings of these classes can describe the same bug (DOM-XSS, tenant-scoped IDOR) — match across them.
const FAMILY = { xss: "xss", "client-side": "xss", "access-control": "authz", "data-lifecycle": "authz" };
const family = (c) => FAMILY[c] ?? c;
const CONF_RANK = { unconfirmed: 0, probable: 1, high: 2 };

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) if (rest[i].startsWith("--")) opts[rest[i].slice(2)] = rest[++i];
  return { cmd, opts };
}

function out(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
  process.exit(code);
}

const readJson = (p, dflt) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : dflt);
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2)); };
const listDir = (d) => { try { return fs.readdirSync(d); } catch { return []; } };

export function normPath(p, repo) {
  let s = String(p ?? "").trim().replace(/\\/g, "/");
  if (repo) {
    const r = path.resolve(repo).replace(/\\/g, "/") + "/";
    if (s.startsWith(r)) s = s.slice(r.length);
  }
  return s.replace(/^\.\//, "").replace(/^\/+/, "");
}

export function normSlot(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const slotPrefix = (s) => normSlot(s).split("-")[0];

// Pair score (lower = better) or null if the two findings cannot be the same bug.
export function pairScore(a, b, tolerance) {
  if (family(a.vuln_class) !== family(b.vuln_class)) return null;
  if (a.sink_file !== b.sink_file) return null;
  const dl = Math.abs((a.sink_line ?? 0) - (b.sink_line ?? 0));
  if (dl > tolerance) return null;
  const sa = normSlot(a.slot_type), sb = normSlot(b.slot_type);
  // different slot families at the same sink (SQL vs CMD) are different bugs
  if (sa && sb && slotPrefix(sa) !== slotPrefix(sb)) return null;
  let score = dl;
  if (sa && sb && sa !== sb) score += 2; // same family, different label: plausible synonym, penalized
  if (a.source_line && b.source_line && a.source_line !== b.source_line) score += 1;
  return score;
}

// Greedy one-to-one matching on ascending score.
export function matchFindings(claude, codex, tolerance = 3) {
  const cands = [];
  claude.forEach((a, i) => codex.forEach((b, j) => {
    const s = pairScore(a, b, tolerance);
    if (s !== null) cands.push({ i, j, s });
  }));
  cands.sort((x, y) => x.s - y.s);
  const usedA = new Set(), usedB = new Set(), pairs = [];
  for (const c of cands) {
    if (usedA.has(c.i) || usedB.has(c.j)) continue;
    usedA.add(c.i); usedB.add(c.j);
    pairs.push({ claude_id: claude[c.i].id, codex_id: codex[c.j].id, score: c.s });
  }
  return {
    pairs,
    claude_only: claude.filter((_, i) => !usedA.has(i)).map((f) => f.id),
    codex_only: codex.filter((_, j) => !usedB.has(j)).map((f) => f.id),
  };
}

function codexResults(O, prefix) {
  const dir = path.join(O, "codex", "results");
  return listDir(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .map((f) => readJson(path.join(dir, f)));
}

function codexDetectFindings(O) {
  return codexResults(O, "cx-").filter((r) => r._meta?.mode === "detect").flatMap((r) => r.findings);
}

// the verification payload: what a reviewer needs, without saying which engine found it
function forReview(f) {
  return {
    id: f.id, vuln_class: f.vuln_class, title: f.title, severity: f.severity,
    sink: `${f.sink_expr ?? ""} (${f.sink_file}:${f.sink_line})`, slot_type: f.slot_type ?? null,
    source: `${f.source_expr ?? ""}${f.source_file ? ` (${f.source_file}:${f.source_line ?? "?"})` : ""}`,
    trace: f.trace ?? [], claim: f.why_vulnerable ?? f.summary ?? "",
  };
}

function groupByClass(list) {
  const g = {};
  for (const f of list) (g[f.vuln_class] ??= []).push(forReview(f));
  return g;
}

function cmdMatch(o) {
  const O = path.resolve(o.out);
  const tol = Number(o.tolerance ?? 3);
  const dual = new Set(String(o["dual-classes"] ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const dualFam = new Set([...dual].map(family));
  const norm = (f) => ({ ...f, sink_file: normPath(f.sink_file, o.repo), source_file: f.source_file ? normPath(f.source_file, o.repo) : null });
  const claudeAll = readJson(path.resolve(o["claude-index"]), []).map(norm);
  const codexAll = codexDetectFindings(O).map(norm);

  const claudeDual = claudeAll.filter((f) => dualFam.has(family(f.vuln_class)));
  const single = claudeAll.filter((f) => !dualFam.has(family(f.vuln_class))).map((f) => f.id);
  const m = matchFindings(claudeDual, codexAll, tol);

  const byId = Object.fromEntries([...claudeAll, ...codexAll].map((f) => [f.id, f]));
  const forCodex = groupByClass(m.claude_only.map((id) => byId[id]));
  const forClaude = groupByClass(m.codex_only.map((id) => byId[id]));
  for (const [c, list] of Object.entries(forCodex)) writeJson(path.join(O, "hybrid", "verify-input", `for-codex-${c}.json`), list);
  for (const [c, list] of Object.entries(forClaude)) writeJson(path.join(O, "hybrid", "verify-input", `for-claude-${c}.json`), list);

  const rec = {
    tolerance: tol, dual_classes: [...dual], both: m.pairs, claude_only: m.claude_only, codex_only: m.codex_only, single_engine: single,
    stats: { claude_total: claudeAll.length, codex_total: codexAll.length, both: m.pairs.length, claude_only: m.claude_only.length, codex_only: m.codex_only.length, single_engine: single.length },
  };
  writeJson(path.join(O, "hybrid", "reconciliation.json"), rec);
  out({ ok: true, ...rec.stats, verify_inputs: { for_codex: Object.keys(forCodex), for_claude: Object.keys(forClaude) } });
}

function cmdSafeInput(o) {
  const O = path.resolve(o.out);
  const dir = path.join(O, "findings");
  const files = listDir(dir).filter((f) => f === `_safe-${o.class}.md` || (f.startsWith(`_safe-${o.class}-`) && f.endsWith(".md")));
  const input = { vuln_class: o.class, files: files.map((f) => ({ ref: `findings/${f}`, content: fs.readFileSync(path.join(dir, f), "utf8") })) };
  const p = path.join(O, "hybrid", "safe-input", `${o.class}.json`);
  writeJson(p, input);
  out({ ok: true, class: o.class, files: files.length, input_file: p, empty: files.length === 0 });
}

function cmdOverturnInput(o) {
  const O = path.resolve(o.out);
  const r = readJson(path.join(O, "codex", "results", `cxs-${o.class}.json`), null);
  const list = (r?.findings ?? []).map((f) => ({ ...forReview(f), overturns: f.safe_ref }));
  const p = path.join(O, "hybrid", "verify-input", `for-claude-overturn-${o.class}.json`);
  if (list.length) writeJson(p, list);
  out({ ok: true, class: o.class, overturns: list.length, input_file: list.length ? p : null });
}

function verdictMap(O) {
  const m = {};
  const add = (verdicts, by) => { for (const v of verdicts ?? []) m[v.finding_id] = { ...v, by }; };
  for (const r of codexResults(O, "cxv-")) add(r.verdicts, "codex");
  const vdir = path.join(O, "hybrid", "verify");
  for (const f of listDir(vdir).filter((f) => f.startsWith("claude-") && f.endsWith(".json"))) add(readJson(path.join(vdir, f))?.verdicts, "claude");
  return m;
}

// A refutation only counts with a code citation; otherwise it is "uncertain".
export function effectiveVerdict(v) {
  if (!v) return "missing";
  if (v.verdict === "refuted" && !(v.sanitizer_file && v.sanitizer_line)) return "uncertain";
  return v.verdict;
}

const capProbable = (c) => (CONF_RANK[c] > CONF_RANK.probable ? "probable" : c);

export function calibrate({ rec, claudeById, codexById, verdicts, overturns }) {
  const rows = [];
  for (const p of rec.both) {
    const a = claudeById[p.claude_id], b = codexById[p.codex_id];
    const conf = CONF_RANK[b?.confidence] > CONF_RANK[a?.confidence] ? b.confidence : a?.confidence;
    rows.push({ id: p.claude_id, detected_by: ["claude", "codex"], merged: [p.codex_id], agreement: "both", confidence: conf, action: "keep" });
  }
  const single = (id, engine, f) => {
    const v = verdicts[id], ev = effectiveVerdict(v);
    const verifier = engine === "claude" ? "codex" : "claude";
    const base = { id, detected_by: [engine], verification: v ? { by: verifier, verdict: ev, citation: v.sanitizer_file ? `${v.sanitizer_file}:${v.sanitizer_line}` : null, argument: v.argument, corrected_severity: v.corrected_severity } : null };
    if (ev === "confirmed") return { ...base, agreement: "cross-verified", confidence: f?.confidence, action: "keep" };
    if (ev === "refuted") return { ...base, agreement: "disputed", confidence: capProbable(f?.confidence), action: "adjudicate" };
    // uncertain / missing: Claude's own finding keeps its codeaudit confidence (it passed codeaudit's bar);
    // an unverified Codex-only finding is capped at probable
    return { ...base, agreement: "single", confidence: engine === "claude" ? f?.confidence : capProbable(f?.confidence), action: "keep" };
  };
  for (const id of rec.claude_only) rows.push(single(id, "claude", claudeById[id]));
  for (const id of rec.codex_only) rows.push(single(id, "codex", codexById[id]));
  for (const id of rec.single_engine) rows.push({ id, detected_by: ["claude"], agreement: "claude-engine-only", confidence: claudeById[id]?.confidence, action: "keep" });
  for (const f of overturns) {
    const v = verdicts[f.id], ev = effectiveVerdict(v);
    const verification = v ? { by: "claude", verdict: ev, citation: v.sanitizer_file ? `${v.sanitizer_file}:${v.sanitizer_line}` : null, argument: v.argument, corrected_severity: v.corrected_severity } : null;
    if (ev === "confirmed") rows.push({ id: f.id, detected_by: ["codex"], overturns: f.safe_ref, verification, agreement: "safe-overturned", confidence: f.confidence, action: "keep" });
    else if (ev === "refuted") rows.push({ id: f.id, detected_by: ["codex"], overturns: f.safe_ref, verification, agreement: "overturn-rejected", confidence: null, action: "record-disputed-safe" });
    else rows.push({ id: f.id, detected_by: ["codex"], overturns: f.safe_ref, verification, agreement: "overturn-unverified", confidence: null, action: "coverage-gap" });
  }
  return rows;
}

function cmdFinalize(o) {
  const O = path.resolve(o.out);
  const rec = readJson(path.join(O, "hybrid", "reconciliation.json"), null);
  if (!rec) out({ ok: false, error: "run `match` first" }, 1);
  const claudeById = Object.fromEntries(readJson(path.resolve(o["claude-index"]), []).map((f) => [f.id, f]));
  const codexById = Object.fromEntries(codexDetectFindings(O).map((f) => [f.id, f]));
  const overturns = codexResults(O, "cxs-").flatMap((r) => r.findings ?? []);
  const verdicts = verdictMap(O);
  const rows = calibrate({ rec, claudeById, codexById, verdicts, overturns });
  const count = (k, v) => rows.filter((r) => r[k] === v).length;
  const stats = {
    both: count("agreement", "both"),
    cross_verified: count("agreement", "cross-verified"),
    single: count("agreement", "single"),
    disputed_to_adjudicate: count("action", "adjudicate"),
    claude_engine_only: count("agreement", "claude-engine-only"),
    safe_overturned: count("agreement", "safe-overturned"),
    overturn_rejected: count("agreement", "overturn-rejected"),
    overturn_unverified: count("agreement", "overturn-unverified"),
    codex_unique_kept: rows.filter((r) => r.detected_by.length === 1 && r.detected_by[0] === "codex" && r.action === "keep").length,
  };
  writeJson(path.join(O, "hybrid", "calibration.json"), { rows, stats });
  out({ ok: true, stats, adjudicate: rows.filter((r) => r.action === "adjudicate").map((r) => ({ id: r.id, citation: r.verification?.citation })) });
}

const COMMANDS = { match: cmdMatch, "safe-input": cmdSafeInput, "overturn-input": cmdOverturnInput, finalize: cmdFinalize };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  if (!COMMANDS[cmd]) out({ ok: false, error: `unknown subcommand "${cmd ?? ""}"`, subcommands: Object.keys(COMMANDS) }, 1);
  if (!opts.out) out({ ok: false, error: "missing --out" }, 1);
  COMMANDS[cmd](opts);
}
