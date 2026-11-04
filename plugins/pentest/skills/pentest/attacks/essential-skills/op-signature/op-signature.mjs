// op-signature — canonical recon operation-signature + param helpers.
// SHARED so every recon source (crawl.mjs, burp-import.mjs, crud-merge.mjs) dedups IDENTICALLY: a drift makes
// the same request hash differently and the surface-analyzer union then double-counts it. Cross-plugin imports
// are not portable (versioned cache dirs), so this file is VENDORED byte-for-byte in two places, and a drift
// test (op-signature.test.mjs) fails if the two copies diverge:
//   plugins/pentest/skills/pentest/attacks/essential-skills/op-signature/op-signature.mjs   (canonical)
//   plugins/playwright/stealth/op-signature.mjs                                              (vendored copy)
// Pure, zero-dep (Node 18+).

const VOLATILE = new Set(['startrow', 'endrow', 'offset', 'page', 'pagesize', 'limit', 'cursor', 'skip', 'take', 'from', 'size', '_', 't', 'timestamp', 'ts']);
const DISC = new Set(['colid', 'field', 'filtertype', 'type', 'operator', 'sort', 'aggfunc']);
const skeleton = (v) => Array.isArray(v) ? '[' + (v.length ? skeleton(v[0]) : '') + ']'
  : (v && typeof v === 'object') ? '{' + Object.keys(v).sort().map((k) => k + ':' + skeleton(v[k])).join(',') + '}'
  : typeof v;
function salient(v, key, acc) {
  if (Array.isArray(v)) { for (const e of v) salient(e, key, acc); return; }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => !VOLATILE.has(k.toLowerCase()));
    if (key && /filter|group|pivot/i.test(key) && keys.length) acc.add(key.toLowerCase() + ':{' + keys.map((k) => k.toLowerCase()).sort().join(',') + '}');
    for (const k of Object.keys(v)) salient(v[k], k, acc);
    return;
  }
  if (key && DISC.has(key.toLowerCase()) && !VOLATILE.has(key.toLowerCase())) acc.add(key.toLowerCase() + '=' + String(v).slice(0, 40));
}
// operation fingerprint: keeps filter/sort/group variants, collapses volatile paging, folds non-volatile query keys.
export function bodySignature(method, pth, postData, query) {
  let shape = '', sal = '';
  if (postData) {
    try { const j = JSON.parse(postData); shape = skeleton(j); const acc = new Set(); salient(j, '', acc); sal = [...acc].sort().join('|'); }
    catch { shape = postData.split('&').map((kv) => kv.split('=')[0]).filter((k) => !VOLATILE.has(k.toLowerCase())).sort().join('&'); }
  }
  let q = '';
  if (query) { try { q = [...new URLSearchParams(query).keys()].filter((k) => !VOLATILE.has(k.toLowerCase())).sort().join(','); } catch { /* skip */ } }
  return `${method} ${pth} ${shape} ${sal} ${q}`;
}
// flatten a JSON body/query into dotted leaf param names (arrays -> [])
export function flattenParams(v, prefix, out) {
  if (Array.isArray(v)) { if (v.length) flattenParams(v[0], prefix + '[]', out); else if (prefix) out.add(prefix + '[]'); return; }
  if (v && typeof v === 'object') { for (const k of Object.keys(v)) flattenParams(v[k], prefix ? prefix + '.' + k : k, out); return; }
  if (prefix) out.add(prefix);
}
// Collapse id-shaped segments to `{id}`: all-digit, a canonical 8-4-4-4-12 UUID, or 8+ hex (ObjectId, dashless
// UUID, hash). The UUID rule was missing: its dashes broke the hex run, so every `/orders/<uuid>` stayed a
// distinct "route" — one per object seen — and a UUID-keyed API inflated the surface by its object count.
const UUID_SEG = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi;
const normSegs = (p) => p.replace(/\/\d+(?=\/|$)/g, '/{id}').replace(UUID_SEG, '/{id}').replace(/\/[0-9a-f]{8,}(?=\/|$)/gi, '/{id}');
// The `#operation` suffix (see GraphQL below) is an identifier, not a path: it is carried through untouched.
export const normPath = (p) => { const i = p.indexOf(OP_SEP); return i < 0 ? normSegs(p) : normSegs(p.slice(0, i)) + p.slice(i); };

