#!/usr/bin/env python3
"""Diff-mode scope — the files a change touched, plus one import hop in both directions.

Usage:
  python3 -I "$CA/tools/diff-scope.py" --repo <repo> [--ref origin/main] [--working] [--staged] [--files a,b]
                                       [--hops 1] [--out-of-scope a,b] [--write <path>] [--json]

Resolves the changed set from git (`--ref <base>`: merge-base diff against HEAD; `--working`: uncommitted +
untracked; `--staged`: index vs HEAD; `--files`: an explicit list), drops vendored/generated/test files and
the operator's out_of_scope, then expands by `--hops` levels of a best-effort import graph:
  - importers of a changed file (a route that calls a changed helper is where the bug becomes reachable);
  - imports of a changed file (the sink a changed handler now reaches).
Resolution is regex-only and relative-path-based (JS/TS `import`/`require`, Python `from .x` / `from pkg.x`,
Ruby `require_relative`, PHP `require`/`include`, Go: the other files of the same package directory). It
over-approximates on purpose: a hop that pulls in one extra file costs an auditor a read; a missed hop hides
the route that makes a changed sink reachable.

Writes <--write> (default <repo>/outputs/_diff-scope.json when --write is given without a value) and prints
the scope. Exit 0; exit 1 when the changed set is empty (nothing to audit).
"""
import collections, json, os, re, subprocess, sys

