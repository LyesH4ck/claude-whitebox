#!/usr/bin/env python3
"""Step 6.0b resume probe — what an interrupted engagement already has on disk, and where to pick it up.

Usage:  python3 -I "$CA/tools/resume.py" <OUTPUT_ROOT> [--json]

Reads only artifacts the pipeline writes (recon, threat model, plan, per-auditor evidence files and finding
directories, the orchestrator's NDJSON log, verification files, the sweep log, the report) and classifies
each phase as done / partial / missing. Prints the first phase to resume from and the auditors still owed.
Never writes. Exit 0 always — the orchestrator reads the probe and asks the operator; a probe is never a
decision.

What "done" means per phase (deliberately mechanical — an agent's own "complete" is never consulted):
  recon          the three baseline files exist and sink-inventory.json parses with entry_points + ecosystems
  coverage-gate  recon/_coverage.json exists and passed
  threat-model   recon/threat-model.json parses with entry_points[] and dispositions[]
  plan           plan/deployment-plan.json parses with non-empty waves[]
  auditors       per planned deployment: `done` requires BOTH the orchestrator's `auditor-done: complete`
                 log line AND a four-heading _safe-{class}[-{shard}].md; either alone is `partial`, with
                 `why_partial` and an `evidence_entries` count saying which case it is; nothing → missing
  reconcile      recon/_reconciliation.json exists
  sweep          the orchestrator log carries "sweeps-complete"
  verify         every finding dir with final severity ≥ high has verification.md (needs the report, else
                 counts dirs with/without verification.md)
  aggregate      codeaudit-report.json exists;  render: report.md exists
"""
import glob, json, os, re, sys

OUT = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else ""
AS_JSON = "--json" in sys.argv
HEADINGS = ["tested_not_vulnerable", "design_properties", "unverified_assumptions", "coverage_gaps"]
# class → on-disk finding-dir prefix (REPORT_CONTRACT.md `id` rule). Without it a non-sharded auditor's
# finding count matches every class's directories, which misreads the resume diagnostic.
CLASS_PREFIX = {"injection": "inj", "xss": "xss", "access-control": "ac", "ssrf": "ssrf", "auth": "auth",
                "secrets": "sec", "crypto": "crypto", "deps": "deps", "config": "cfg", "logging": "log",
                "business-logic": "biz", "feature-abuse": "feat", "data-lifecycle": "life",
                "client-side": "cli", "http-protocol": "http", "ai-llm": "ai", "ai-agent": "ai",
                "resource-exhaustion": "dos"}

def jload(p):
    try: return json.load(open(p))
    except Exception: return None

def safe_ok(p):
    try: b = open(p, errors="replace").read()
    except OSError: return False
    return all(re.search(r"^##\s+" + h + r"\s*$", b, re.M) for h in HEADINGS)

def safe_entries(p):
    """Bullet entries across the four sections, `- none` excluded. An auditor told to write its evidence
    file incrementally creates the four headings first, so headings alone prove nothing: a killed agent
    leaves exactly that skeleton, and counting it as done drops a whole class silently (seen on a live run
    stopped by an API rate limit)."""
    try: b = open(p, errors="replace").read()
    except OSError: return 0
    n = 0
    for h in HEADINGS:
        m = re.search(r"^##\s+" + h + r"\s*$\n(.*?)(?=^##\s|\Z)", b, re.S | re.M)
        if not m: continue
        for l in m.group(1).splitlines():
            s = l.strip()
            if s.startswith("- ") and s[2:].strip().lower() not in ("none", "n/a", ""): n += 1
    return n

def log_actions(path):
    acts = []
    if not os.path.exists(path): return acts
    for l in open(path, errors="replace"):
        try: acts.append(json.loads(l))
        except Exception: pass
    return acts

