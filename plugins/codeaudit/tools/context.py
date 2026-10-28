#!/usr/bin/env python3
"""`.codeaudit-context.md` — the operator-owned, cross-engagement project context (reference/PROJECT_CONTEXT.md).

Usage:
  python3 -I "$CA/tools/context.py" check   <context.md>
  python3 -I "$CA/tools/context.py" propose <OUTPUT_ROOT> --context <context.md> [--json]
  python3 -I "$CA/tools/context.py" apply   <OUTPUT_ROOT> --context <context.md>

check    validates the heading contract, the line/character budget and the absence of seed placeholders.
         Exit 0 clean, 1 problems (printed one per line).
propose  reads <OUTPUT_ROOT>/codeaudit-report.json and writes <OUTPUT_ROOT>/plan/_context-additions.md: the
         "Known non-findings" lines this run established that the file does not already carry — design
         properties, accepted risks, by_design rule-outs and version-gated rule-outs. Prints them. Exit 0.
apply    appends the lines of plan/_context-additions.md under "## Known non-findings" (creating the section
         at the end if absent), skipping lines already present. Idempotent. Exit 0.

Only `apply` writes to the context file, and only after the orchestrator obtained the operator's approval —
this tool never decides what the operator believes.
"""
import json, os, re, sys

HEADINGS = ["## What this codebase does", "## Auth shape", "## Trust boundaries and adversaries",
            "## Project-specific patterns to flag", "## Known non-findings"]
MIN_LINES, MAX_LINES, MAX_CHARS = 12, 120, 10_000
PLACEHOLDERS = ["{project name}", "{what}", "{why", "one paragraph:", "3–5 bullets", "3-5 bullets", "TODO"]

def arg(flag, default=None):
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else default

def norm(s):
    s = re.sub(r"\([^)]*\)", "", s)            # drop parentheticals (evidence, who/when) before comparing
    s = re.sub(r"^\[[a-z-]+\]\s*", "", s.strip())
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()[:80]

def check(path):
    problems = []
    if not os.path.exists(path): return [f"{path}: not found"]
    body = open(path, errors="replace").read()
    lines = body.splitlines()
    for h in HEADINGS:
        if not re.search(r"^" + re.escape(h) + r"\s*$", body, re.M): problems.append(f"missing heading: {h}")
    if len(lines) < MIN_LINES: problems.append(f"too short: {len(lines)} lines (< {MIN_LINES}) — a seed with empty sections is not context")
    if len(lines) > MAX_LINES: problems.append(f"too long: {len(lines)} lines (> {MAX_LINES}) — it is injected into every brief")
    if len(body) > MAX_CHARS: problems.append(f"too long: {len(body)} chars (> {MAX_CHARS})")
    low = body.lower()
    for p in PLACEHOLDERS:
        if p.lower() in low: problems.append(f"placeholder still present: {p!r}")
    if re.search(r"(?i)(api[_-]?key|secret|password|token)\s*[:=]\s*['\"]?[A-Za-z0-9/+_-]{16,}", body):
        problems.append("looks like a credential value — the file is committed; name the variable, never its value")
    sec = section(body, "## Known non-findings")
    for l in sec.splitlines():
        if l.lstrip().startswith("- ") and not re.match(r"-\s*\[(by_design|accepted-risk|version-gated)\]", l.lstrip()):
            problems.append(f"Known non-findings line without a [by_design|accepted-risk|version-gated] tag: {l.strip()[:60]!r}")
    return problems

def section(body, heading):
    m = re.search(r"^" + re.escape(heading) + r"\s*\n(.*?)(?=^## |\Z)", body, re.S | re.M)
    return m.group(1) if m else ""

def existing_keys(path):
    if not os.path.exists(path): return set()
    body = open(path, errors="replace").read()
    return {norm(l.lstrip()[2:]) for l in section(body, "## Known non-findings").splitlines() if l.lstrip().startswith("- ")}

MAX_LINE = 260          # the file is injected into every agent brief; a paragraph per line defeats its purpose
HARD_CAP = 120           # never propose more than the file's whole line budget, whatever the engagement found

def clip(s, n=MAX_LINE):
    s = " ".join(str(s or "").split())
    if len(s) <= n: return s
    cut = s[:n].rsplit(" ", 1)[0]
    return cut.rstrip(" ,;:—-") + " …"

