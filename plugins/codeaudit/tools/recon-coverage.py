#!/usr/bin/env python3
"""Step 6.2 recon-coverage gate — did code-recon's entry inventory reach every file that looks like an entry point?

Usage:  python3 -I "$CA/tools/recon-coverage.py" <OUTPUT_ROOT> --repo <repo> [--out-of-scope a,b] [--json]

`reconcile.py` (Step 6.5) proves that every source recon enumerated got a verdict. It says nothing about the
files recon never enumerated — and recon, the threat model and the planner can all miss the same family of
routes at once, after which no auditor is ever sent there and the report still prints "all in-scope sources
traced". This tool is the deterministic check on that, before anything downstream consumes the baseline:

  1. list the repository's tracked source files (`git ls-files`, minus vendored/generated/test trees and the
     operator's out_of_scope);
  2. mark every file carrying a *route-shaped* marker for its language — a framework route registration,
     an HTTP-method export, a controller/handler declaration, a server action, a queue consumer, a cron or
     webhook handler (per-ecosystem regexes below, deliberately broad: this is a denominator, not a verdict);
  3. compare that set with the handler files recon recorded in `recon/sink-inventory.json`
     (`entry_points[].handler` and `exported_surface[].handler`, plus `sources[].at` files);
  4. apply a versioned policy and print the residue grouped by directory.

Policy v1 (mirrors the shape of a scanner's coverage gate, calibrated for an LLM recon):
  - a directory (depth ≤ 2) with ≥ 3 route-shaped files and ZERO covered → FAIL ("a whole family missed");
  - overall covered/route-shaped < 0.5 when ≥ 5 route-shaped files exist → FAIL;
  - a language with ≥ 20 source files and 0 route-shaped files while another language has routes → WARN
    (the marker table may not know this stack's framework — recon must say what the files are);
  - otherwise PASS. Uncovered files are always listed, pass or fail: each one is either a recon miss or a
    false marker hit, and the orchestrator reads the list, re-dispatches recon on the residue when it is
    real, and records a false hit nowhere (it is noise, not evidence).

Writes recon/_coverage.json. Exit 0 pass (with or without warnings), 1 gate failed. Never 2: a missing
inventory is itself a failed gate, not a tool error — recon produced nothing to measure.
"""
import collections, json, os, re, subprocess, sys

OUT = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else ""
def arg(flag, default=None):
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else default
REPO = arg("--repo")
AS_JSON = "--json" in sys.argv
OOS = [x.strip().strip("/") for x in (arg("--out-of-scope") or "").split(",") if x.strip() and x.strip().lower() != "none"]

POLICY = {"version": 1, "family_min_files": 3, "overall_min_ratio": 0.5, "overall_min_route_files": 5,
          "silent_language_min_files": 20}

IGNORE = re.compile(r"(^|/)(node_modules|vendor|dist|build|target|out|\.next|\.nuxt|coverage|__pycache__|\.git|outputs|fixtures?|__tests__|tests?|spec|specs|e2e|cypress|__mocks__|migrations?|generated|gen|proto|\.terraform)(/|$)|\.(test|spec|stories|d)\.[cm]?[jt]sx?$|_test\.go$|_spec\.rb$|Tests?\.(cs|java|kt|swift)$|^test_.*\.py$|/test_[^/]*\.py$|\.min\.js$|\.(lock|md|txt|json|ya?ml|toml|svg|png|jpg|css|scss|html)$")

LANG = {"typescript": (".ts", ".tsx", ".mts", ".cts"), "javascript": (".js", ".jsx", ".mjs", ".cjs"), "python": (".py",),
        "php": (".php",), "ruby": (".rb",), "go": (".go",), "java": (".java",), "kotlin": (".kt", ".kts"),
        "csharp": (".cs",), "rust": (".rs",), "elixir": (".ex", ".exs"), "scala": (".scala",), "swift": (".swift",), "dart": (".dart",)}