def main():
    if not OUT or not os.path.isdir(OUT):
        print(json.dumps({"exists": False, "resume_from": "6.1"}) if AS_JSON else f"{OUT}: no engagement directory — nothing to resume (start at 6.1)")
        return 0
    phases = {}
    inv = jload(f"{OUT}/recon/sink-inventory.json")
    recon_files = all(os.path.exists(f"{OUT}/recon/{f}") for f in ("architecture.md", "attack-surface.md", "sink-inventory.json"))
    phases["recon"] = "done" if recon_files and isinstance(inv, dict) and "entry_points" in inv and inv.get("ecosystems") else ("partial" if recon_files or inv else "missing")
    cov = jload(f"{OUT}/recon/_coverage.json")
    phases["coverage-gate"] = "done" if cov and cov.get("passed") else ("partial" if cov else "missing")
    tm = jload(f"{OUT}/recon/threat-model.json")
    phases["threat-model"] = "done" if tm and tm.get("entry_points") and tm.get("dispositions") else ("partial" if tm else "missing")
    plan = jload(f"{OUT}/plan/deployment-plan.json")
    phases["plan"] = "done" if plan and plan.get("waves") else ("partial" if plan else "missing")

    orch = log_actions(f"{OUT}/activity/codeaudit-orchestrator.log")
    done_by_log = {(a.get("agent"), a.get("shard")): a.get("status") for a in orch if a.get("action") == "auditor-done"}

    auditors = []
    if plan and plan.get("waves"):
        for wi, wave in enumerate(plan["waves"], 1):
            for d in (wave.get("deployments") or wave.get("auditors") or wave if isinstance(wave, list) else wave.get("deployments") or wave.get("auditors") or []):
                if not isinstance(d, dict): continue
                agent = d.get("agent") or d.get("name") or "?"
                cls = d.get("class") or d.get("vuln_class") or agent.replace("-auditor", "").replace("ai-agent", "ai-llm")
                shard = d.get("shard")
                safe = f"{OUT}/findings/_safe-{cls}" + (f"-{shard}" if shard else "") + ".md"
                logged = done_by_log.get((agent, shard))
                entries = safe_entries(safe) if os.path.exists(safe) else 0
                pre = CLASS_PREFIX.get(cls, cls)
                # A shard tag often already carries the class prefix (the planner writes `inj-s1`, so the
                # auditor names its dirs `finding-inj-s1-NNN`, not `finding-inj-inj-s1-NNN`). Accept both.
                pats = [f"finding-{pre}-*"] if not shard else [f"finding-{pre}-{shard}-*", f"finding-{shard}-*"]
                findings = len({d for pat in pats for d in glob.glob(f"{OUT}/findings/{pat}")})
                # `done` needs BOTH halves: the orchestrator's own `auditor-done: complete` line AND a
                # four-heading evidence file. Either alone is `partial` — an unlogged file may be a
                # skeleton from a killed agent, and a log line without the file is a lost artifact.
                # Over-reporting `partial` costs a re-dispatch; under-reporting drops a class.
                if logged == "complete" and os.path.exists(safe) and safe_ok(safe): state = "done"
                elif os.path.exists(safe) or findings or logged: state = "partial"
                else: state = "missing"
                a = {"wave": wi, "agent": agent, "class": cls, "shard": shard,
                     "safe_file": os.path.relpath(safe, OUT), "state": state, "logged_status": logged,
                     "evidence_entries": entries, "finding_dirs": findings}
                if state == "partial":
                    a["why_partial"] = ("no `auditor-done: complete` log line — the evidence file carries "
                                        f"{entries} entr{'y' if entries == 1 else 'ies'}, so it may be finished: confirm from the agent's "
                                        "final status, or re-dispatch" if os.path.exists(safe) and safe_ok(safe) and entries
                                        else "evidence file is a skeleton (four headings, no entries) — a killed agent's incremental write"
                                        if os.path.exists(safe) and safe_ok(safe)
                                        else "evidence file missing or malformed")
                auditors.append(a)
    phases["auditors"] = ("done" if auditors and all(a["state"] == "done" for a in auditors) else "partial" if any(a["state"] != "missing" for a in auditors) else "missing") if plan else "missing"
    phases["reconcile"] = "done" if os.path.exists(f"{OUT}/recon/_reconciliation.json") else "missing"
    phases["sweep"] = "done" if any(a.get("action") == "sweeps-complete" for a in orch) else ("partial" if glob.glob(f"{OUT}/findings/_safe-sweep-*.md") else "missing")
    fdirs = sorted(d for d in glob.glob(f"{OUT}/findings/finding-*") if os.path.isdir(d))
    verified = [d for d in fdirs if os.path.exists(f"{d}/verification.md")]
    report = jload(f"{OUT}/codeaudit-report.json")
    if report:
        owed = [f["id"] for f in report.get("findings", []) if f.get("severity") in ("high", "critical") and not f.get("revalidation")]
        phases["verify"] = "done" if not owed else "partial"
    else:
        owed = [os.path.basename(d) for d in fdirs if d not in verified]
        phases["verify"] = "done" if fdirs and not owed else ("partial" if verified else "missing")
    phases["aggregate"] = "done" if report else "missing"
    phases["render"] = "done" if os.path.exists(f"{OUT}/report.md") else "missing"

    order = [("recon", "6.2"), ("coverage-gate", "6.2"), ("threat-model", "6.2b"), ("plan", "6.3"), ("auditors", "6.4/6.5"),
             ("reconcile", "6.5"), ("sweep", "6.5b"), ("verify", "6.5c"), ("aggregate", "6.6"), ("render", "6.6")]
    resume_from = next((step for ph, step in order if phases[ph] != "done"), "done")
    probe = {"exists": True, "phases": phases, "resume_from": resume_from, "auditors": auditors,
             "auditors_owed": [a for a in auditors if a["state"] != "done"],
             "finding_dirs": len(fdirs), "verified_dirs": len(verified), "verification_owed": owed,
             "last_log_line": (orch[-1] if orch else None)}
    if AS_JSON: print(json.dumps(probe, indent=1)); return 0
    print(f"resume probe — {OUT}")
    for ph, step in order: print(f"  {ph:14} {phases[ph]:8} (step {step})")
    if auditors:
        print("  auditors:")
        for a in auditors:
            print(f"    wave {a['wave']} {a['agent']:28} {a['class']:18} {a['shard'] or '-':8} {a['state']:8} log={a['logged_status'] or '-':9} evidence={a['evidence_entries']:>3} findings={a['finding_dirs']}")
            if a.get("why_partial"): print(f"        {a['why_partial']}")
    if owed: print(f"  verification owed: {', '.join(owed[:12])}{' …' if len(owed) > 12 else ''}")
    print(f"  → resume from step {resume_from}" if resume_from != "done" else "  → every phase has its artifact; re-run Step 6.6/6.7 only if you need to re-aggregate")
    return 0

if __name__ == "__main__":
    sys.exit(main())
