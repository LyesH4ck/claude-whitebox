#!/usr/bin/env python3
"""Step 6.6 deliverable renderer — report.md (fixed REPORT_CONTRACT template) + operator extras.

Usage: python3 -I "$CA/tools/render.py" <OUTPUT_ROOT> [--narrative plan/_narrative.json]

Reads codeaudit-report.json (written by aggregate.py --write), each finding's description.md (for the
"Why vulnerable" / "Code" blocks) and the orchestrator narrative file (executive summary, remediation
groups, model corrections). Writes report.md, exec-summary.md, remediation-plan.md, findings.csv,
codeaudit.sarif. Deterministic: same inputs → same bytes.
"""
import csv, json, os, re, sys, collections

if len(sys.argv) < 2 or sys.argv[1].startswith("-"):
    print(__doc__); sys.exit(2)          # usage, not a traceback: these are run by hand too
OUT = sys.argv[1].rstrip("/")
def arg(flag, default=None):
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else default

R = json.load(open(f"{OUT}/codeaudit-report.json"))
NARR = arg("--narrative", f"{OUT}/plan/_narrative.json")
TODO = "TODO-ORCHESTRATOR: write this in plan/_narrative.json (see OUTPUT_STRUCTURE.md → narrative contract)"
DEFAULTS = {
    "plugin_version": "", "coverage_statement": TODO, "reconciliation_statement": TODO, "sweep_statement": TODO,
    "executive_summary": [TODO], "model_corrections": [], "cross_references": [], "design_properties_lead": [],
    "coverage_gaps_lead": [], "exec_summary_page": [TODO], "exec_top_n": 6, "exec_boundaries": [TODO], "remediation_groups": [],
}
N = {**DEFAULTS, **(json.load(open(NARR)) if os.path.exists(NARR) else {})}
META = R.get("metadata", {})
SCOPE = META.get("scope", {})
def mget(k, d="—"): return META.get(k, d)
SEV_ORDER = ["critical", "high", "medium", "low", "informational"]
findings = sorted(R["findings"], key=lambda f: (SEV_ORDER.index(f["severity"]), {"high": 0, "probable": 1}.get(f["confidence"], 2), f["id"]))
by_id = {f["id"]: f for f in findings}

def section(body, title):
    m = re.search(r"^##\s+" + re.escape(title) + r"[^\n]*\n(.*?)(?=^##\s|\Z)", body, re.S | re.M)
    return m.group(1).strip() if m else ""

def desc(f):
    p = f"{OUT}/{f['evidence']}"
    try: return open(p, errors="replace").read()
    except OSError: return ""

def first_code_block(text, max_lines=18):
    m = re.search(r"```[^\n]*\n(.*?)```", text, re.S)
    if not m: return None
    lines = m.group(1).rstrip("\n").splitlines()
    lang = re.search(r"```([^\n]*)\n", text).group(1)
    body = "\n".join(lines[:max_lines]) + ("\n…" if len(lines) > max_lines else "")
    return f"```{lang}\n{body}\n```"

def one_para(text, limit=600):
    t = " ".join(text.split())
    return t if len(t) <= limit else t[:limit].rsplit(" ", 1)[0] + " …"

def plural(n, w): return f"{n} {w}{'' if n == 1 else 's'}"

# ------------------------------------------------------------------ report.md
L = []
w = L.append
w(f"# Code Security Audit — {R['engagement']}\n")
w(f"**Repository:** `{R['repo']}` @ `{R['commit']}` (branch `{R.get('branch','main')}`)  ")
w(f"**Date:** {R['date']}   **Auditor:** codeaudit {N.get('plugin_version','')} orchestrated by the operator (Claude Code)  ")
w(f"**Mode:** static (no live target, no exploitation) — **defensive white-box source-code audit**  ")
w(f"**Scope:** {SCOPE.get('code_paths','—')}  |  **Out of scope:** {SCOPE.get('out_of_scope','—')}  ")
w(f"**Classes audited:** {', '.join(mget('classes_audited', []))}  ")
if META.get("classes_not_selected"): w(f"**Classes not selected:** {', '.join(META['classes_not_selected'])} — {META.get('classes_not_selected_reason','')}  ")
w(f"**Depth:** {mget('depth')}  ·  **Coverage:** {N['coverage_statement']}\n")