# Route-shaped markers. Broad on purpose — a false hit costs one line in a residue list; a miss costs a
# family of routes nobody audits. Keyed by language group.
JS = re.compile(r"""\b(app|router|server|fastify|api|hono|r)\.(get|post|put|patch|delete|all|use|route)\s*\(\s*['"`/]|export\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\s*=|['"]use server['"]|@(Get|Post|Put|Patch|Delete|All|Controller|Query|Mutation|Resolver|MessagePattern|EventPattern|Cron|Process)\s*\(|(public|protected)Procedure\s*\.|defineEventHandler\s*\(|export\s+(async\s+)?function\s+(loader|action)\b|export\s+const\s+(loader|action|actions)\b|\bio\.on\s*\(\s*['"]connection|socket\.on\s*\(|new\s+Worker\s*\(|\.process\s*\(\s*['"]|Bun\.serve\s*\(|Deno\.serve\s*\(|export\s+default\s*\{\s*(async\s+)?fetch\s*\(|exports\.handler\s*=|export\s+const\s+handler\s*=|functions\.https\.onRequest|onCall\s*\(|app\.(whenReady|listen)\s*\(|webhooks?\.on\s*\(|createRouter\s*\(|\.mount\s*\(\s*['"]""")
PY = re.compile(r"""@(app|router|bp|blueprint|api|ns|namespace|[a-z_]+_bp|[a-z_]+_router)\.(route|get|post|put|patch|delete|websocket|api_route)\s*\(|\b(path|re_path|url)\s*\(\s*r?['"]|class\s+\w+\s*\(.*\b(APIView|ViewSet|GenericViewSet|View|Resource|RequestHandler|Consumer|WebsocketConsumer)\b|def\s+(get|post|put|patch|delete)\s*\(\s*self\s*,\s*request|@csrf_exempt|@api_view|@(shared_task|task|celery\.task|app\.task)\b|@(receiver|hook)\s*\(|def\s+lambda_handler\s*\(|def\s+handler\s*\(\s*event|@functions_framework\.|@app\.(on_event|middleware)\(|@(router|app)\.websocket\(|def\s+(on_message|on_event|handle)\s*\(""")
PHP = re.compile(r"""#\[Route\s*\(|@Route\s*\(|Route::(get|post|put|patch|delete|any|match|resource|apiResource|group)\s*\(|\$(app|router|group)->(get|post|put|patch|delete|any|map|group)\s*\(|extends\s+(Controller|AbstractController|BaseController|ApiController)\b|add_action\s*\(\s*['"](wp_ajax_|rest_api_init|admin_post_)|register_rest_route\s*\(|public\s+function\s+action[A-Z]\w*\s*\(|function\s+\w+Action\s*\(""")
RB = re.compile(r"""^\s*(get|post|put|patch|delete|match|resources?|namespace|scope|mount|root)\s+['":/]|class\s+\w+Controller\s*<|class\s+\w+\s*<\s*(Sinatra::Base|Grape::API|Roda|Hanami::Action|ApplicationJob|ActiveJob::Base|Sidekiq::Worker)|include\s+Sidekiq::(Worker|Job)|def\s+perform\s*\(|^\s*(desc|params)\s+['"]""")
GO = re.compile(r"""\.(Handle|HandleFunc|Handler|GET|POST|PUT|PATCH|DELETE|Any|Get|Post|Put|Patch|Delete|Route|Group|Mount)\s*\(\s*["`]|http\.HandleFunc\s*\(|func\s+\w+\s*\(\s*\w+\s+(http\.ResponseWriter|\*gin\.Context|echo\.Context|\*fiber\.Ctx|fiber\.Ctx)|lambda\.Start\s*\(|grpc\.NewServer\s*\(|Register\w+Server\s*\(|func\s+\(\w+\s+\*?\w+\)\s+\w+\s*\(\s*ctx\s+context\.Context,\s*(req|in)\s+\*""")
JVM = re.compile(r"""@(Get|Post|Put|Patch|Delete|Request)Mapping\b|@(Path|GET|POST|PUT|DELETE|PATCH)\s*\(|@(RestController|Controller|RestResource|WebServlet|ServerEndpoint|MessageMapping|KafkaListener|RabbitListener|SqsListener|JmsListener|Scheduled|EventListener)\b|routing\s*\{|\b(get|post|put|patch|delete)\s*\(\s*"/|extends\s+HttpServlet\b|implements\s+RequestHandler\b|@Controller\s*\(|@Secured\b|fun\s+\w+\s*\(.*(call|ctx)\s*:\s*(ApplicationCall|RoutingContext)""")
CS = re.compile(r"""\[(HttpGet|HttpPost|HttpPut|HttpPatch|HttpDelete|Route|ApiController|FunctionName|Function|ServiceBusTrigger|QueueTrigger|TimerTrigger|HttpTrigger)\b|\.Map(Get|Post|Put|Patch|Delete|Group|Hub|Controllers|RazorPages)\s*\(|:\s*(ControllerBase|Controller|PageModel|Hub|ApiController)\b|public\s+(async\s+)?Task<[^>]*>\s+On(Get|Post)""")
RS = re.compile(r"""#\[(get|post|put|patch|delete|route|handler|tokio::main|actix_web::main|launch)\b|\.route\s*\(\s*"|web::(get|post|put|patch|delete|resource|scope)\s*\(|Router::new\s*\(|warp::path!?\s*\(|#\[tonic::async_trait\]|lambda_runtime::run|\.service\s*\(""")
EX = re.compile(r"""^\s*(get|post|put|patch|delete|resources|live|forward|scope|pipeline|pipe_through)\s+["':/]|use\s+\w+Web,\s*:(controller|router|live_view|channel)|def\s+(handle_event|handle_in|mount|init|call)\s*\(|@impl\s+Plug\b""")
SW = re.compile(r"""\.(get|post|put|patch|delete|grouped|on|webSocket)\s*\(\s*"|routes\.(get|post|put|patch|delete)|func\s+boot\s*\(_\s+routes|RouteCollection""")
DART = re.compile(r"""\.(get|post|put|patch|delete|all|mount)\s*\(\s*'|Router\(\)|Pipeline\(\)\.addMiddleware|shelf_router""")
MARKERS = {"typescript": JS, "javascript": JS, "python": PY, "php": PHP, "ruby": RB, "go": GO, "java": JVM, "kotlin": JVM,
           "scala": JVM, "csharp": CS, "rust": RS, "elixir": EX, "swift": SW, "dart": DART}
