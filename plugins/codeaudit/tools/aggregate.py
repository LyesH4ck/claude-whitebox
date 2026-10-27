#!/usr/bin/env python3
"""Step 6.6 aggregator for codeaudit — parses per-finding description.md files and the four-section
_safe-*.md files, de-duplicates by key, applies the confidence gate and the privilege_required severity
caps, resolves endpoints from recon, and emits codeaudit-report.json.

Usage:
  python3 -I "$CA/tools/aggregate.py" <OUTPUT_ROOT> --dry-run            # parse + report violations, write nothing
  python3 -I "$CA/tools/aggregate.py" <OUTPUT_ROOT> --write [--relations plan/_relations.json] [--meta plan/_meta.json]

The relations file may carry `orchestrator_adjustments` (severity_overrides from a class owner's addendum,
additional_locations from a follow-up) — see REPORT_CONTRACT.md. Caps still apply after an override.

Everything it reads is model-authored and therefore untrusted: a malformed file is reported under
`contract_violations`, never fatal, and never silently normalised into something that looks clean.
"""
import collections, glob, json, os, re, sys

OUT = sys.argv[1].rstrip("/")
DRY = "--dry-run" in sys.argv
def arg(flag, default=None):
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else default

SEV = ["informational", "low", "medium", "high", "critical"]
CAP = {"none": "critical", "authenticated": "high", "admin": "high", "maintainer": "medium", "local-root": "medium", "unknown": None}
DISP = {"guard_present", "not_attacker_controlled", "not_reachable", "by_design", "precondition_subsumes", "model_gap",
        "out_of_model_adversary", "out_of_model_component", "out_of_model_non_default_build"}
PREFIX_CLASS = {"inj": "injection", "xss": "xss", "ac": "access-control", "ssrf": "ssrf", "auth": "auth", "sec": "secrets",
                "crypto": "crypto", "deps": "deps", "cfg": "config", "log": "logging", "biz": "business-logic",
                "feat": "feature-abuse", "life": "data-lifecycle", "cli": "client-side", "http": "http-protocol",
                "ai": "ai-llm", "dos": "resource-exhaustion", "sweep": "sweep"}
OWASP = {"injection": "A03:2021 Injection", "xss": "A03:2021 Injection", "auth": "A07:2021 Identification and Authentication Failures",
         "access-control": "A01:2021 Broken Access Control", "ssrf": "A10:2021 Server-Side Request Forgery",
         "business-logic": "A04:2021 Insecure Design", "feature-abuse": "A04:2021 Insecure Design",
         "data-lifecycle": "A01:2021 Broken Access Control", "client-side": "A03:2021 Injection",
         "http-protocol": "A05:2021 Security Misconfiguration", "ai-llm": "A04:2021 Insecure Design", "ai-agent": "A04:2021 Insecure Design",
         "resource-exhaustion": "A04:2021 Insecure Design"}

violations = []
def viol(where, msg): violations.append({"where": where, "issue": msg})

FL = re.compile(r"([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|php|java|kt|go|cs|rs|swift|sql|vue|svelte|erb|twig|html|json|toml|yaml|yml)):(\d+)")

def field(body, label):
    m = re.search(r"\*\*" + re.escape(label) + r"\*\*\s*:?\s*`?([^\n`*]+)`?", body, re.I)
    return m.group(1).strip() if m else None

def section(body, title):
    m = re.search(r"^##\s+" + re.escape(title) + r"[^\n]*\n(.*?)(?=^##\s|\Z)", body, re.S | re.M)
    return m.group(1).strip() if m else ""