w("## Executive Summary\n")
for p in N["executive_summary"]: w(p + "\n")
s = R["summary"]
w("| Severity | Count |\n|---|---|")
for k in SEV_ORDER: w(f"| {k} | {s.get(k, 0)} |")
w(f"| **vulnerabilities (excl. informational)** | **{s['total']}** |")
if s.get("accepted_risk"): w(f"| accepted risk (listed, excluded from the tally) | {s['accepted_risk']} |")
w("")
conf = collections.Counter(f["confidence"] for f in findings)
revised = sum(1 for f in findings if f.get("severity_revision"))
w(f"Confidence: {conf.get('high',0)} high · {conf.get('probable',0)} probable · 0 unconfirmed in `findings[]` (unconfirmed items are listed under Coverage Gaps). Severity caps from `privilege_required` applied at aggregation: {R['aggregation_stats']['caps_applied']}." + (f" {plural(revised, 'severity')} revised after filing (see the finding's *Severity revision* line)." if revised else "") + "\n")
AS = R.get("aggregation_stats", {})
if AS.get("verified"):
    w(f"Independent verification: {AS['verified']} verdicts from the finding-verifier — {AS.get('verified_confirmed', 0)} confirmed, {AS.get('verified_uncertain', 0)} uncertain (confidence held at `probable`), {AS.get('refuted', 0)} refuted and moved to *Vectors Tested — Not Vulnerable*." + (f" {AS['unverified_at_or_above_min']} finding(s) at or above the verification threshold carry no verdict and are listed under Coverage Gaps." if AS.get("unverified_at_or_above_min") else "") + "\n")

RD = R.get("run_diff")
if RD:
    w("## Changes Since Previous Run\n")
    w(f"Compared by stable fingerprint against `{RD.get('previous_engagement') or RD.get('previous_report')}` ({RD.get('previous_date') or 'date unknown'}): **{len(RD['new'])} new**, **{len(RD['persisting'])} persisting**, **{len(RD['not_refound'])} not re-found**. A fingerprint hashes class, sink file, sink and source expressions and slot — never a line number — so a finding survives unrelated edits; a renamed sink file reads as new.\n")
    if RD["new"]: w("- **New:** " + ", ".join(f"[`{i}`](#{i})" for i in RD["new"]))
    if RD["persisting"]: w("- **Persisting:** " + ", ".join(f"[`{i}`](#{i})" for i in RD["persisting"]))
    if RD["not_refound"]:
        w("- **Not re-found (verify before calling any of these fixed):**")
        for p in RD["not_refound"]:
            loc = p.get("location") or {}
            w(f"  - `{p.get('id')}` ({p.get('severity')}{', was accepted-risk' if p.get('status') == 'accepted-risk' else ''}) — {p.get('title')} — `{loc.get('file')}:{loc.get('line')}`")
    w("")

SK = R.get("skipped_paths") or []
if SK:
    w("## Paths an Auditor Did Not Fully Analyse\n")
    w("Each line is a path an auditor declared it declined, refused or could not finish — the skipped register from its evidence file. These are coverage gaps of a specific kind: the orchestrator re-dispatches on the path; a report that omitted them would read as if the class had been traced there.\n")
    for g in SK: w(f"- `{g['item']}` ({g.get('vuln_class')}) — {g.get('reason') or 'no reason given'}")
    w("")

if N.get("model_corrections"):
    w("### Threat-model corrections established during the audit\n")
    w("The threat model (`recon/threat-model.json`) is the contract every auditor cited when ruling a sink out. These rows were overturned or refined from source during the waves; the report stands on the corrected model.\n")
    for c in N["model_corrections"]: w(f"- {c}")
    w("")

