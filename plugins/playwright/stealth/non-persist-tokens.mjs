// Shared, single-source-of-truth token set for "non-persistent write" path segments — imported by both
// crawl-write.mjs (the create persistence oracle) and crud-merge.mjs (the session-write mutation filter), so the
// two copies can never drift (P2). ADVISORY only: a strong positive signal (201 / Location / non-echoed id)
// overrides it. The review removed the lottery singular/plural tokens (check(s), list, activity, log(s), track,
// trace, count, health) that wrongly disqualified real creates; these remaining tokens are unambiguously
// read/preview/telemetry. Keep this list conservative — a token here can suppress a seed.
export const NON_PERSIST_TOKENS = new Set([
  'preview', 'validate', 'validation', 'validations',
  'autocomplete', 'typeahead', 'suggest', 'suggestion', 'suggestions',
  'search', 'lookup',
  'telemetry', 'analytics', 'metric', 'metrics',
  'export', 'download',
  'ping', 'heartbeat',
]);