def parse_finding(d):
    fid = os.path.basename(d)
    p = os.path.join(d, "description.md")
    try: body = open(p, errors="replace").read()
    except OSError: viol(fid, "description.md unreadable"); return None
    f = {"id": fid, "evidence": f"findings/{fid}/description.md"}
    m = re.match(r"^#\s*\[([^\]]+)\]\s*(.+)$", body.strip().splitlines()[0]) if body.strip() else None
    if m: f["vuln_class"], f["title"] = m.group(1).strip().lower(), m.group(2).strip()
    else:
        f["title"] = (body.strip().splitlines()[0].lstrip("# ").strip() if body.strip() else fid)
        viol(fid, "title line is not `# [vuln_class] title`")
    pre = fid.split("-")[1]
    if f.get("vuln_class") == "ai-agent": f["vuln_class"] = "ai-llm"   # contract name; the agent is ai-agent-auditor
    if "vuln_class" not in f or f["vuln_class"] not in OWASP and f["vuln_class"] != "sweep":
        f["vuln_class"] = PREFIX_CLASS.get(pre, f.get("vuln_class", pre))
    # one-finding-filed-in-another-class case (e.g. auth shard filing resource-exhaustion): keep the declared class
    sev = (field(body, "Severity") or "").lower(); conf = (field(body, "Confidence") or "").lower()
    f["severity_reported"] = sev if sev in SEV else None
    # same leniency as privilege: leading enum token, parenthetical kept as a note
    conf_tok = re.split(r"[\s(]", conf, maxsplit=1)[0] if conf else ""
    f["confidence"] = conf_tok if conf_tok in ("high", "probable", "unconfirmed") else None
    if f["confidence"] and len(conf) > len(conf_tok): f["confidence_note"] = conf[len(conf_tok):].strip(" ()")
    if f["severity_reported"] is None: viol(fid, f"severity missing/invalid: {sev!r}")
    if f["confidence"] is None: viol(fid, f"confidence missing/invalid: {conf!r}")
    # Auditors may legitimately write `none (precondition: …)` — the enum token leads, the parenthetical is
    # a note. Read the leading token; keep the remainder as privilege_note; only an unknown token is a violation.
    pr_raw = (field(body, "Privilege required") or "").strip("` ")
    pr_tok = re.split(r"[\s(]", pr_raw.lower(), maxsplit=1)[0] if pr_raw else ""
    f["privilege_required"] = pr_tok if pr_tok in CAP else "unknown"
    if pr_raw and pr_tok in CAP and len(pr_raw) > len(pr_tok): f["privilege_note"] = pr_raw[len(pr_tok):].strip(" ()")
    if pr_tok not in CAP: viol(fid, f"privilege_required missing/invalid: {pr_raw!r} -> set to unknown, no cap applied")
    cwe = re.search(r"CWE-\d+", body); f["cwe"] = cwe.group(0) if cwe else None
    f["owasp"] = field(body, "OWASP") or OWASP.get(f["vuln_class"])
    loc = section(body, "Location"); mloc = FL.search(loc) or FL.search(body)
    f["location"] = {"file": mloc.group(1), "line": int(mloc.group(2))} if mloc else None
    if not f["location"]: viol(fid, "no file:line location")
    ss = section(body, "Source")
    LBL = r"\*\*%s\*\*(?:\s*\([^)]*\))?\s*:\s*(.+)"
    src = re.search(LBL % "Source", ss, re.I); snk = re.search(LBL % "Sink", ss, re.I)
    f["source"] = src.group(1).strip() if src else None
    f["sink"] = snk.group(1).strip() if snk else None
    if not f["source"] or not FL.search(f["source"]): viol(fid, "source missing or lacks (file:line) — endpoint cannot be resolved")
    slot = re.search(r"slot\s*`?([A-Za-z-]+)`?", ss or body); f["slot_type"] = slot.group(1) if slot else None
    ws = re.search(r"\*\*Write site\*\*\s*:\s*(.+)", body); f["write_site"] = ws.group(1).strip() if ws else None
    r = field(body, "Reachable"); f["externally_reachable"] = (None if r is None else r.strip().lower().startswith(("true","yes","network","external")))
    pa = section(body, "Prior art"); f["prior_art"] = pa[:1200] if pa else None
    tr = section(body, "Source") ; path = re.search(r"\*\*Path\*\*\s*:\s*(.+)", tr)
    f["trace"] = [x.strip() for x in re.split(r"→|->", path.group(1))] if path else None
    f["status"] = "open"
    f["shard"] = "-".join(fid.split("-")[2:-1]) or None
    return f

def dedup_key(f):
    s = FL.search(f["source"] or ""); loc = f.get("location") or {}
    return (f["vuln_class"], f"{loc.get('file')}:{loc.get('line')}", f"{s.group(1)}:{s.group(2)}" if s else None, f["slot_type"])

def apply_caps(f):
    sev = f["severity_reported"]; cap = CAP.get(f["privilege_required"])
    f["severity"] = sev
    f["severity_cap_applied"] = None
    if sev and cap and SEV.index(sev) > SEV.index(cap):
        f["severity"] = cap; f["severity_cap_applied"] = f"{sev} -> {cap} (privilege_required={f['privilege_required']})"
    return f

