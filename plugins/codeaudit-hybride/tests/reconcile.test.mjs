import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { matchFindings, pairScore, normPath, calibrate, effectiveVerdict } from "../scripts/reconcile.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECON = path.join(HERE, "..", "scripts", "reconcile.mjs");

const f = (id, o) => ({ id, vuln_class: "injection", sink_file: "app/db.py", sink_line: 10, slot_type: "SQL-value", confidence: "high", ...o });

test("pairing: tolerance, slot family and class family", () => {
  assert.equal(pairScore(f("a"), f("b", { sink_line: 12 }), 3), 2);
  assert.equal(pairScore(f("a"), f("b", { sink_line: 14 }), 3), null);
  assert.equal(pairScore(f("a"), f("b", { slot_type: "CMD-string" }), 3), null);
  assert.equal(pairScore(f("a"), f("b", { slot_type: "SQL-identifier" }), 3), 2);
  assert.equal(pairScore(f("a", { vuln_class: "xss" }), f("b", { vuln_class: "client-side" }), 3), 0);
  assert.equal(pairScore(f("a"), f("b", { vuln_class: "ssrf" }), 3), null);
});

test("matching is one-to-one and prefers the closest line", () => {
  const claude = [f("c1", { sink_line: 10 }), f("c2", { sink_line: 40 })];
  const codex = [f("x1", { sink_line: 11 }), f("x2", { sink_line: 10 }), f("x3", { sink_line: 90 })];
  const m = matchFindings(claude, codex, 3);
  assert.deepEqual(m.pairs.map((p) => [p.claude_id, p.codex_id]), [["c1", "x2"]]);
  assert.deepEqual(m.claude_only, ["c2"]);
  assert.deepEqual(m.codex_only.sort(), ["x1", "x3"]);
});

test("normPath strips the repo prefix and ./", () => {
  assert.equal(normPath("/src/acme/app/db.py", "/src/acme"), "app/db.py");
  assert.equal(normPath("./app/db.py"), "app/db.py");
});

test("a refutation without citation is uncertain", () => {
  assert.equal(effectiveVerdict({ verdict: "refuted", sanitizer_file: null, sanitizer_line: null }), "uncertain");
  assert.equal(effectiveVerdict({ verdict: "refuted", sanitizer_file: "a.py", sanitizer_line: 3 }), "refuted");
  assert.equal(effectiveVerdict(undefined), "missing");
});

test("calibration table", () => {
  const claudeById = { c1: f("c1", { confidence: "probable" }), c2: f("c2"), c3: f("c3"), s1: f("s1") };
  const codexById = { x1: f("x1"), x2: f("x2"), x3: f("x3"), x4: f("x4") };
  const rec = { both: [{ claude_id: "c1", codex_id: "x1" }], claude_only: ["c2", "c3"], codex_only: ["x2", "x3", "x4"], single_engine: ["s1"] };
  const verdicts = {
    c2: { verdict: "refuted", sanitizer_file: "a.py", sanitizer_line: 4, argument: "allowlist" },
    c3: { verdict: "refuted", sanitizer_file: null, sanitizer_line: null, argument: "looks fine" },
    x2: { verdict: "confirmed", argument: "rebuilt" },
    x3: { verdict: "uncertain", argument: "dynamic dispatch" },
    o1: { verdict: "confirmed", argument: "sibling var guard" },
  };
  const overturns = [{ id: "o1", confidence: "high", safe_ref: "findings/_safe-injection.md#2" }, { id: "o2", confidence: "high", safe_ref: "x" }];
  const rows = Object.fromEntries(calibrate({ rec, claudeById, codexById, verdicts, overturns }).map((r) => [r.id, r]));
  assert.equal(rows.c1.agreement, "both");
  assert.equal(rows.c1.confidence, "high", "max of the pair");
  assert.equal(rows.c2.action, "adjudicate");
  assert.equal(rows.c3.agreement, "single", "uncited refutation does not dispute");
  assert.equal(rows.c3.confidence, "high", "Claude keeps its codeaudit confidence");
  assert.equal(rows.x2.agreement, "cross-verified");
  assert.equal(rows.x3.confidence, "probable", "unverified Codex-only capped");
  assert.equal(rows.x4.confidence, "probable", "missing verdict capped");
  assert.equal(rows.s1.agreement, "claude-engine-only");
  assert.equal(rows.o1.agreement, "safe-overturned");
  assert.equal(rows.o2.action, "coverage-gap");
});

test("CLI match → finalize end to end", () => {
  const O = fs.mkdtempSync(path.join(os.tmpdir(), "hybride-rec-"));
  const w = (p, v) => { fs.mkdirSync(path.dirname(path.join(O, p)), { recursive: true }); fs.writeFileSync(path.join(O, p), JSON.stringify(v)); };
  w("hybrid/claude-index.json", [f("finding-inj-001"), f("finding-inj-002", { sink_line: 50 }), f("finding-sec-001", { vuln_class: "secrets" })]);
  w("codex/results/cx-injection.json", { _meta: { mode: "detect" }, findings: [f("finding-cx-injection-001", { sink_line: 11 }), f("finding-cx-injection-002", { sink_line: 99 })] });
  const run = (...a) => JSON.parse(spawnSync(process.execPath, [RECON, ...a, "--out", O], { encoding: "utf8" }).stdout);
  const m = run("match", "--claude-index", path.join(O, "hybrid/claude-index.json"), "--dual-classes", "injection");
  assert.deepEqual([m.both, m.claude_only, m.codex_only, m.single_engine], [1, 1, 1, 1]);
  assert.ok(fs.existsSync(path.join(O, "hybrid/verify-input/for-codex-injection.json")));
  const forClaude = JSON.parse(fs.readFileSync(path.join(O, "hybrid/verify-input/for-claude-injection.json"), "utf8"));
  assert.equal(forClaude[0].id, "finding-cx-injection-002");
  assert.equal(JSON.stringify(forClaude).includes("codex\""), false, "verifier input does not name the engine");
  w("codex/results/cxv-injection.json", { _meta: { mode: "verify" }, verdicts: [{ finding_id: "finding-inj-002", verdict: "confirmed", sanitizer_file: null, sanitizer_line: null, argument: "ok", corrected_severity: null }] });
  w("hybrid/verify/claude-injection.json", { verdicts: [{ finding_id: "finding-cx-injection-002", verdict: "refuted", sanitizer_file: "app/db.py", sanitizer_line: 97, argument: "int()", corrected_severity: null }] });
  const fin = run("finalize", "--claude-index", path.join(O, "hybrid/claude-index.json"));
  assert.equal(fin.stats.both, 1);
  assert.equal(fin.stats.cross_verified, 1);
  assert.equal(fin.stats.disputed_to_adjudicate, 1);
  assert.deepEqual(fin.adjudicate, [{ id: "finding-cx-injection-002", citation: "app/db.py:97" }]);
});