// ── GraphQL operations ───────────────────────────────────────────────────────────────────────────────────────
// GraphQL sends every operation to ONE path, so at path level a mutation, a query and a resolver nobody else calls
// are a single "route": one row in the corpus, one unit on the worklist, one node in the graph, nothing to order.
// The operation therefore becomes part of the path — `/graphql#CreateNote` — which every key builder downstream
// carries unchanged, and which never reaches the target: a URL fragment is not sent on the wire.
// Name, in order: operationName · the named definition · `<type>:<root fields>` for an anonymous document (stable
// across values, unlike a hash of the text) · `apq:<sha256 prefix>` for a persisted query sent without its text.
export const OP_SEP = '#';
const GQL_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;
const GQL_PATH = /\/(graphql|gql)(\/|$)/i;   // a hint for the `{ … }` shorthand only — the body is authoritative
const OP_SUFFIX = /^#(?:[_A-Za-z][_0-9A-Za-z]*|(?:query|mutation|subscription):[_0-9A-Za-z+]+|apq:[0-9a-f]{12})$/;
const stripGql = (d) => d.replace(/"""[\s\S]*?"""/g, '""').replace(/"(?:[^"\\\n]|\\.)*"/g, '""').replace(/#[^\n\r]*/g, '');
const gqlTokens = (d) => stripGql(d).match(/\.\.\.|[_A-Za-z][_0-9A-Za-z]*|[{}():@$!=[\],]|""/g) || [];
function gqlDefs(doc) {
  const t = gqlTokens(doc), defs = [];
  const close = (j) => { let d = 0; for (; j < t.length; j++) { if (t[j] === '{') d++; else if (t[j] === '}' && --d === 0) return j + 1; } return j; };
  for (let i = 0; i < t.length;) {
    const k = t[i];
    if (k === '{') { defs.push({ type: 'query', name: null, at: i }); i = close(i); continue; }
    if (/^(query|mutation|subscription|fragment)$/.test(k)) {
      let j = i + 1, name = null, p = 0;
      if (GQL_NAME.test(t[j] || '') && k !== 'fragment') name = t[j];
      while (j < t.length && !(t[j] === '{' && p === 0)) { if (t[j] === '(') p++; else if (t[j] === ')') p--; j++; }
      if (k !== 'fragment' && t[j] === '{') defs.push({ type: k, name, at: j });   // no selection set: not a definition
      i = close(j); continue;
    }
    i++;
  }
  return { t, defs };
}
// Top-level fields of one selection set: the resolvers the operation actually reaches. Aliases resolve to the
// field; arguments, nested selections, directives and fragment spreads are skipped.
function rootFields(t, at) {
  const out = new Set();
  let d = 0, p = 0;
  for (let j = at; j < t.length; j++) {
    const x = t[j];
    if (x === '{') { d++; continue; }
    if (x === '}') { if (--d === 0) break; continue; }
    if (x === '(') { p++; continue; }
    if (x === ')') { p--; continue; }
    if (d !== 1 || p !== 0 || !GQL_NAME.test(x)) continue;
    const prev = t[j - 1];
    if (prev === '...' || prev === '@' || (prev === 'on' && t[j - 2] === '...') || t[j + 1] === ':') continue;
    out.add(x);
  }
  return [...out].sort();
}
function gqlOp(it, hinted) {
  if (!it || typeof it !== 'object' || Array.isArray(it)) return null;
  const named = typeof it.operationName === 'string' && GQL_NAME.test(it.operationName) ? it.operationName : null;
  if (typeof it.query === 'string' && it.query.trim()) {
    const s = stripGql(it.query);
    const keyword = /(^|[^_0-9A-Za-z])(query|mutation|subscription)\s*[_A-Za-z({@]/.test(s);
    if (!keyword && !(/^\s*\{\s*[_A-Za-z]/.test(s) && (hinted || named))) return null;   // `{"query":"shoes"}` is a search
    const { t, defs } = gqlDefs(it.query);
    if (!defs.length) return null;
    const def = (named && defs.find((x) => x.name === named)) || defs[0];
    const anon = `${def.type}:${rootFields(t, def.at).slice(0, 3).join('+') || 'anonymous'}`;
    return { name: named || def.name || anon, type: def.type, type_source: 'document' };
  }
  // No document on the wire (a persisted query: `documentId`, an APQ hash). Relay's compiler REQUIRES an operation
  // name to end in Query / Mutation / Subscription, so that suffix is the kind; it is marked `name`, never passed
  // off as read from a document. Anything else stays unknown.
  const byName = (n) => { const m = /[a-z0-9_](Query|Mutation|Subscription)$/.exec(n || ''); return m ? m[1].toLowerCase() : null; };
  const kind = (n) => (byName(n) ? { type: byName(n), type_source: 'name' } : { type: null, type_source: null });
  const apq = it.extensions?.persistedQuery?.sha256Hash;
  if (typeof apq === 'string' && /^[0-9a-f]{12,}$/i.test(apq)) return { name: named || `apq:${apq.slice(0, 12).toLowerCase()}`, ...kind(named) };
  if (named && (hinted || 'documentId' in it || 'id' in it)) return { name: named, ...kind(named) };   // persisted document keyed by id
  return null;
}
/** The GraphQL operation(s) a request carries — [{name, type, index}] (index = position in a batch, else null) — or null. */
export function graphqlOps(method, pth, query, bodyText) {
  const items = [];
  let batch = false;
  if (bodyText && /^\s*[[{]/.test(bodyText)) {
    let j; try { j = JSON.parse(bodyText); } catch { j = undefined; }
    if (Array.isArray(j)) { batch = true; items.push(...j); } else if (j && typeof j === 'object') items.push(j);
  }
  if (!items.length && query) {
    let q; try { q = new URLSearchParams(query); } catch { q = null; }
    if (q && (q.has('query') || q.has('extensions'))) {
      const o = { query: q.get('query') ?? undefined, operationName: q.get('operationName') ?? undefined };
      try { if (q.has('extensions')) o.extensions = JSON.parse(q.get('extensions')); } catch { /* not JSON */ }
      items.push(o);
    }
  }
  const hinted = GQL_PATH.test(pth || '');
  const ops = [];
  items.forEach((it, i) => { const op = gqlOp(it, hinted); if (op) ops.push({ ...op, index: batch ? i : null }); });
  return ops.length && (!batch || ops.length === items.length) ? ops : null;
}
/**
 * One HTTP request → the operation(s) it carries, each with the path that keys it and the body that is ITS (a batch
 * item, re-serialised). A non-GraphQL request is a single operation on its own path, with `graphql: null`.
 */
export function splitOperations(method, pth, query, bodyText) {
  const ops = graphqlOps(method, pth, query, bodyText);
  if (!ops) return [{ path: pth, body: bodyText || null, graphql: null }];
  let arr = null;
  if (ops[0].index !== null) { try { arr = JSON.parse(bodyText); } catch { arr = null; } }
  return ops.map((o) => ({
    path: pth + OP_SEP + o.name,
    body: o.index !== null && arr ? JSON.stringify(arr[o.index]) : (bodyText || null),
    graphql: { operation: o.name, type: o.type, type_source: o.type_source ?? null, batch_index: o.index },
  }));
}
/** A parsed URL's path, keeping an operation suffix (`#CreateNote`) and dropping any other fragment (`#/route`). */
export const urlPath = (u) => u.pathname + (OP_SUFFIX.test(u.hash || '') ? u.hash : '');
/** `/graphql#CreateNote` → {path:'/graphql', operation:'CreateNote'}; a path with no suffix → operation null. */
export function splitOp(p) {
  const s = String(p ?? ''), i = s.indexOf(OP_SEP);
  return i >= 0 && OP_SUFFIX.test(s.slice(i)) ? { path: s.slice(0, i), operation: s.slice(i + 1) } : { path: s, operation: null };
}
/** Append an operation a log line names in its own field, when the path does not already carry one. */
export const withOp = (p, op) => (op && splitOp(p).operation === null && OP_SUFFIX.test(OP_SEP + op) ? p + OP_SEP + op : p);
const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
// Collect tagged param names from a request's query + body into a Set: `query:k`, `json:a.b[].c` (nested leaves),
// or `form:k`. The canonical extraction every recon source shares (crawl / crawl-write / burp-import).
export function collectParams(query, postData, into = new Set()) {
  if (query) { try { for (const k of new URLSearchParams(query).keys()) into.add('query:' + k); } catch { /* skip */ } }
  if (postData) {
    try { const j = JSON.parse(postData); const s = new Set(); flattenParams(j, '', s); for (const p of s) into.add('json:' + p); }
    catch { for (const kv of postData.split('&')) { const k = kv.split('=')[0]; if (k) into.add('form:' + safeDecode(k)); } }
  }
  return into;
}
// Expand tagged param names (Set/array) into inventory rows [{name, in, sample:null}].
export function paramRows(tags) {
  return [...tags].map((p) => { const i = p.indexOf(':'); return { name: p.slice(i + 1), in: p.slice(0, i), sample: null }; });
}