def arg(flag, default=None):
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv and sys.argv.index(flag) + 1 < len(sys.argv) and not sys.argv[sys.argv.index(flag) + 1].startswith("--") else default
REPO = arg("--repo"); REF = arg("--ref"); HOPS = int(arg("--hops", "1")); AS_JSON = "--json" in sys.argv
OOS = [x.strip().strip("/") for x in (arg("--out-of-scope") or "").split(",") if x.strip() and x.strip().lower() != "none"]
IGNORE = re.compile(r"(^|/)(node_modules|vendor|dist|build|target|out|\.next|coverage|__pycache__|\.git|outputs|__mocks__|generated|\.terraform)(/|$)|\.(test|spec|stories|d)\.[cm]?[jt]sx?$|_test\.go$|_spec\.rb$|/test_[^/]*\.py$|\.min\.js$|\.(lock|png|jpg|svg|ico|woff2?|map)$")
SRC_EXT = (".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".php", ".go", ".java", ".kt", ".cs", ".rs", ".ex", ".exs", ".vue", ".svelte")
JS_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte"]

def git(*a):
    r = subprocess.run(["git", "-C", REPO, *a], capture_output=True, text=True, timeout=120)
    return r.stdout if r.returncode == 0 else ""

def norm(p): return p.replace("\\", "/").lstrip("./")

def in_scope(f):
    return bool(f) and not IGNORE.search(f) and not any(f == o or f.startswith(o + "/") for o in OOS)

def changed_set():
    files = set()
    if arg("--files"): files |= {norm(x.strip()) for x in arg("--files").split(",") if x.strip()}
    if REF:
        base = git("merge-base", REF, "HEAD").strip() or REF
        files |= {norm(x) for x in git("diff", "--name-only", "--diff-filter=ACMR", f"{base}...HEAD").splitlines()}
        if not files: files |= {norm(x) for x in git("diff", "--name-only", "--diff-filter=ACMR", base, "HEAD").splitlines()}
    if "--working" in sys.argv:
        files |= {norm(x) for x in git("diff", "--name-only", "--diff-filter=ACMR").splitlines()}
        files |= {norm(x) for x in git("ls-files", "--others", "--exclude-standard").splitlines()}
    if "--staged" in sys.argv:
        files |= {norm(x) for x in git("diff", "--name-only", "--cached", "--diff-filter=ACMR").splitlines()}
    return {f for f in files if os.path.exists(os.path.join(REPO, f))}

def tracked():
    out = git("ls-files", "-z")
    return [f for f in out.split("\0") if f] if out else []

IMPORT_RX = {
    "js": re.compile(r"""(?:import\s+(?:[^'"]*?\s+from\s+)?|require\s*\(\s*|import\s*\(\s*|export\s+[^'"]*?\s+from\s+)['"](\.{1,2}/[^'"]+|@/[^'"]+|~/[^'"]+)['"]"""),
    "py": re.compile(r"^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))", re.M),
    "rb": re.compile(r"""require_relative\s+['"]([^'"]+)['"]"""),
    "php": re.compile(r"""(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?['"]([^'"]+)['"]"""),
}

def resolve_js(src, spec, exists):
    if spec.startswith(("@/", "~/")): spec = "src/" + spec[2:]; base = norm(spec)
    else: base = norm(os.path.normpath(os.path.join(os.path.dirname(src), spec)))
    cands = [base] + [base + e for e in JS_EXT] + [base + "/index" + e for e in JS_EXT]
    for c in cands:
        if c in exists: return c
    return None

def resolve_py(src, mod, exists):
    if mod.startswith("."):
        dots = len(mod) - len(mod.lstrip(".")); rest = mod.lstrip(".")
        d = os.path.dirname(src)
        for _ in range(dots - 1): d = os.path.dirname(d)
        base = norm(os.path.join(d, rest.replace(".", "/"))) if rest else norm(d)
    else:
        base = mod.replace(".", "/")
    for c in (base + ".py", base + "/__init__.py"):
        if c in exists: return c
    # a module nested under a top-level src/ or package dir
    for pre in ("src/", "app/", "lib/"):
        for c in (pre + base + ".py", pre + base + "/__init__.py"):
            if c in exists: return c
    return None

def imports_of(f, exists):
    try: body = open(os.path.join(REPO, f), errors="replace").read(400_000)
    except OSError: return set()
    out = set()
    if f.endswith(tuple(JS_EXT)):
        for m in IMPORT_RX["js"].finditer(body):
            r = resolve_js(f, m.group(1), exists)
            if r: out.add(r)
    elif f.endswith(".py"):
        for m in IMPORT_RX["py"].finditer(body):
            r = resolve_py(f, m.group(1) or m.group(2), exists)
            if r: out.add(r)
    elif f.endswith(".rb"):
        for m in IMPORT_RX["rb"].finditer(body):
            base = norm(os.path.normpath(os.path.join(os.path.dirname(f), m.group(1))))
            if base + ".rb" in exists: out.add(base + ".rb")
    elif f.endswith(".php"):
        for m in IMPORT_RX["php"].finditer(body):
            base = norm(os.path.normpath(os.path.join(os.path.dirname(f), m.group(1).lstrip("/"))))
            if base in exists: out.add(base)
    elif f.endswith(".go"):
        d = os.path.dirname(f)
        out |= {g for g in exists if os.path.dirname(g) == d and g.endswith(".go") and g != f}
    return out

def main():
    if not REPO or not os.path.isdir(REPO): print("--repo <path> required", file=sys.stderr); return 2
    changed_all = changed_set()
    changed = sorted(f for f in changed_all if in_scope(f) and f.endswith(SRC_EXT))
    dropped = sorted(changed_all - set(changed))
    if not changed:
        res = {"changed": [], "dropped": dropped, "scope_files": [], "note": "no in-scope source file changed"}
        print(json.dumps(res, indent=1) if AS_JSON else "no in-scope source file changed — nothing to audit"); return 1
    exists = set(norm(f) for f in tracked()) | set(changed)
    src = [f for f in exists if f.endswith(SRC_EXT) and in_scope(f)]
    graph = {f: imports_of(f, exists) for f in src}
    rev = collections.defaultdict(set)
    for f, deps in graph.items():
        for d in deps: rev[d].add(f)
    frontier, seen, importers, imports = set(changed), set(changed), set(), set()
    for _ in range(HOPS):
        nxt = set()
        for f in frontier:
            for i in rev.get(f, ()):
                if i not in seen and in_scope(i): importers.add(i); nxt.add(i)
            for d in graph.get(f, ()):
                if d not in seen and in_scope(d): imports.add(d); nxt.add(d)
        seen |= nxt; frontier = nxt
    scope = sorted(seen)
    dirs = sorted({os.path.dirname(f) or "." for f in scope})
    res = {"repo": REPO, "ref": REF, "hops": HOPS, "changed": changed, "dropped_out_of_scope_or_non_source": dropped,
           "related_importers": sorted(importers), "related_imports": sorted(imports), "scope_files": scope, "scope_dirs": dirs,
           "note": "importers are where a changed helper becomes reachable; imports are what a changed handler now reaches"}
    if "--write" in sys.argv:
        wp = arg("--write") or os.path.join(REPO, "outputs", "_diff-scope.json")
        os.makedirs(os.path.dirname(wp), exist_ok=True); json.dump(res, open(wp, "w"), indent=1); res["written"] = wp
    if AS_JSON: print(json.dumps(res, indent=1)); return 0
    print(f"diff scope — {len(changed)} changed source file(s), +{len(importers)} importer(s), +{len(imports)} import(s) → {len(scope)} files in {len(dirs)} dir(s)")
    for f in changed: print(f"  changed   {f}")
    for f in sorted(importers): print(f"  importer  {f}")
    for f in sorted(imports): print(f"  import    {f}")
    if dropped: print(f"  dropped (non-source / out of scope): {', '.join(dropped[:8])}{' …' if len(dropped) > 8 else ''}")
    if res.get("written"): print(f"  wrote {res['written']}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