w("## Findings by Severity\n")
for f in findings:
    cwe = f", {f['cwe']}" if f.get("cwe") else ""
    w(f"### [{f['severity'].upper()}] {f['title']}  ({f['vuln_class']}, {f.get('owasp','')}{cwe})")
    w(f"<a id=\"{f['id']}\"></a>")
    reach = {True: "yes (network)", False: "no", None: "see trace"}[f.get("externally_reachable")]
    pr = f["privilege_required"] + (f" — {f['privilege_note']}" if f.get("privilege_note") else "")
    cn = f" ({f['confidence_note']})" if f.get("confidence_note") else ""
    w(f"- **Id:** `{f['id']}`   **Fingerprint:** `{f.get('fingerprint', '—')}`   **Confidence:** {f['confidence']}{cn}   **Reachable:** {reach}   **Privilege required:** {pr}")
    if f.get("status") == "accepted-risk":
        a = f.get("accepted") or {}
        w(f"- **Status:** accepted-risk — {a.get('reason', 'no reason recorded')}" + (f" (by {a['by']}" + (f", {a['date']}" if a.get("date") else "") + ")" if a.get("by") else "") + " — excluded from the severity tally")
    if f.get("change") == "new": w(f"- **Change:** new since the previous run" + (f" (first seen {f['first_seen']})" if f.get("first_seen") else ""))
    elif f.get("change") == "persisting": w(f"- **Change:** persisting" + (f" since {f['first_seen']}" if f.get("first_seen") else "") + (f" (was `{f['previous_id']}`)" if f.get("previous_id") else ""))
    if f.get("severity_revision"):
        rv = f["severity_revision"]
        w(f"- **Severity revision:** {rv['from']} → {rv['to']} by {rv['by']} — {rv['reason']} (evidence: `{rv['evidence']}`)")
    if f.get("severity_cap_applied"): w(f"- **Severity cap applied:** {f['severity_cap_applied']}")
    loc = f.get("location") or {}
    w(f"- **Location:** `{loc.get('file')}:{loc.get('line')}`")
    if f.get("locations"):
        w(f"- **Additional locations ({len(f['locations'])}, same root cause):** " + "; ".join(f"`{l['file']}:{l['line']}` ({l.get('channel') or l.get('note','')})" for l in f["locations"]))
    if f.get("endpoint"):
        e = f["endpoint"]; w(f"- **Endpoint:** `{e.get('method')} {e.get('path')}` — param `{e.get('param')}` in `{e.get('in')}`")
    w(f"- **Source → Sink:** {f.get('source') or '—'} → {f.get('sink') or '—'}  (slot: {f.get('slot_type') or '—'})")
    if f.get("trace"): w("- **Trace:** " + " → ".join(f["trace"]))
    body = desc(f)
    why = section(body, "Why it is vulnerable") or section(body, "Why vulnerable")
    if why: w(f"- **Why vulnerable:** {one_para(why)}")
    code = first_code_block(section(body, "Code"))
    if code: w("- **Code:**\n" + "\n".join("  " + x for x in code.splitlines()))
    rem = section(body, "Remediation")
    if rem: w(f"- **Remediation:** {one_para(rem, 900)}")
    if f.get("prior_art"): w(f"- **Prior art:** {one_para(f['prior_art'], 400)}")
    rv = f.get("revalidation")
    if rv:
        tail = f" (cited `{rv['cited']}`)" if rv.get("cited") else ""
        ov = f" — refutation overridden by {rv['overridden'].get('by')}: {rv['overridden'].get('reason')}" if rv.get("overridden") else ""
        w(f"- **Independent verification:** {rv['verdict']} — {one_para(rv.get('reasoning') or '', 420)}{tail}{ov}")
    else:
        w("- **Independent verification:** none")
    w(f"- **Depth layer:** `{os.path.dirname(f['evidence'])}/` (description.md, trace.md, snippet.txt{', verification.md' if rv else ''})")
    w("")

# evidence arrays grouped by class
def grouped(items, key="vuln_class"):
    g = collections.OrderedDict()
    for it in items: g.setdefault(it.get(key) or "unknown", []).append(it)
    return g