def parse_safe(p):
    name = os.path.basename(p); body = open(p, errors="replace").read()
    cls = name[len("_safe-"):-3]
    out = {"tested_not_vulnerable": [], "design_properties": [], "unverified_assumptions": [], "coverage_gaps": []}
    present = {k: bool(re.search(r"^##\s+" + k + r"\s*$", body, re.M)) for k in out}
    for k, ok in present.items():
        if not ok: viol(name, f"missing section ## {k}")
    for k in out:
        sec = section(body, k)
        for line in sec.splitlines():
            if not line.lstrip().startswith("- "): continue
            item = line.lstrip()[2:].strip()
            if item.lower() in ("none", "- none", "n/a"): continue
            if k == "tested_not_vulnerable":
                m = re.match(r"\[([a-z_]+)\]\s*(.*)", item)
                disp = m.group(1) if m else None; detail = m.group(2) if m else item
                if disp not in DISP:
                    viol(name, f"tested_not_vulnerable line without a valid [disposition]: {item[:70]!r} -> model_gap")
                    disp = "model_gap"
                out[k].append({"vuln_class": cls, "disposition": disp, "detail": detail, "shard": cls})
            elif k == "unverified_assumptions":
                # The contract asks for both halves (what was investigated, what evidence would settle it);
                # auditors phrase the seam many ways. Accept the common ones before calling it a violation.
                inv = re.split(r"→|->|\bstill needs\b|\bevidence needed\b|\bwould settle\b|\bneeds?:|\bto settle\b|\bwould confirm\b|\bsettled by\b|\brequires\b", item, maxsplit=1, flags=re.I)
                need = re.sub(r"^\s*(?:still needs|evidence needed|needs|to settle|would settle|settled by|requires)\s*:?\s*", "", inv[1], flags=re.I).strip(" *:") if len(inv) > 1 else None
                out[k].append({"vuln_class": cls, "investigated": re.sub(r"^\s*investigated\s*:\s*", "", inv[0], flags=re.I).strip(" *:"), "evidence_needed": need, "detail": item})
                if len(inv) < 2: viol(name, f"unverified_assumptions line has no recognisable 'evidence needed' half: {item[:60]!r}")
            elif k == "coverage_gaps":
                # "item — reason → recommended: action": the arrow and the label are ONE seam, not two.
                parts = [x.strip(" *") for x in re.split(r"\s*(?:(?:→|->)\s*)?recommended(?:\s+action)?\s*:\s*|\s*—\s*|\s*(?:→|->)\s*", item) if x.strip(" *")]
                out[k].append({"item": parts[0] if parts else item, "reason": (parts[1] if len(parts) > 1 else ""), "recommended_action": (parts[2] if len(parts) > 2 else ""), "vuln_class": cls})
            else:
                out[k].append({"vuln_class": cls, "detail": item})
    return out

# ------------------------------------------------------------------ run
findings = [f for f in (parse_finding(d) for d in sorted(glob.glob(f"{OUT}/findings/finding-*"))) if f]
safe_all = {k: [] for k in ("tested_not_vulnerable", "design_properties", "unverified_assumptions", "coverage_gaps")}
safe_files = sorted(glob.glob(f"{OUT}/findings/_safe-*.md"))
for p in safe_files:
    for k, v in parse_safe(p).items(): safe_all[k].extend(v)

# dedup
seen = {}; kept = []; merged = []
for f in findings:
    k = dedup_key(f)
    if k in seen and k[1] != "None:None":
        seen[k]["merged_ids"] = seen[k].get("merged_ids", []) + [f["id"]]; merged.append((f["id"], seen[k]["id"]))
    else:
        seen[k] = f; kept.append(f)

# confidence gate
gaps_from_unconfirmed = []
final = []
for f in kept:
    if f["confidence"] == "unconfirmed" or f["confidence"] is None:
        gaps_from_unconfirmed.append({"item": f"{f['id']}: {f['title']}", "reason": "confidence unconfirmed/missing — not a finding per contract", "recommended_action": "re-trace", "vuln_class": f["vuln_class"]})
    else:
        final.append(apply_caps(f))

# endpoint resolution from recon
try:
    inv = json.load(open(f"{OUT}/recon/sink-inventory.json"))
    at_index = collections.defaultdict(list)
    for ep in inv.get("entry_points", []):
        for s in ep.get("sources", []):
            at_index[s.get("at")].append((ep, s))
    for f in final:
        m = FL.search(f["source"] or "")
        if not m: continue
        hits = at_index.get(f"{m.group(1)}:{m.group(2)}") or at_index.get(f"{m.group(1).lstrip('./')}:{m.group(2)}")
        if hits and len({(e.get("method"), e.get("path")) for e, _ in hits}) == 1 and hits[0][0].get("path"):
            ep, s = hits[0]
            f["endpoint"] = {"method": ep.get("method"), "path": ep.get("path"), "param": s.get("name"), "in": s.get("in")}
