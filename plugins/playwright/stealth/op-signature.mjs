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
export const normPath = (p) => p.replace(/\/\d+(?=\/|$)/g, '/{id}').replace(UUID_SEG, '/{id}').replace(/\/[0-9a-f]{8,}(?=\/|$)/gi, '/{id}');
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