RF = R.get("refuted") or []
if RF:
    w("## Refuted by Independent Verification\n")
    w(f"{plural(len(RF), 'finding')} filed by an auditor and refuted by the finding-verifier, which rebuilt the path from the sink and cited the line that discharges it. Each is kept here and under *Vectors Tested — Not Vulnerable* so the removal is visible; the filed write-up stays in the finding's directory next to `verification.md`.\n")
    for r_ in RF:
        w(f"- `{r_['id']}` ({r_['vuln_class']}, filed {r_.get('severity_reported')}) — {r_['title']}  \n  [{r_.get('disposition')}] {one_para(r_.get('reasoning') or '', 360)} (cited `{r_.get('cited')}`)")
    w("")

w("## Vectors Tested — Not Vulnerable\n")
tnv = R["tested_not_vulnerable"]
disp = collections.Counter(t.get("disposition") for t in tnv)
w(f"{len(tnv)} verdicted vectors. Disposition tally: " + ", ".join(f"`{k}` {v}" for k, v in disp.most_common()) + ". Each line is a sink or source an auditor traced and ruled out from source, with the cited guard.\n")
for cls, items in grouped(tnv).items():
    w(f"### {cls} ({len(items)})")
    for t in items: w(f"- [{t.get('disposition') or 'model_gap'}] {one_para(t['detail'], 420)}")
    w("")

rel = R.get("finding_relations", {})
if any(rel.get(k) for k in ("chains", "subsumed", "duplicates")):
    w("## Related & Chained Findings\n")
    if rel.get("chains"):
        w("### Chains — findings that compose into something a per-class reader cannot see\n")
        for c in rel["chains"]:
            members = ", ".join(f"`{i}` ({by_id[i]['severity']})" if i in by_id else f"`{i}`" for i in c["finding_ids"])
            w(f"- **Members:** {members}  \n  **Composed severity:** {c['composed_severity']}  ·  **Exploit order:** {c['exploit_order']}  \n  {c['reason']}")
        w("")
    if rel.get("subsumed"):
        w("### Subsumed — fix the parent first\n")
        for s_ in rel["subsumed"]: w(f"- `{s_.get('parent_id')}` closes `{', '.join(s_.get('child_ids', []))}` — {s_.get('reason')}")
        w("")
    if rel.get("duplicates"):
        w("### Duplicates\n")
        for d in rel["duplicates"]: w(f"- canonical `{d['canonical_id']}` ← {', '.join(f'`{x}`' for x in d['duplicate_ids'])} — {d['reason']}")
        w("")
    if N.get("cross_references"):
        w("### Cross-references that are *not* relations\n")
        for x in N["cross_references"]: w(f"- {x}")
        w("")

dp = R["design_properties"]
if dp:
    w("## Design Properties — Intentional Behaviour\n")
    if N.get("design_properties_lead"):
        for p in N["design_properties_lead"]: w(p + "\n")
    for cls, items in grouped(dp).items():
        w(f"### {cls} ({len(items)})")
        for t in items: w(f"- {one_para(t['detail'], 420)}")
        w("")

ua = R["unverified_assumptions"]
if ua:
    w("## Unverified Assumptions — Not Decidable From Source\n")
    w("This section is the honest boundary of a static audit: each line names what was investigated and the deployment or platform fact that would settle it. None of these were dropped to make the report look cleaner.\n")
    for cls, items in grouped(ua).items():
        w(f"### {cls} ({len(items)})")
        for t in items:
            inv = t.get("investigated"); need = t.get("evidence_needed")
            if inv and need: w(f"- {one_para(inv, 300)} → **still needs:** {one_para(need, 220)}")
            else: w(f"- {one_para(t.get('detail') or inv or '', 420)}")
        w("")

cg = R["coverage_gaps"]
w("## Coverage Gaps & Recommendations\n")
if N.get("coverage_gaps_lead"):
    for p in N["coverage_gaps_lead"]: w(p + "\n")
for cls, items in grouped(cg).items():
    w(f"### {cls} ({len(items)})")
    for t in items:
        tail = f" — {t['reason']}" if t.get("reason") else ""
        act = f" → *{t['recommended_action']}*" if t.get("recommended_action") else ""
        w(f"- {one_para(t['item'], 300)}{one_para(tail, 260)}{act}")
    w("")