except Exception as e:
    viol("recon", f"endpoint resolution skipped: {e}")

vuln = [f for f in final if f["severity"] and f["severity"] != "informational"]
summary = {s: sum(1 for f in final if f["severity"] == s) for s in SEV}
summary["total"] = len(vuln)
summary["informational"] = sum(1 for f in final if f["severity"] == "informational")

report = {
    "findings": final,
    "summary": summary,
    "tested_not_vulnerable": safe_all["tested_not_vulnerable"],
    "design_properties": safe_all["design_properties"],
    "unverified_assumptions": safe_all["unverified_assumptions"],
    "coverage_gaps": safe_all["coverage_gaps"] + gaps_from_unconfirmed,
    "finding_relations": {"duplicates": [{"canonical_id": c, "duplicate_ids": [d], "reason": "identical dedup key (class, sink, source, slot)"} for d, c in merged], "subsumed": [], "chains": []},
    "contract_violations": violations,
    "aggregation_stats": {"finding_dirs": len(findings), "kept_after_dedup": len(kept), "final": len(final), "safe_files": len(safe_files),
                          "caps_applied": sum(1 for f in final if f.get("severity_cap_applied")),
                          "endpoints_resolved": sum(1 for f in final if f.get("endpoint"))},
}
rel = arg("--relations"); meta = arg("--meta")
if rel and os.path.exists(rel):
    r = json.load(open(rel));
    for k in ("duplicates", "subsumed", "chains"): report["finding_relations"][k] += r.get(k, [])
    # orchestrator adjustments (Step 6.6 judgement, evidence-cited): severity revisions from a class owner's
    # addendum, and additional locations found by a follow-up for an existing finding. Caps still apply.
    adj = r.get("orchestrator_adjustments", {})
    byid = {f["id"]: f for f in final}
    for o in adj.get("severity_overrides", []):
        f = byid.get(o["id"])
        if not f: viol(o["id"], "severity override targets unknown finding"); continue
        if o["severity"] not in SEV: viol(o["id"], f"severity override invalid: {o['severity']}"); continue
        f["severity_reported_by_filer"] = f["severity_reported"]; f["severity_reported"] = o["severity"]
        apply_caps(f)
        f["severity_revision"] = {"from": f["severity_reported_by_filer"], "to": f["severity"], "by": o.get("by"), "reason": o["reason"], "evidence": o.get("evidence")}
    for o in adj.get("additional_locations", []):
        f = byid.get(o["id"])
        if not f: viol(o["id"], "additional_locations targets unknown finding"); continue
        f["locations"] = f.get("locations", []) + o["locations"]
        f["locations_note"] = o.get("note")
    for f in final:
        if f.get("severity_revision"):
            vuln = [x for x in final if x["severity"] and x["severity"] != "informational"]
            for s in SEV: summary[s] = sum(1 for x in final if x["severity"] == s)
            summary["total"] = len(vuln)
            break
if meta and os.path.exists(meta): report = {**json.load(open(meta)), **report}

print(f"findings dirs {len(findings)} | after dedup {len(kept)} | final {len(final)} | vuln tally {summary['total']} | informational {summary['informational']}")
print("severity (after caps):", {s: summary[s] for s in SEV})
print(f"caps applied: {report['aggregation_stats']['caps_applied']} | endpoints resolved: {report['aggregation_stats']['endpoints_resolved']} | safe files {len(safe_files)}")
print("evidence arrays:", {k: len(v) for k, v in safe_all.items()}, "+ unconfirmed->gaps", len(gaps_from_unconfirmed))
print(f"contract violations: {len(violations)}")
for v in violations[:40]: print(f"  ! {v['where']}: {v['issue']}")
if DRY:
    print("\nper-finding (id | class | reported->final | conf | priv | endpoint):")
    for f in final: print(f"  {f['id']:34} {f['vuln_class']:18} {f['severity_reported']}->{f['severity']:<13} {f['confidence']:<8} {f['privilege_required']:<13} {(f.get('endpoint') or {}).get('path','-')}{'  note: ' + f['privilege_note'][:50] if f.get('privilege_note') else ''}")
else:
    json.dump(report, open(f"{OUT}/codeaudit-report.json", "w"), indent=1, ensure_ascii=False)
    print(f"wrote {OUT}/codeaudit-report.json")
