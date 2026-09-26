#!/usr/bin/env node
// codex-bridge.mjs — the only door between codeaudit-hybride and Codex.
//
// Two transports:
//   companion  → OpenAI's codex-plugin-cc runtime (codex-companion.mjs `task`, read-only, background jobs)
//   exec       → `codex exec -s read-only --ephemeral --output-schema` (fallback, strict JSON natively)
// Codex is ALWAYS read-only here: this script never passes --write / workspace-write.
//
// Subcommands (all print one JSON object on stdout):
//   preflight --out O [--repo R]
//   start     --out O --repo R --mode detect|verify|safe-review --class C --tag T
//             [--scope S] [--out-of-scope X] [--depth D] [--input FILE]
//             [--transport companion|exec] [--model M] [--effort E] [--force]
//   repair    --out O --tag T                 (re-emit an unparseable answer as valid JSON)
//   wait      --out O --tag T [--max-seconds 540]
//   collect   --out O --tag T
//   cancel    --out O (--tag T | --all)
//   status    --out O
//   cleanup   --out O [--delete-threads]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
const HOME = os.homedir();

// class key → codeaudit agent file (the class methodology Codex must follow, same as Claude's twin)
export const CLASS_AGENT = {
  injection: "injection-auditor",
  xss: "xss-auditor",
  auth: "auth-auditor",
  "access-control": "access-control-auditor",
  ssrf: "ssrf-auditor",
  secrets: "secrets-auditor",
  crypto: "crypto-auditor",
  deps: "deps-auditor",
  config: "config-auditor",
  logging: "logging-auditor",
  "business-logic": "business-logic-auditor",
  "feature-abuse": "feature-abuse-auditor",
  "data-lifecycle": "data-lifecycle-auditor",
  "client-side": "client-side-auditor",
  "http-protocol": "http-protocol-auditor",
  "ai-llm": "ai-agent-auditor",
  "resource-exhaustion": "resource-exhaustion-auditor",
};

export const CLASS_OWASP = {
  injection: "A03:2021 Injection",
  xss: "A03:2021 Injection",
  auth: "A07:2021 Identification and Authentication Failures",
  "access-control": "A01:2021 Broken Access Control",
  ssrf: "A10:2021 Server-Side Request Forgery",
  secrets: "A05:2021 Security Misconfiguration",
  crypto: "A02:2021 Cryptographic Failures",
  deps: "A06:2021 Vulnerable and Outdated Components",
  config: "A05:2021 Security Misconfiguration",
  logging: "A09:2021 Security Logging and Monitoring Failures",
  "business-logic": "A04:2021 Insecure Design",
  "feature-abuse": "A04:2021 Insecure Design",
  "data-lifecycle": "A01:2021 Broken Access Control",
  "client-side": "A03:2021 Injection",
  "http-protocol": "A05:2021 Security Misconfiguration",
  "ai-llm": "A04:2021 Insecure Design",
  "resource-exhaustion": "A04:2021 Insecure Design",
};

const MODES = {
  detect: { prompt: "detect.md", schema: "codex-detect.schema.json" },
  "safe-review": { prompt: "safe-review.md", schema: "codex-detect.schema.json" },
  verify: { prompt: "verify.md", schema: "verify.schema.json" },
};

const ACTIVE = new Set(["queued", "running"]);

// ───────────────────────────── generic helpers ─────────────────────────────

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  const BOOL = new Set(["force", "all", "delete-threads"]);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (BOOL.has(key)) opts[key] = true;
    else opts[key] = rest[++i];
  }
  return { cmd, opts };
}

function out(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
  process.exit(code);
}

function fail(message, extra = {}) {
  out({ ok: false, error: message, ...extra }, 1);
}

function need(opts, ...keys) {
  for (const k of keys) if (!opts[k]) fail(`missing required --${k}`);
}