w("## Appendix — Methodology & Scope\n")
if R.get("audit_nature"): w(f"- **Nature of the engagement:** {R['audit_nature']}")
if META.get("pipeline"): w(f"- **Pipeline:** {META['pipeline']}")
if META.get("preflight"): w(f"- **Preflight:** exit {META['preflight'].get('exit')}, {META['preflight'].get('blocking')} blocking, {META['preflight'].get('warnings')} warnings")
tm = META.get("threat_model")
if tm: w(f"- **Threat model:** {tm.get('entry_point_rows')} entry-point rows ({tm.get('documented')} parameters with documented provenance, {tm.get('inferred')} inferred), {tm.get('controls')} design controls, {tm.get('open_questions')} open questions handed to auditors")
w(f"- **Classes:** {', '.join(mget('classes_audited', []))}  ·  **Languages:** {', '.join(mget('languages', []))}  ·  **Files in scope:** {mget('files_in_scope')}  ·  **Entry points mapped:** {mget('entry_points_mapped')}")
w("- **Ecosystems (version facts from lockfiles, never from memory):**")
for e in META.get("ecosystems", []):
    w(f"  - `{e['key']}` — lockfile `{e.get('lockfile')}`" + (f"; {e['notable']}" if e.get("notable") else "") + (f"; {e['note']}" if e.get("note") else ""))
w(f"- **Verdict discipline:** every finding carries a re-readable source→sink trace with `file:line`; `confidence: high` only with a complete trace; anything short of that is `probable` or lands in Coverage Gaps. Severity caps: none→critical, authenticated→high, admin→high, maintainer→medium, local-root→medium, unknown→no cap.")
w(f"- **Reconciliation (Step 6.5):** {N['reconciliation_statement']}")
w(f"- **Adversarial sweep (Step 6.5b):** {N['sweep_statement']}")
w(f"- **Aggregation:** {R['aggregation_stats']['finding_dirs']} finding directories → {R['aggregation_stats']['final']} findings after de-duplication and the confidence gate; {R['aggregation_stats']['safe_files']} evidence files split into the four arrays; {len(R.get('contract_violations', []))} minor contract-format deviations recorded in `codeaudit-report.json.contract_violations` (none affects a verdict).")
w("- **Operational notes:**")
for n in META.get("operational_notes", []): w(f"  - {n}")
w("- **Tools used:** Read/Grep/Glob over the checked-out tree, `git ls-files`, `python3 -I` for mechanical reconciliation and aggregation. No scanner, no runtime, no network request to any Conductor system.")
w("")
open(f"{OUT}/report.md", "w").write("\n".join(L))

# ------------------------------------------------------------------ exec-summary.md
E = []
E.append(f"# Executive Summary — Conductor source-code security audit ({R['date']})\n")
for p in N["exec_summary_page"]: E.append(p + "\n")
E.append("| Severity | Count |\n|---|---|")
for k in SEV_ORDER: E.append(f"| {k} | {s.get(k, 0)} |")
E.append("")
E.append("## What to fix first\n")
for i, g in enumerate(N["remediation_groups"][:N.get("exec_top_n", 6)], 1):
    E.append(f"{i}. **{g['title']}** — {g['business_impact']} *(priority {g['priority']})*")
E.append("")
E.append("## What this audit did and did not do\n")
for p in N["exec_boundaries"]: E.append("- " + p)
E.append("")
open(f"{OUT}/exec-summary.md", "w").write("\n".join(E))

# ------------------------------------------------------------------ remediation-plan.md
P = []
P.append(f"# Remediation Plan — {R['engagement']}\n")
P.append("Ticket-style, grouped by fix (one ticket closes every finding it lists). Priority P0 = fix before the next release; P1 = this quarter; P2 = backlog / hardening. Severities are the findings' own (capped) ratings; a chain's composed severity is noted where it changes the order.\n")
covered = set()
for i, g in enumerate(N["remediation_groups"], 1):
    ids = [x for x in g["finding_ids"] if x in by_id]
    covered.update(ids)
    top = max((by_id[x]["severity"] for x in ids), key=SEV_ORDER.index, default="informational") if ids else "—"
    P.append(f"## T{i:02d} · [{g['priority']}] {g['title']}")
    P.append(f"**Area:** {g['area']}   **Highest member severity:** {top}   **Findings:** " + ", ".join(f"[`{x}`](report.md#{x})" for x in ids))
    P.append(f"\n**Fix:** {g['fix']}\n")
    if g.get("acceptance"): P.append(f"**Acceptance check (static):** {g['acceptance']}\n")
    for x in ids:
        f = by_id[x]; loc = f.get("location") or {}
        P.append(f"- `{x}` ({f['severity']}, {f['confidence']}) — {f['title']} — `{loc.get('file')}:{loc.get('line')}`")
    P.append("")