FAMILY = re.compile(r"(webhook|cron|scheduler?|jobs?|workers?|consumers?|queue|tasks?|listeners?|handlers?|lambda|functions?|graphql|resolvers?|websocket|socket|rpc|grpc|actions?)", re.I)

FL = re.compile(r"([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|php|java|kt|go|cs|rs|swift|sql|vue|svelte|erb|twig|html|ex|exs|dart|scala))(?::\d+)?")

def lang_of(f):
    for l, exts in LANG.items():
        if f.endswith(exts): return l
    return None

def norm(p):
    p = p.replace("\\", "/")
    for pre in ("./",):
        if p.startswith(pre): p = p[len(pre):]
    return p.strip()

def rel_to_repo(p):
    p = norm(p)
    if REPO and p.startswith(norm(REPO).rstrip("/") + "/"): p = p[len(norm(REPO).rstrip("/")) + 1:]
    return p

def tracked_files():
    try:
        out = subprocess.run(["git", "-C", REPO, "ls-files", "-z"], capture_output=True, text=True, timeout=60)
        if out.returncode == 0 and out.stdout: return [f for f in out.stdout.split("\0") if f]
    except Exception: pass
    files = []
    for root, dirs, fs in os.walk(REPO):
        dirs[:] = [d for d in dirs if not IGNORE.search(d + "/")]
        for f in fs: files.append(os.path.relpath(os.path.join(root, f), REPO).replace("\\", "/"))
    return files

def in_scope(f):
    if IGNORE.search(f): return False
    return not any(f == o or f.startswith(o + "/") for o in OOS)

def dir_key(f, depth=2):
    parts = f.split("/")[:-1]
    return "/".join(parts[:depth]) if parts else "."