export function compareVersions(a, b) {
  const pa = String(a).split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = String(b).split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

// newest ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/<rel> (sort -V | tail -1 equivalent)
function newestCached(plugin, rel) {
  const cache = path.join(HOME, ".claude", "plugins", "cache");
  const hits = [];
  for (const mk of safeReaddir(cache)) {
    const pdir = path.join(cache, mk, plugin);
    for (const ver of safeReaddir(pdir)) {
      const p = path.join(pdir, ver, rel);
      if (fs.existsSync(p)) hits.push({ ver, p });
    }
  }
  hits.sort((x, y) => compareVersions(x.ver, y.ver));
  return hits.length ? hits[hits.length - 1].p : null;
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function firstExisting(cands) {
  for (const c of cands) if (c && fs.existsSync(c)) return c;
  return null;
}

// codeaudit / pentest roots: explicit → env → repo sibling → CWD checkout → newest cache
export function resolvePluginRoot(name, marker, explicit) {
  const hit = firstExisting([
    explicit && path.join(explicit, marker),
    process.env[`${name.toUpperCase()}_ROOT`] && path.join(process.env[`${name.toUpperCase()}_ROOT`], marker),
    path.join(PLUGIN_ROOT, "..", name, marker),
    path.join(process.cwd(), "plugins", name, marker),
    newestCached(name, marker),
  ]);
  return hit ? hit.slice(0, hit.length - marker.length).replace(/[\\/]+$/, "") : null;
}

export function resolveCompanion(explicit) {
  const rel = path.join("scripts", "codex-companion.mjs");
  const marketplaces = path.join(HOME, ".claude", "plugins", "marketplaces");
  const fromMarketplaces = safeReaddir(marketplaces)
    .map((m) => path.join(marketplaces, m, "plugins", "codex", rel))
    .filter((p) => fs.existsSync(p));
  return firstExisting([explicit, process.env.CODEX_COMPANION, newestCached("codex", rel), ...fromMarketplaces]);
}

function readCodexConfig() {
  const file = path.join(process.env.CODEX_HOME || path.join(HOME, ".codex"), "config.toml");
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return { model: null, effort: null }; }
  // top-level keys only (before the first [table])
  const top = text.split(/^\s*\[/m)[0];
  const model = top.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1] ?? null;
  const effort = top.match(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1] ?? null;
  return { model, effort };
}

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ───────────────────────────── engagement layout & ledger ─────────────────────────────

export function layout(outDir) {
  const root = path.resolve(outDir);
  const codex = path.join(root, "codex");
  const L = {
    root,
    codex,
    jobs: path.join(codex, "jobs"),
    prompts: path.join(codex, "prompts"),
    results: path.join(codex, "results"),
    raw: path.join(codex, "raw"),
    exec: path.join(codex, "exec"),
    state: path.join(codex, "companion-data"),
    findings: path.join(root, "findings-codex"),
  };
  for (const d of [L.jobs, L.prompts, L.results, L.raw, L.exec, L.state]) fs.mkdirSync(d, { recursive: true });
  return L;
}

function ledgerPath(L, tag) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(tag)) fail(`invalid tag "${tag}" (use [a-z0-9._-])`);
  return path.join(L.jobs, `${tag}.json`);
}