left = [f for f in findings if f["id"] not in covered]
if left:
    P.append("## Unassigned findings (each is its own ticket)\n")
    for f in left:
        loc = f.get("location") or {}
        P.append(f"- `{f['id']}` ({f['severity']}) — {f['title']} — `{loc.get('file')}:{loc.get('line')}` — {one_para(section(desc(f), 'Remediation'), 400)}")
    P.append("")
open(f"{OUT}/remediation-plan.md", "w").write("\n".join(P))

# ------------------------------------------------------------------ findings.csv
with open(f"{OUT}/findings.csv", "w", newline="") as fh:
    cw = csv.writer(fh)
    cw.writerow(["id", "fingerprint", "status", "change", "first_seen", "verification", "vuln_class", "severity", "severity_reported", "confidence", "privilege_required", "file", "line", "endpoint", "cwe", "owasp", "title", "evidence"])
    for f in findings:
        loc = f.get("location") or {}; e = f.get("endpoint") or {}
        cw.writerow([f["id"], f.get("fingerprint") or "", f.get("status") or "open", f.get("change") or "", f.get("first_seen") or "", (f.get("revalidation") or {}).get("verdict") or "", f["vuln_class"], f["severity"], f.get("severity_reported_by_filer") or f.get("severity_reported"), f["confidence"], f["privilege_required"],
                     loc.get("file"), loc.get("line"), f"{e.get('method','')} {e.get('path','')}".strip(), f.get("cwe") or "", f.get("owasp") or "", f["title"], f["evidence"]])

# ------------------------------------------------------------------ codeaudit.sarif
LEVEL = {"critical": "error", "high": "error", "medium": "warning", "low": "note", "informational": "note"}
rules = {}
results = []
for f in findings:
    rid = f"{f['vuln_class']}/{f.get('cwe') or 'CWE-unknown'}"
    rules.setdefault(rid, {"id": rid, "name": f["vuln_class"], "shortDescription": {"text": f"{f['vuln_class']} ({f.get('cwe') or 'CWE unknown'})"},
                           "properties": {"owasp": f.get("owasp")}})
    loc = f.get("location") or {}
    res = {
        "ruleId": rid, "level": LEVEL[f["severity"]],
        "message": {"text": f"[{f['severity']}] {f['title']} (confidence {f['confidence']}, privilege_required {f['privilege_required']}). Evidence: {f['evidence']}"},
        "locations": [{"physicalLocation": {"artifactLocation": {"uri": loc.get("file"), "uriBaseId": "%SRCROOT%"}, "region": {"startLine": int(loc.get("line") or 1)}}}],
        # `codeaudit/fingerprint` is the cross-run identity (stable across line moves); the id is per-run.
        "partialFingerprints": {"codeaudit/id": f["id"], **({"codeaudit/fingerprint": f["fingerprint"]} if f.get("fingerprint") else {})},
        "properties": {"codeaudit": {**{k: f.get(k) for k in ("id", "fingerprint", "status", "change", "first_seen", "vuln_class", "severity", "confidence", "privilege_required", "source", "sink", "slot_type", "endpoint", "severity_cap_applied")},
                                     "verification": (f.get("revalidation") or {}).get("verdict")}},
    }
    # SARIF baselineState is the standard way to say "new vs unchanged since the baseline run".
    if f.get("change") in ("new", "persisting"): res["baselineState"] = {"new": "new", "persisting": "unchanged"}[f["change"]]
    # An accepted risk is a SARIF suppression, so code-scanning UIs hide it without losing it.
    if f.get("status") == "accepted-risk":
        a = f.get("accepted") or {}
        res["suppressions"] = [{"kind": "external", "status": "accepted", "justification": a.get("reason") or "accepted risk"}]
    if f.get("locations"):
        res["relatedLocations"] = [{"id": i + 1, "physicalLocation": {"artifactLocation": {"uri": l["file"], "uriBaseId": "%SRCROOT%"}, "region": {"startLine": int(l["line"])}},
                                    "message": {"text": l.get("channel") or l.get("note") or "same root cause"}} for i, l in enumerate(f["locations"])]
    results.append(res)