def main():
    if not REPO or not os.path.isdir(REPO):
        print("--repo <path> is required and must exist", file=sys.stderr); return 1
    inv_path = f"{OUT}/recon/sink-inventory.json"
    inv = {}
    if os.path.exists(inv_path):
        try: inv = json.load(open(inv_path))
        except Exception as e: print(f"sink-inventory.json unreadable: {e}", file=sys.stderr)
    covered = set()
    for ep in (inv.get("entry_points") or []) + (inv.get("exported_surface") or []):
        for s in [ep.get("handler") or "", ep.get("handler_file") or "", ep.get("file") or ""] + [x.get("at") or "" for x in ep.get("sources") or []]:
            m = FL.search(s)
            if m: covered.add(rel_to_repo(m.group(1)))

    src = [f for f in tracked_files() if in_scope(f) and lang_of(f)]
    by_lang = collections.Counter(lang_of(f) for f in src)
    route_files, hits = [], {}
    for f in src:
        rx = MARKERS.get(lang_of(f))
        if not rx: continue
        try:
            with open(os.path.join(REPO, f), errors="replace") as fh: body = fh.read(400_000)
        except OSError: continue
        m = rx.search(body)
        if m:
            route_files.append(f); hits[f] = body.count("\n", 0, m.start()) + 1
    route_set = set(route_files)
    covered_routes = route_set & covered
    uncovered = sorted(route_set - covered)
    covered_not_route = sorted(covered - route_set)   # recon found entry points the markers do not know — fine, informational

    families = collections.defaultdict(lambda: {"route_files": 0, "covered": 0, "uncovered": []})
    for f in route_files:
        d = families[dir_key(f)]; d["route_files"] += 1
        if f in covered: d["covered"] += 1
        else: d["uncovered"].append(f)
    failures, warnings = [], []
    for d, v in sorted(families.items()):
        if v["route_files"] >= POLICY["family_min_files"] and v["covered"] == 0:
            failures.append(f"{d}/ — {v['route_files']} route-shaped files, none in recon's entry inventory (a whole family missed)")
    ratio = len(covered_routes) / len(route_set) if route_set else 1.0
    if len(route_set) >= POLICY["overall_min_route_files"] and ratio < POLICY["overall_min_ratio"]:
        failures.append(f"overall: {len(covered_routes)}/{len(route_set)} route-shaped files covered ({ratio:.0%}) < {POLICY['overall_min_ratio']:.0%}")
    route_langs = {lang_of(f) for f in route_files}
    for l, n in by_lang.items():
        if n >= POLICY["silent_language_min_files"] and l not in route_langs and route_langs:
            warnings.append(f"{l}: {n} source files and no route-shaped marker hit — the marker table may not know this stack; recon must state what these files are")
    if not inv: failures.append("recon/sink-inventory.json missing or unreadable — nothing to measure")
    named_families = sorted({dir_key(f) for f in uncovered if FAMILY.search(f)})
    if named_families: warnings.append("uncovered directories whose names suggest an entry family: " + ", ".join(named_families))

    report = {"policy": POLICY, "repo": REPO, "source_files": len(src), "by_language": dict(by_lang),
              "route_shaped_files": len(route_set), "covered": len(covered_routes), "ratio": round(ratio, 3),
              "uncovered": [{"file": f, "first_marker_line": hits[f], "dir": dir_key(f)} for f in uncovered],
              "covered_not_route_shaped": covered_not_route, "families": families, "failures": failures, "warnings": warnings,
              "passed": not failures}
    os.makedirs(f"{OUT}/recon", exist_ok=True)
    json.dump(report, open(f"{OUT}/recon/_coverage.json", "w"), indent=1)
    if AS_JSON: print(json.dumps(report, indent=1)); return 0 if not failures else 1
    print(f"recon coverage — {len(src)} source files, {len(route_set)} route-shaped, {len(covered_routes)} covered by recon ({ratio:.0%}), {len(uncovered)} uncovered")
    if uncovered:
        print("uncovered route-shaped files (recon miss or false marker — the orchestrator decides which):")
        for d, v in sorted(families.items()):
            if v["uncovered"]: print(f"  {d}/  ({v['covered']}/{v['route_files']} covered)"); [print(f"    {f}:{hits[f]}") for f in v["uncovered"]]
    for w in warnings: print(f"  WARN {w}")
    for f in failures: print(f"  FAIL {f}")
    print("PASS" if not failures else "GATE FAILED — re-dispatch code-recon on the residue before the threat model and the planner consume the baseline")
    return 0 if not failures else 1

if __name__ == "__main__":
    sys.exit(main())
