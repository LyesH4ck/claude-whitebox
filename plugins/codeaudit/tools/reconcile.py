#!/usr/bin/env python3
"""Step 6.5 mechanical reconciliation — enumerated request sources vs verdicted sources.

Usage:  python3 -I "$CA/tools/reconcile.py" <OUTPUT_ROOT> [--json]

An auditor's self-reported `complete` is a claim. This script turns it into a proof or a list of what is
missing: it reads every request source recon enumerated (`recon/sink-inventory.json` → `entry_points[]
.sources[].at`, each a bare `file:line`; or, when the orchestrator wrote one, `recon/_sources-enumerated.tsv`),
every `findings/finding-*/*.md` and every `findings/_safe-*.md`, and classifies each enumerated source as

  line-cited  : its exact file:line appears in some verdict artifact
  file-cited  : its file appears (auditors usually cite the sink line, not the source read site)
  uncited     : neither — a candidate `coverage_gaps` entry or a follow-up dispatch

Path aliases an auditor declared at the top of an evidence file ("`H/` = `routes/route-handlers/`") are
expanded before matching, so a condensed evidence file still reconciles against the enumerated paths.

Writes recon/_reconciliation.json and prints a per-service summary. Exit 0 always — the orchestrator decides
what an uncited residue means (a focused follow-up on those files, or a recorded gap); it must not exit
while uncited in-scope sources remain unexplained.
"""
import collections, glob, json, os, re, sys

if len(sys.argv) < 2 or sys.argv[1].startswith("-"):
    print(__doc__); sys.exit(2)          # usage, not a traceback: these are run by hand too
OUT = sys.argv[1].rstrip("/")
AS_JSON = "--json" in sys.argv
EXT = r"(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rb|php|java|kt|kts|go|cs|rs|swift|dart|ex|exs|scala|lua|sql|vue|svelte|erb|twig|html|json|jsonc|toml|yaml|yml|tf|hcl|sh|bash|cfg|conf|ini|env|xml|gradle|properties)"
# The list must stay a superset of aggregate.py's FL pattern: on a real engagement whose `iac` ecosystem
# was five GitHub workflows, `.yml` was absent here but present there, so every workflow an auditor had
# verdicted still read as uncited residue — the reconciler reported a coverage gap that did not exist.

# ---------------------------------------------------------------- enumerated sources
rows = []
tsv = f"{OUT}/recon/_sources-enumerated.tsv"
inv = f"{OUT}/recon/sink-inventory.json"
if os.path.exists(tsv):
    for l in open(tsv, errors="replace"):
        if l.startswith("#") or not l.strip(): continue
        p = l.rstrip("\n").split("\t") + [""] * 5
        rows.append({"at": p[0], "in": p[1], "name": p[2], "service": p[3], "route": p[4]})
elif os.path.exists(inv):
    data = json.load(open(inv))
    for ep in data.get("entry_points", []):
        svc = ep.get("component") or ep.get("service") or ep.get("handler_file", "").split("/")[0] or "-"
        route = f"{ep.get('method', '')} {ep.get('path', '')}".strip() or ep.get("handler", "")
        for s in ep.get("sources", []) or []:
            at = s.get("at")
            if not at or ":" not in at: continue
            rows.append({"at": at, "in": s.get("in", ""), "name": s.get("name", ""), "service": svc, "route": route})
    # A library / CLI / queue-only module exposes no HTTP routes (entry_points: []) but recon still records
    # its entry surface — exported functions, commands, consumers — under exported_surface[] with the same
    # sources[] shape. Reconcile those too, or a route-less repo reconciles to "nothing to check" (live run).
    for ex in data.get("exported_surface", []) or []:
        route = f"export {ex.get('name', '?')}" + (f" ({ex.get('handler')})" if ex.get("handler") else "")
        for s in ex.get("sources", []) or []:
            at = s.get("at")
            if not at or ":" not in at: continue
            rows.append({"at": at, "in": s.get("in", ""), "name": s.get("name", ""), "service": ex.get("component") or "exported", "route": route})
else:
    print(f"no enumerated sources found ({tsv} or {inv}); nothing to reconcile", file=sys.stderr)
    sys.exit(0)

# ---------------------------------------------------------------- verdict artifacts
texts = []
for p in sorted(glob.glob(f"{OUT}/findings/finding-*/*.md") + glob.glob(f"{OUT}/findings/_safe-*.md")):
    try: texts.append((p.split("/findings/")[1], open(p, errors="replace").read()))
    except OSError: pass
blob = "\n".join(t for _, t in texts)

# Expand declared aliases (looked up only in the first 3000 chars of each artifact — a declaration, not a mention).
aliases = {}
for _, t in texts:
    for m in re.finditer(r"`?([A-Z]{1,3}/)`?\s*(?:=|→|->|:)\s*`?([A-Za-z0-9_./-]+/)`?", t[:3000]):
        aliases.setdefault(m.group(1), m.group(2))
for a, full in aliases.items():
    blob = re.sub(r"(?<![A-Za-z0-9_./-])" + re.escape(a), full, blob)

cited_lines = set(m.group(0) for m in re.finditer(r"[A-Za-z0-9_./-]+\." + EXT + r":\d+", blob))
cited_files = set(c.rsplit(":", 1)[0].lstrip("./") for c in cited_lines)

def status(at):
    f = at.rsplit(":", 1)[0].lstrip("./")
    if at in cited_lines or any(c.endswith(at) for c in cited_lines):
        return "line-cited"
    if any(f == c or f.endswith("/" + c) or c.endswith("/" + f) for c in cited_files):
        return "file-cited"
    return "uncited"

result = []
by_svc = collections.defaultdict(collections.Counter)
for r in rows:
    s = status(r["at"]); by_svc[r["service"]][s] += 1
    result.append({**r, "status": s})

uncited_files = collections.Counter(r["at"].rsplit(":", 1)[0] for r in result if r["status"] == "uncited")
summary = {
    "sources": len(result),
    "artifacts_read": len(texts),
    "citations_distinct": len(cited_lines),
    "aliases_expanded": aliases,
    "by_status": dict(collections.Counter(r["status"] for r in result)),
    "by_service": {k: dict(v) for k, v in by_svc.items()},
    "uncited_files": [{"file": f, "sources": n} for f, n in uncited_files.most_common()],
}
os.makedirs(f"{OUT}/recon", exist_ok=True)
json.dump({"summary": summary, "sources": result}, open(f"{OUT}/recon/_reconciliation.json", "w"), indent=1)

if AS_JSON:
    print(json.dumps(summary)); sys.exit(0)
print(f"sources {summary['sources']} | artifacts {summary['artifacts_read']} | citations {summary['citations_distinct']}"
      + (f" | aliases {aliases}" if aliases else ""))
print("status  :", summary["by_status"])
for svc, c in sorted(summary["by_service"].items()):
    tot = sum(c.values())
    print(f"  {svc:18} line {c.get('line-cited',0):4}  file {c.get('file-cited',0):4}  uncited {c.get('uncited',0):4}  / {tot}")
print(f"uncited files: {len(uncited_files)}")
for f, n in uncited_files.most_common(40):
    print(f"  - {f}  ({n})")