function readLedger(L, tag) {
  const p = ledgerPath(L, tag);
  if (!fs.existsSync(p)) fail(`no job with tag "${tag}" in ${L.jobs}`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeLedger(L, rec) {
  rec.updated_at = new Date().toISOString();
  fs.writeFileSync(ledgerPath(L, rec.tag), JSON.stringify(rec, null, 2));
}

function companionEnv(L) {
  // Pin the companion's job/state store inside the engagement dir so every call finds the same jobs
  // and cleanup is local to the engagement.
  return { ...process.env, CLAUDE_PLUGIN_DATA: L.state };
}

function runCompanion(L, companion, args, { timeoutMs = 120000 } = {}) {
  const r = spawnSync(process.execPath, [companion, ...args], {
    env: companionEnv(L),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json, error: r.error?.message };
}

// ───────────────────────────── prompt building ─────────────────────────────

function stripFrontmatter(text) {
  return text.replace(/^---\n[\s\S]*?\n---\n/, "");
}

// Parse the codeaudit agent's "Read plugins/<plugin>/<rel>" mount lines.
export function agentMounts(agentText) {
  const mounts = [];
  const re = /Read\s+`?plugins\/(codeaudit|pentest)\/([^\s`]+)/g;
  let m;
  while ((m = re.exec(agentText))) {
    const key = `${m[1]}/${m[2]}`;
    if (!mounts.some((x) => `${x.plugin}/${x.rel}` === key)) mounts.push({ plugin: m[1], rel: m[2] });
  }
  return mounts;
}

export function buildMethodology({ cls, codeauditRoot, pentestRoot, mode }) {
  const agentName = CLASS_AGENT[cls];
  if (!agentName) fail(`unknown class "${cls}"`, { known: Object.keys(CLASS_AGENT) });
  const agentFile = path.join(codeauditRoot, "agents", `${agentName}.md`);
  if (!fs.existsSync(agentFile)) fail(`codeaudit agent not found: ${agentFile}`);
  const agentText = fs.readFileSync(agentFile, "utf8");

  let mounts = agentMounts(agentText);
  // the verdict core is always included, even if an agent forgets to mount it
  for (const rel of ["skills/code-audit/SKILL.md", "skills/code-audit/reference/SOURCE_TO_SINK.md"]) {
    if (!mounts.some((x) => x.plugin === "codeaudit" && x.rel === rel)) mounts.unshift({ plugin: "codeaudit", rel });
  }
  // verification only needs the verdict core + the class rules, not the sink catalog
  if (mode === "verify") mounts = mounts.filter((x) => x.plugin === "pentest" || !x.rel.endsWith("SINK_CATALOG.md"));

  const sections = [];
  const references = [];
  for (const { plugin, rel } of mounts) {
    if (plugin === "codeaudit") {
      const p = path.join(codeauditRoot, rel);
      if (fs.existsSync(p)) sections.push(`## ${rel}\n\n${stripFrontmatter(fs.readFileSync(p, "utf8"))}`);
      else references.push(`- (missing on disk) plugins/codeaudit/${rel}`);
    } else {
      const p = pentestRoot ? path.join(pentestRoot, rel) : null;
      references.push(p && fs.existsSync(p) ? `- ${p}` : `- (not available) plugins/pentest/${rel}`);
    }
  }
  sections.push(
    `## Class rules — ${agentName}\n\n` +
      "> Written for another auditor runtime: IGNORE its instructions about tools, mounting files, writing " +
      "finding directories, activity logs, shards and status lines. Keep its detection rules, sink lists, " +
      "slot labels and verdict criteria. Your only output is the JSON object requested below.\n\n" +
      stripFrontmatter(agentText)
  );
  return { methodology: sections.join("\n\n---\n\n"), references: references.join("\n") || "- none" };
}

function fill(template, vars) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => (k in vars ? String(vars[k]) : `{{${k}}}`));
}

function schemaFile(name) {
  return path.join(PLUGIN_ROOT, "schemas", name);
}

// ───────────────────────────── JSON extraction & validation ─────────────────────────────

export function extractJson(text) {
  const t = String(text ?? "").trim();
  const tries = [t];
  const fence = t.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fence) tries.push(fence[1]);
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a !== -1 && b > a) tries.push(t.slice(a, b + 1));
  for (const s of tries) {
    try { return { value: JSON.parse(s) }; } catch { /* next */ }
  }
  return { error: "no parseable JSON object in the answer" };
}

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

// Minimal JSON-Schema validator: type (incl. unions), enum, required, properties,
// additionalProperties:false, items, minLength, minimum. Enough for our own schemas.
export function validate(schema, value, at = "$", errors = []) {
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const t = typeOf(value);
    const ok = types.includes(t) || (t === "integer" && types.includes("number"));
    if (!ok) { errors.push(`${at}: expected ${types.join("|")}, got ${t}`); return errors; }
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: ${JSON.stringify(value)} not in ${JSON.stringify(schema.enum)}`);
  if (typeof value === "string" && schema.minLength && value.length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below ${schema.minimum}`);
  if (typeOf(value) === "object") {
    for (const k of schema.required ?? []) if (!(k in value)) errors.push(`${at}: missing "${k}"`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k]) validate(schema.properties[k], v, `${at}.${k}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${at}: unexpected "${k}"`);
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => validate(schema.items, v, `${at}[${i}]`, errors));
  return errors;
}

// ───────────────────────────── finding materialization ─────────────────────────────

function loc(file, line) {
  return line ? `${file}:${line}` : file;
}

