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
export const normPath = (p) => p.replace(/\/\d+(?=\/|$)/g, '/{id}').replace(/\/[0-9a-f]{8,}(?=\/|$)/gi, '/{id}');