sarif = {"version": "2.1.0", "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
         "runs": [{"tool": {"driver": {"name": "codeaudit", "version": N.get("plugin_version") or "unknown", "informationUri": "https://github.com/LyesH4ck/claude-whitebox", "rules": list(rules.values())}},
                   "originalUriBaseIds": {"%SRCROOT%": {"uri": "file://" + R["repo"].rstrip("/") + "/"}},
                   "versionControlProvenance": [{"repositoryUri": "file://" + R["repo"], "revisionId": R["commit"], "branch": R.get("branch", "main")}],
                   "results": results}]}
json.dump(sarif, open(f"{OUT}/codeaudit.sarif", "w"), indent=1, ensure_ascii=False)

# ------------------------------------------------------------------ pr-comment.md (--pr-comment)
# A review-sized summary: with a run_diff, only the findings this run introduced (change == "new"); without
# one, every open finding. Accepted risks and refuted findings never appear. Descriptions are clipped so a
# multi-finding comment stays well under GitHub's 65 KiB limit; the full text stays in report.md. The file
# is written only when there is something to say, so a green run leaves nothing behind.
pr_written = None
if "--pr-comment" in sys.argv:
    rd = R.get("run_diff")
    sel = [f for f in findings if f.get("status") != "accepted-risk" and (f.get("change") == "new" if rd else True)]
    if sel:
        BADGE = {"critical": "🔴 CRITICAL", "high": "🟠 HIGH", "medium": "🟡 MEDIUM", "low": "⚪ LOW", "informational": "ℹ️ INFO"}
        C = []
        scope = f"new since `{rd.get('previous_engagement') or rd.get('previous_report')}`" if rd else "all open findings"
        C.append(f"## 🔎 codeaudit found {plural(len(sel), 'finding')} ({scope})\n")
        tally = collections.Counter(f["severity"] for f in sel)
        C.append(" · ".join(f"{BADGE[s]} ×{tally[s]}" for s in SEV_ORDER if tally.get(s)))
        C.append(f"\n<sub>engagement `{R['engagement']}` · commit `{R['commit']}`" + (f" · {len(rd['persisting'])} persisting from the previous run not shown" if rd else "") + "</sub>\n")
        for f in sel:
            loc = f.get("location") or {}
            C.append(f"### {BADGE[f['severity']]} · `{loc.get('file')}:{loc.get('line')}`\n")
            C.append(f"**{f['title']}**  \n<sub>`{f['id']}` · {f['vuln_class']} · confidence {f['confidence']} · privilege {f['privilege_required']}" + (f" · verified: {f['revalidation']['verdict']}" if f.get("revalidation") else "") + "</sub>\n")
            body = desc(f)
            why = section(body, "Why it is vulnerable") or section(body, "Why vulnerable")
            if why: C.append(one_para(why, 600) + "\n")
            rem = section(body, "Remediation")
            if rem: C.append(f"**Fix:** {one_para(rem, 400)}\n")
            C.append("---\n")
        C.append("<sub>🤖 generated by codeaudit — full report: `report.md`; refuted and accepted items are excluded here and listed there.</sub>")
        pr_written = f"{OUT}/pr-comment.md"
        open(pr_written, "w").write("\n".join(C))

print(f"report.md {len(L)} lines | findings {len(findings)} | exec-summary | remediation groups {len(N['remediation_groups'])} (unassigned {len(left)}) | csv | sarif results {len(results)} rules {len(rules)}" + (f" | pr-comment {pr_written}" if pr_written else (" | pr-comment: nothing new, not written" if "--pr-comment" in sys.argv else "")))
