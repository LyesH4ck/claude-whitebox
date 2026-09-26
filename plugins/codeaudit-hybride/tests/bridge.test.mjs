// node --test plugins/codeaudit-hybride/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  validate, extractJson, compareVersions, agentMounts, buildMethodology, resolvePluginRoot, CLASS_AGENT,
} from "../scripts/codex-bridge.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const BRIDGE = path.join(ROOT, "scripts", "codex-bridge.mjs");
const DETECT_SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, "schemas", "codex-detect.schema.json"), "utf8"));

const FINDING = {
  title: "SQLi via sort", vuln_class: "injection", severity: "high", confidence: "high", cwe: "CWE-89",
  sink_file: "app/db.py", sink_line: 12, sink_expr: "cursor.execute(q)", slot_type: "SQL-identifier",
  source_expr: "request.args['sort']", source_file: "app/views.py", source_line: 5, source_in: "query",
  trace: ["app/views.py:5", "app/db.py:12"], defense_analysis: "none", why_vulnerable: "f-string into ORDER BY",
  externally_reachable: true, impact: "db read", remediation: "allowlist", witness_payload: "id--", safe_ref: null,
};
const VALID = { status: "complete", vuln_class: "injection", findings: [FINDING], safe: [], coverage_gaps: [], remaining: [] };

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hybride-test-"));
}

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [BRIDGE, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* keep null */ }
  return { ...r, json };
}

test("validator accepts a valid detect result and rejects drift", () => {
  assert.deepEqual(validate(DETECT_SCHEMA, VALID), []);
  const bad = structuredClone(VALID);
  bad.findings[0].severity = "urgent";
  bad.findings[0].extra = 1;
  delete bad.findings[0].trace;
  const errs = validate(DETECT_SCHEMA, bad);
  assert.ok(errs.some((e) => e.includes("not in")));
  assert.ok(errs.some((e) => e.includes('unexpected "extra"')));
  assert.ok(errs.some((e) => e.includes('missing "trace"')));
});

test("extractJson handles bare, fenced and prose-wrapped answers", () => {
  const s = JSON.stringify(VALID);
  assert.equal(extractJson(s).value.status, "complete");
  assert.equal(extractJson("```json\n" + s + "\n```").value.status, "complete");
  assert.equal(extractJson("Here you go:\n" + s + "\nDone.").value.status, "complete");
  assert.ok(extractJson("no json here").error);
});

test("compareVersions sorts like sort -V", () => {
  const v = ["0.1.9", "0.1.17", "0.2.0", "0.1.10"].sort(compareVersions);
  assert.deepEqual(v, ["0.1.9", "0.1.10", "0.1.17", "0.2.0"]);
});

test("methodology inlines codeaudit's skill + class rules for every class", () => {
  const ca = resolvePluginRoot("codeaudit", path.join("skills", "code-audit", "SKILL.md"));
  assert.ok(ca, "codeaudit plugin must be resolvable (repo checkout or cache)");
  for (const cls of Object.keys(CLASS_AGENT)) {
    const { methodology } = buildMethodology({ cls, codeauditRoot: ca, pentestRoot: null, mode: "detect" });
    assert.match(methodology, /skills\/code-audit\/SKILL\.md/, cls);
    assert.match(methodology, /Class rules — /, cls);
  }
  const mounts = agentMounts("Read plugins/codeaudit/skills/x.md\nRead plugins/pentest/a/b.md\nRead plugins/codeaudit/skills/x.md");
  assert.equal(mounts.length, 2);
});