export function renderDescription(f, meta) {
  const src = f.source_file ? ` (\`${loc(f.source_file, f.source_line)}\`)` : "";
  return `# [${f.vuln_class}] ${f.title}

**Severity**: ${f.severity}
**Confidence**: ${f.confidence}
**OWASP**: ${CLASS_OWASP[f.vuln_class] ?? "n/a"}   **CWE**: ${f.cwe ?? "n/a"}
**Reachable**: ${f.externally_reachable}
**Detected by**: codex (${meta.model ?? "config default"}, effort ${meta.effort ?? "config default"}, job \`${meta.tag}\`)${f.safe_ref ? `\n**Overturns safe verdict**: ${f.safe_ref}` : ""}

## Location
\`${loc(f.sink_file, f.sink_line)}\`

## Source → Sink
- **Source**: ${f.source_expr}${f.source_in ? ` in \`${f.source_in}\`` : ""}${src}
- **Path**: ${f.trace.length ? f.trace.join(" → ") : "n/a"}
- **Sink**: ${f.sink_expr} (\`${loc(f.sink_file, f.sink_line)}\`), slot \`${f.slot_type}\`

## Defense analysis
${f.defense_analysis || "n/a"}

## Why it is vulnerable
${f.why_vulnerable}

## Impact
${f.impact || "n/a"}

## Remediation
${f.remediation || "n/a"}

## Witness payload (optional)
${f.witness_payload ? `\`${f.witness_payload}\`` : "n/a"}
`;
}

function materialize(L, rec, result) {
  const baseTag = rec.repair_of ?? rec.tag;
  fs.mkdirSync(L.findings, { recursive: true });
  result.findings.forEach((f, i) => {
    const id = `finding-${baseTag}-${String(i + 1).padStart(3, "0")}`;
    f.id = id;
    f.evidence = path.relative(L.root, path.join(L.findings, id, "description.md"));
    const dir = path.join(L.findings, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "description.md"), renderDescription(f, { ...rec, tag: baseTag }));
  });
}

// ───────────────────────────── subcommands ─────────────────────────────

async function cmdPreflight(opts) {
  need(opts, "out");
  const L = layout(opts.out);
  const v = spawnSync("codex", ["--version"], { encoding: "utf8" });
  const codexCli = v.status === 0 ? v.stdout.trim() : null;
  const companion = resolveCompanion(opts.companion);
  let companionSetup = null;
  if (companion) {
    const r = runCompanion(L, companion, ["setup", "--json", ...(opts.repo ? ["--cwd", opts.repo] : [])], { timeoutMs: 60000 });
    companionSetup = r.json
      ? { ready: Boolean(r.json.ready), loggedIn: r.json.auth?.loggedIn ?? null, reviewGateEnabled: r.json.reviewGateEnabled ?? null, nextSteps: r.json.nextSteps ?? [] }
      : { ready: false, error: (r.stderr || r.error || "unparseable setup output").slice(0, 500) };
  }
  const cfg = readCodexConfig();
  const codeauditRoot = resolvePluginRoot("codeaudit", path.join("skills", "code-audit", "SKILL.md"), opts["codeaudit-root"]);
  const pentestRoot = resolvePluginRoot("pentest", path.join("skills", "pentest"), opts["pentest-root"]);
  const transports = [];
  if (companion && companionSetup?.ready) transports.push("companion");
  if (codexCli) transports.push("exec");
  out({
    ok: Boolean(codeauditRoot) && transports.length > 0,
    codex_cli: codexCli,
    companion,
    companion_setup: companionSetup,
    config_model: cfg.model,
    config_effort: cfg.effort,
    codeaudit_root: codeauditRoot,
    pentest_root: pentestRoot,
    transports_available: transports,
    recommended_transport: transports[0] ?? null,
    notes: [
      ...(codeauditRoot ? [] : ["codeaudit plugin not found — codeaudit-hybride reuses its agents and methodology; install it"]),
      ...(companion ? [] : ["codex-plugin-cc not installed: /plugin marketplace add openai/codex-plugin-cc then /plugin install codex@openai-codex"]),
      ...(codexCli ? [] : ["codex CLI not on PATH"]),
      ...(companionSetup?.reviewGateEnabled ? ["codex stop-review-gate is ENABLED — disable it for audits (/codex:setup --disable-review-gate)"] : []),
    ],
  });
}

async function cmdStart(opts, { repairOf = null } = {}) {
  need(opts, "out", "tag");
  const L = layout(opts.out);
  const lp = ledgerPath(L, opts.tag);
  if (fs.existsSync(lp) && !opts.force) {
    const prev = JSON.parse(fs.readFileSync(lp, "utf8"));
    if (ACTIVE.has(prev.status)) fail(`tag "${opts.tag}" is still ${prev.status}; wait/cancel it or pass --force`);
  }

  let mode, cls, repo, prompt, schemaName;
  if (repairOf) {
    ({ mode, class: cls, repo } = repairOf);
    schemaName = MODES[mode].schema;
    const raw = fs.readFileSync(path.join(L.raw, `${repairOf.tag}.txt`), "utf8");
    prompt = fill(fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", "repair.md"), "utf8"), {
      ERRORS: (repairOf.validation_errors ?? []).map((e) => `- ${e}`).join("\n") || "- unparseable",
      SCHEMA: fs.readFileSync(schemaFile(schemaName), "utf8"),
      INPUT: raw,
    });
  } else {
    need(opts, "repo", "mode", "class");
    ({ mode, class: cls, repo } = opts);
    if (!MODES[mode]) fail(`unknown mode "${mode}"`, { modes: Object.keys(MODES) });
    if (!fs.existsSync(repo)) fail(`repo not found: ${repo}`);
    if (mode !== "detect" && !opts.input) fail(`--input is required for mode ${mode}`);
    schemaName = MODES[mode].schema;
    const codeauditRoot = resolvePluginRoot("codeaudit", path.join("skills", "code-audit", "SKILL.md"), opts["codeaudit-root"]);
    if (!codeauditRoot) fail("codeaudit plugin not found (needed for the shared methodology)");
    const pentestRoot = resolvePluginRoot("pentest", path.join("skills", "pentest"), opts["pentest-root"]);
    const { methodology, references } = buildMethodology({ cls, codeauditRoot, pentestRoot, mode });
    prompt = fill(fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", MODES[mode].prompt), "utf8"), {
      REPO: path.resolve(repo),
      CLASS: cls,
      SCOPE: opts.scope ?? "whole repository",
      OUT_OF_SCOPE: opts["out-of-scope"] ?? "none",
      DEPTH: opts.depth ?? "Thorough",
      METHODOLOGY: methodology,
      REFERENCES: references,
      INPUT: opts.input ? fs.readFileSync(opts.input, "utf8") : "",
      SCHEMA: fs.readFileSync(schemaFile(schemaName), "utf8"),
    });
  }

  const promptFile = path.join(L.prompts, `${opts.tag}.md`);
  fs.writeFileSync(promptFile, prompt);
  const transport = opts.transport ?? repairOf?.transport ?? "companion";
  const model = opts.model && opts.model !== "config" ? opts.model : repairOf?.model ?? null;
  const effort = opts.effort && opts.effort !== "config" ? opts.effort : repairOf?.effort ?? null;
  const rec = {
    tag: opts.tag, mode, class: cls, repo: path.resolve(repo), transport, model, effort,
    schema: schemaName, prompt_file: promptFile, repair_of: repairOf?.tag ?? null,
    started_at: new Date().toISOString(), status: "queued",
  };

  if (transport === "companion") {
    const companion = resolveCompanion(opts.companion);
    if (!companion) fail("codex-plugin-cc companion not found (run preflight)");
    const args = ["task", "--background", "--json", "--cwd", rec.repo, "--prompt-file", promptFile];
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    const r = runCompanion(L, companion, args);
    if (!r.json?.jobId) fail("companion did not queue the task", { stderr: (r.stderr || r.error || "").slice(0, 1000), stdout: (r.stdout || "").slice(0, 1000) });
    rec.companion = companion;
    rec.job_id = r.json.jobId;
    rec.log_file = r.json.logFile ?? null;
  } else if (transport === "exec") {
    const resultFile = path.join(L.exec, `${opts.tag}.result.txt`);
    const exitFile = path.join(L.exec, `${opts.tag}.exit`);
    const logFile = path.join(L.exec, `${opts.tag}.log`);
    for (const f of [resultFile, exitFile]) fs.rmSync(f, { force: true });
    const cmd = [
      "codex", "exec", "-s", "read-only", "--ephemeral", "--skip-git-repo-check", "--color", "never",
      "-C", rec.repo, "--output-schema", schemaFile(schemaName), "-o", resultFile,
      ...(model ? ["-m", model] : []),
      ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
      "-",
    ].map(shq).join(" ");
    const script = `${cmd} < ${shq(promptFile)} > ${shq(logFile)} 2>&1; echo $? > ${shq(exitFile)}`;
    const child = spawn("sh", ["-c", script], { detached: true, stdio: "ignore" });
    child.unref();
    Object.assign(rec, { pid: child.pid, result_file: resultFile, exit_file: exitFile, log_file: logFile });
  } else {
    fail(`unknown transport "${transport}" (companion|exec)`);
  }

  writeLedger(L, rec);
  out({ ok: true, tag: rec.tag, mode, class: cls, transport, job_id: rec.job_id ?? null, pid: rec.pid ?? null, status: "queued" });
}

async function cmdRepair(opts) {
  need(opts, "out", "tag");
  const L = layout(opts.out);
  const rec = readLedger(L, opts.tag);
  if (rec.status !== "invalid") fail(`job "${opts.tag}" is ${rec.status}, only an "invalid" job can be repaired`);
  if (rec.repair_of) fail(`job "${opts.tag}" is already a repair — record the class as a coverage gap instead`);
  await cmdStart({ ...opts, tag: `${opts.tag}-repair`, force: true }, { repairOf: rec });
}

async function cmdWait(opts) {
  need(opts, "out", "tag");
  const L = layout(opts.out);
  const rec = readLedger(L, opts.tag);
  const maxS = Math.min(Number(opts["max-seconds"] ?? 540), 580);
  if (!ACTIVE.has(rec.status)) out({ ok: true, tag: rec.tag, status: rec.status, timed_out: false });

  let status = rec.status;
  if (rec.transport === "companion") {
    const r = runCompanion(L, rec.companion, ["status", rec.job_id, "--wait", "--timeout-ms", String(maxS * 1000), "--json", "--cwd", rec.repo], { timeoutMs: (maxS + 30) * 1000 });
    status = r.json?.job?.status ?? status;
    if (!r.json) rec.last_error = (r.stderr || r.error || "unparseable status").slice(0, 500);
  } else {
    const deadline = Date.now() + maxS * 1000;
    while (!fs.existsSync(rec.exit_file) && pidAlive(rec.pid) && Date.now() < deadline) await sleep(5000);
    if (fs.existsSync(rec.exit_file)) {
      const code = fs.readFileSync(rec.exit_file, "utf8").trim();
      status = code === "0" && fs.existsSync(rec.result_file) ? "completed" : "failed";
      if (status === "failed") rec.last_error = `codex exec exited ${code} — see ${rec.log_file}`;
    } else if (!pidAlive(rec.pid)) {
      status = "failed";
      rec.last_error = `codex exec process vanished — see ${rec.log_file}`;
    } else status = "running";
  }
  rec.status = status;
  writeLedger(L, rec);
  out({ ok: true, tag: rec.tag, status, timed_out: ACTIVE.has(status), error: rec.last_error ?? null });
}

async function cmdCollect(opts) {
  need(opts, "out", "tag");
  const L = layout(opts.out);
  const rec = readLedger(L, opts.tag);
  if (!["completed", "invalid", "collected"].includes(rec.status)) fail(`job "${rec.tag}" is ${rec.status}, not completed`, { last_error: rec.last_error ?? null });

  let raw = "";
  if (rec.transport === "companion") {
    const r = runCompanion(L, rec.companion, ["result", rec.job_id, "--json", "--cwd", rec.repo]);
    raw = r.json?.storedJob?.result?.rawOutput ?? "";
    rec.thread_id = r.json?.storedJob?.threadId ?? r.json?.job?.threadId ?? rec.thread_id ?? null;
    if (!raw) raw = r.json?.storedJob?.rendered ?? r.stdout ?? "";
  } else {
    raw = fs.existsSync(rec.result_file) ? fs.readFileSync(rec.result_file, "utf8") : "";
  }
  fs.writeFileSync(path.join(L.raw, `${rec.tag}.txt`), raw);

  const schema = JSON.parse(fs.readFileSync(schemaFile(rec.schema), "utf8"));
  const parsed = extractJson(raw);
  const errors = parsed.error ? [parsed.error] : validate(schema, parsed.value);
  if (errors.length) {
    rec.status = "invalid";
    rec.validation_errors = errors.slice(0, 30);
    writeLedger(L, rec);
    out({ ok: true, tag: rec.tag, valid: false, errors: rec.validation_errors, can_repair: !rec.repair_of });
  }

  const result = parsed.value;
  const baseTag = rec.repair_of ?? rec.tag;
  if (rec.mode !== "verify") materialize(L, rec, result);
  result._meta = { tag: baseTag, mode: rec.mode, class: rec.class, transport: rec.transport, model: rec.model, effort: rec.effort, job: rec.job_id ?? null, collected_at: new Date().toISOString() };
  fs.writeFileSync(path.join(L.results, `${baseTag}.json`), JSON.stringify(result, null, 2));
  rec.status = "collected";
  writeLedger(L, rec);
  if (rec.repair_of) {
    const orig = readLedger(L, rec.repair_of);
    orig.status = "collected";
    orig.repaired_by = rec.tag;
    writeLedger(L, orig);
  }
  out({
    ok: true, tag: baseTag, valid: true, mode: rec.mode,
    status: result.status ?? "complete",
    findings: result.findings?.length ?? null,
    safe: result.safe?.length ?? null,
    verdicts: result.verdicts?.length ?? null,
    coverage_gaps: result.coverage_gaps?.length ?? null,
    remaining: result.remaining ?? [],
    result_file: path.join(L.results, `${baseTag}.json`),
  });
}

function cancelOne(L, rec) {
  if (!ACTIVE.has(rec.status)) return { tag: rec.tag, status: rec.status, action: "none" };
  if (rec.transport === "companion") {
    const r = runCompanion(L, rec.companion, ["cancel", rec.job_id, "--json", "--cwd", rec.repo]);
    if (r.code !== 0) return { tag: rec.tag, status: rec.status, action: "cancel-failed", error: (r.stderr || "").slice(0, 300) };
  } else if (pidAlive(rec.pid)) {
    try { process.kill(-rec.pid, "SIGTERM"); } catch { try { process.kill(rec.pid, "SIGTERM"); } catch { /* gone */ } }
  }
  rec.status = "cancelled";
  writeLedger(L, rec);
  return { tag: rec.tag, status: "cancelled", action: "cancelled" };
}

function allLedgers(L) {
  return safeReaddir(L.jobs).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(L.jobs, f), "utf8")));
}

async function cmdCancel(opts) {
  need(opts, "out");
  const L = layout(opts.out);
  const recs = opts.all ? allLedgers(L) : [readLedger(L, opts.tag ?? fail("pass --tag T or --all"))];
  out({ ok: true, results: recs.map((r) => cancelOne(L, r)) });
}

async function cmdStatus(opts) {
  need(opts, "out");
  const L = layout(opts.out);
  const recs = allLedgers(L);
  const by = {};
  for (const r of recs) by[r.status] = (by[r.status] ?? 0) + 1;
  out({ ok: true, counts: by, jobs: recs.map(({ tag, mode, class: c, transport, status, last_error }) => ({ tag, mode, class: c, transport, status, last_error: last_error ?? null })) });
}

async function cmdCleanup(opts) {
  need(opts, "out");
  const L = layout(opts.out);
  const recs = allLedgers(L);
  const cancelled = recs.map((r) => cancelOne(L, r)).filter((x) => x.action !== "none");
  const deleted = [], failed = [];
  if (opts["delete-threads"]) {
    for (const r of recs) {
      if (r.transport !== "companion" || !r.thread_id) continue;
      const d = spawnSync("codex", ["delete", r.thread_id], { encoding: "utf8", timeout: 30000 });
      (d.status === 0 ? deleted : failed).push({ tag: r.tag, thread_id: r.thread_id, ...(d.status === 0 ? {} : { error: (d.stderr || d.stdout || "").trim().slice(0, 300) }) });
    }
  }
  out({
    ok: failed.length === 0,
    cancelled,
    threads_deleted: deleted,
    threads_delete_failed: failed,
    threads_kept: opts["delete-threads"] ? [] : recs.filter((r) => r.thread_id).map((r) => r.thread_id),
    note: "exec-transport runs are --ephemeral (nothing persisted by Codex).",
  });
}

// ───────────────────────────── main ─────────────────────────────

const COMMANDS = { preflight: cmdPreflight, start: (o) => cmdStart(o), repair: cmdRepair, wait: cmdWait, collect: cmdCollect, cancel: cmdCancel, status: cmdStatus, cleanup: cmdCleanup };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  const fn = COMMANDS[cmd];
  if (!fn) fail(`unknown subcommand "${cmd ?? ""}"`, { subcommands: Object.keys(COMMANDS) });
  fn(opts).catch((e) => fail(e?.message ?? String(e)));
}
