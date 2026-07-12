// Shared, single-source-of-truth token set for "non-persistent write" path segments — imported by
// crawl-write.mjs (the create persistence oracle AND the session-write mutation classifier). Two roles:
//   1. Create oracle (ADVISORY): a token only DEPRIORITIZES an ambiguous write; a strong positive signal
//      (201 / Location / URL→detail / non-echoed id) OVERRIDES it — so a real 201 on a `…/validation` path is
//      still a create (this is why the earlier "remove the tokens" fix is unnecessary now, and kept out).
//   2. Session-write classification (AUTHORITATIVE): a POST-2xx to one of these terminal segments is a READ /
//      preview / telemetry, NOT a mutation → crud-merge does not seed it as a cross-identity replay target.
// These are unambiguous read/preview/telemetry markers; a create-bearing segment (vendor, invoice, order, …)
// is never here, so keeping the list broad is safe.
export const NON_PERSIST_TOKENS = new Set([
  // preview / validation
  'preview', 'validate', 'validation', 'validations', 'check', 'checks', 'verify',
  // typeahead / search / lists (read POSTs)
  'search', 'autocomplete', 'typeahead', 'suggest', 'suggestion', 'suggestions', 'lookup',
  'list', 'listing', 'count', 'export', 'download',
  // telemetry / activity / logging / metrics
  'activity', 'activities', 'log', 'logs', 'logging', 'track', 'tracking', 'trace',
  'telemetry', 'analytics', 'metric', 'metrics', 'event', 'events', 'ping', 'heartbeat', 'health', 'status',
]);