test("exec transport: start → wait → collect materializes findings (fake codex)", () => {
  const dir = tmp();
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  // fake `codex exec`: asserts read-only flags, writes the schema-valid answer to -o
  fs.writeFileSync(path.join(bin, "codex"), `#!/bin/sh
case " $* " in *" -s read-only "*) ;; *) echo "not read-only" >&2; exit 3;; esac
case " $* " in *" --write "*) exit 4;; esac
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && OUT="$2"; shift; done
cat > /dev/null
printf '%s' '${JSON.stringify(VALID)}' > "$OUT"
`, { mode: 0o755 });
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  const out = path.join(dir, "outputs", "eng");
  const env = { PATH: `${bin}:${process.env.PATH}` };

  const s = run(["start", "--out", out, "--repo", repo, "--mode", "detect", "--class", "injection", "--tag", "cx-injection", "--transport", "exec", "--model", "m-test", "--effort", "high"], env);
  assert.equal(s.json?.ok, true, s.stdout + s.stderr);
  const w = run(["wait", "--out", out, "--tag", "cx-injection", "--max-seconds", "30"], env);
  assert.equal(w.json.status, "completed", w.stdout);
  const c = run(["collect", "--out", out, "--tag", "cx-injection"], env);
  assert.equal(c.json.valid, true, c.stdout);
  assert.equal(c.json.findings, 1);
  const desc = fs.readFileSync(path.join(out, "findings-codex", "finding-cx-injection-001", "description.md"), "utf8");
  assert.match(desc, /\*\*Detected by\*\*: codex \(m-test/);
  assert.match(desc, /`app\/db\.py:12`/);
  const prompt = fs.readFileSync(path.join(out, "codex", "prompts", "cx-injection.md"), "utf8");
  assert.doesNotMatch(prompt, /\{\{[A-Z_]+\}\}/, "all template slots filled");
});

test("companion transport: queue → status → result, invalid answer → one repair (fake companion)", () => {
  const dir = tmp();
  const state = path.join(dir, "fake-state.json");
  const companion = path.join(dir, "codex-companion.mjs");
  // Fake companion: 1st task answers prose-with-broken-JSON, the repair task answers valid JSON.
  fs.writeFileSync(companion, `
import fs from "node:fs";
const [cmd, ...a] = process.argv.slice(2);
const S = ${JSON.stringify(state)};
const st = fs.existsSync(S) ? JSON.parse(fs.readFileSync(S, "utf8")) : { n: 0, jobs: {} };
const save = () => fs.writeFileSync(S, JSON.stringify(st));
if (cmd === "task") {
  if (a.includes("--write")) { console.error("write forbidden"); process.exit(9); }
  if (!process.env.CLAUDE_PLUGIN_DATA) { console.error("state dir not pinned"); process.exit(8); }
  const id = "task-" + (++st.n); const prompt = fs.readFileSync(a[a.indexOf("--prompt-file") + 1], "utf8");
  st.jobs[id] = { repair: prompt.includes("could not be parsed") }; save();
  console.log(JSON.stringify({ jobId: id, status: "queued" }));
} else if (cmd === "status") {
  console.log(JSON.stringify({ job: { id: a[0], status: "completed" } }));
} else if (cmd === "result") {
  const j = st.jobs[a[0]];
  const raw = j.repair ? ${JSON.stringify(JSON.stringify(VALID))} : "Findings: { broken";
  console.log(JSON.stringify({ job: { id: a[0] }, storedJob: { threadId: "th-" + a[0], result: { rawOutput: raw } } }));
} else if (cmd === "cancel") { console.log("{}"); }
`);
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  const out = path.join(dir, "outputs", "eng");
  const env = { CODEX_COMPANION: companion };

  assert.equal(run(["start", "--out", out, "--repo", repo, "--mode", "detect", "--class", "xss", "--tag", "cx-xss"], env).json.ok, true);
  assert.equal(run(["wait", "--out", out, "--tag", "cx-xss"], env).json.status, "completed");
  const c1 = run(["collect", "--out", out, "--tag", "cx-xss"], env).json;
  assert.equal(c1.valid, false);
  assert.equal(c1.can_repair, true);
  assert.equal(run(["repair", "--out", out, "--tag", "cx-xss"], env).json.ok, true);
  assert.equal(run(["wait", "--out", out, "--tag", "cx-xss-repair"], env).json.status, "completed");
  const c2 = run(["collect", "--out", out, "--tag", "cx-xss-repair"], env).json;
  assert.equal(c2.valid, true, JSON.stringify(c2));
  assert.equal(c2.tag, "cx-xss", "repair results land under the original tag");
  assert.ok(fs.existsSync(path.join(out, "codex", "results", "cx-xss.json")));
  assert.ok(fs.existsSync(path.join(out, "findings-codex", "finding-cx-xss-001", "description.md")));
  const st = run(["status", "--out", out], env).json;
  assert.equal(st.counts.collected, 2);
});