def propose(out, ctx):
    """Rank, clip and cap. A large engagement produces far more durable statements than a 40–120-line
    standing file can hold: the deepsec run offered 134 of them, several a full paragraph long. The file's
    value is "what would the next auditor get wrong without this", not a transcript of everything settled —
    so accepted risks come first (they are decisions, and nothing else records them), then version-gated
    rule-outs (they expire on upgrade), then by_design statements, shortest first because a one-line
    citation is the kind that survives being read in a brief."""
    rp = f"{out}/codeaudit-report.json"
    if not os.path.exists(rp): print(f"no report at {rp}", file=sys.stderr); return []
    R = json.load(open(rp)); have = existing_keys(ctx); seen = set()
    buckets = {"accepted-risk": [], "version-gated": [], "by_design": []}
    def add(kind, line):
        k = norm(line[2:])
        if k and k not in have and k not in seen: seen.add(k); buckets[kind].append(line)
    for f in R.get("findings", []):
        if f.get("status") == "accepted-risk":
            a = f.get("accepted") or {}; loc = f.get("location") or {}
            who = ", ".join(x for x in (a.get("by"), a.get("date")) if x)
            add("accepted-risk", f"- [accepted-risk] {clip(f.get('title'))} at {loc.get('file')} — {clip(a.get('reason') or 'no reason recorded', 120)} ({who or 'see .codeaudit-accepted.json'}; fingerprint {f.get('fingerprint')})")
    for t in R.get("tested_not_vulnerable", []):
        det = (t.get("detail") or "").strip(); cls = t.get("vuln_class", "?")
        if re.search(r"\b\d+\.\d+(\.\d+)?\b.*\b(cutoff|pinned|lockfile|package-lock|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum|pnpm-lock)\b", det, re.I) \
           or re.search(r"\b(cutoff|pinned|lockfile)\b.*\b\d+\.\d+(\.\d+)?\b", det, re.I):
            add("version-gated", f"- [version-gated] {clip(det)} ({cls}, {R.get('date', '?')}); re-verify on upgrade")
        elif t.get("disposition") == "by_design":
            add("by_design", f"- [by_design] {clip(det)} ({cls}, {R.get('date', '?')})")
    for d in R.get("design_properties", []):
        add("by_design", f"- [by_design] {clip(d.get('detail'))} ({d.get('vuln_class', '?')}, {R.get('date', '?')})")
    buckets["by_design"].sort(key=len)
    ranked = buckets["accepted-risk"] + buckets["version-gated"] + buckets["by_design"]
    headroom = HARD_CAP
    if os.path.exists(ctx):
        headroom = max(8, HARD_CAP - len(open(ctx, errors="replace").read().splitlines()))
    lines, dropped = ranked[:headroom], ranked[headroom:]
    os.makedirs(f"{out}/plan", exist_ok=True)
    with open(f"{out}/plan/_context-additions.md", "w") as fh:
        fh.write("# Proposed additions to .codeaudit-context.md — Known non-findings\n")
        fh.write("# Review each line; delete what the operator does not endorse, then run `context.py apply`.\n")
        fh.write(f"# {len(lines)} proposed of {len(ranked)} candidates (headroom {headroom} lines against the {HARD_CAP}-line budget),\n")
        fh.write(f"# ranked accepted-risk -> version-gated -> by_design (shortest first), each clipped to {MAX_LINE} chars.\n")
        if dropped:
            fh.write(f"# {len(dropped)} candidate(s) did not fit and are NOT lost: they are the report's own\n")
            fh.write("# design_properties and tested_not_vulnerable arrays. Raise the budget deliberately, or leave them there.\n")
        for l in lines: fh.write(l + "\n")
    globals()["_dropped"] = dropped
    return lines

def apply(out, ctx):
    ap = f"{out}/plan/_context-additions.md"
    if not os.path.exists(ap): print(f"nothing to apply ({ap} missing — run propose first)", file=sys.stderr); return 0
    adds = [l.rstrip("\n") for l in open(ap, errors="replace") if l.startswith("- ")]
    have = existing_keys(ctx)
    new = [l for l in adds if norm(l[2:]) not in have]
    if not new: return 0
    body = open(ctx, errors="replace").read() if os.path.exists(ctx) else ""
    if not re.search(r"^## Known non-findings\s*$", body, re.M):
        body = body.rstrip("\n") + "\n\n## Known non-findings\n"
    # append at the end of the Known non-findings section (which may be followed by other sections)
    m = re.search(r"^## Known non-findings\s*\n(.*?)(?=^## |\Z)", body, re.S | re.M)
    sec_end = m.end(1)
    sec_body = body[m.start(1):sec_end].rstrip("\n")
    sec_body = re.sub(r"^\s*-\s*none\s*$", "", sec_body, flags=re.M | re.I).rstrip("\n")
    body = body[:m.start(1)] + sec_body + ("\n" if sec_body else "") + "\n".join(new) + "\n\n" + body[sec_end:].lstrip("\n")
    open(ctx, "w").write(body.rstrip("\n") + "\n")
    return len(new)

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "check":
        probs = check(sys.argv[2]); print("\n".join(probs) if probs else f"ok: {sys.argv[2]}"); sys.exit(1 if probs else 0)
    out = sys.argv[2].rstrip("/") if len(sys.argv) > 2 else ""; ctx = arg("--context")
    if cmd == "propose":
        if not ctx: print("--context <file> required", file=sys.stderr); sys.exit(2)
        lines = propose(out, ctx)
        if "--json" in sys.argv: print(json.dumps({"additions": lines}))
        else:
            d = len(globals().get("_dropped") or [])
            print(f"{len(lines)} proposed addition(s) → {out}/plan/_context-additions.md" + (f" ({d} candidate(s) over budget, left in the report arrays)" if d else ""))
            [print("  " + l) for l in lines]
    elif cmd == "apply":
        if not ctx: print("--context <file> required", file=sys.stderr); sys.exit(2)
        print(f"appended {apply(out, ctx)} line(s) to {ctx}")
    else:
        print(__doc__); sys.exit(2)
