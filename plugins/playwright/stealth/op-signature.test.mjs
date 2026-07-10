// Mirror drift guard for the VENDORED op-signature kernel. The canonical lives in the pentest plugin;
// this copy must stay byte-identical so the crawler dedups the same way all other recon sources do.
// Checked from BOTH sides (pentest has the twin of this test) so drift is caught whichever copy moves.
// Run:  node --test op-signature.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bodySignature, flattenParams, normPath } from './op-signature.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('vendored kernel behaves: paging collapses, filter stays distinct, dynamic segments normalized', () => {
  const base = bodySignature('POST', '/rows', JSON.stringify({ startRow: 0, filterModel: {}, sortModel: [] }));
  const page2 = bodySignature('POST', '/rows', JSON.stringify({ startRow: 100, filterModel: {}, sortModel: [] }));
  assert.equal(base, page2, 'pagination collapses (startRow is volatile)');
  const filtered = bodySignature('POST', '/rows', JSON.stringify({ startRow: 0, filterModel: { keyword: { type: 'contains' } }, sortModel: [] }));
  assert.notEqual(base, filtered, 'filter is a distinct variant');
  const s = new Set(); flattenParams({ data: { name: 'x', tags: [{ id: 1 }] } }, '', s);
  assert.deepEqual([...s].sort(), ['data.name', 'data.tags[].id']);
  assert.equal(normPath('/api/v1/users/42/profile'), '/api/v1/users/{id}/profile');
});

test('DRIFT GUARD: this vendored copy is byte-identical to the pentest canonical', () => {
  const canonicalDir = path.resolve(HERE, '../../pentest');
  const canonical = path.join(canonicalDir, 'skills/pentest/attacks/essential-skills/op-signature/op-signature.mjs');
  // Skip only in a standalone install (playwright shipped without the pentest plugin). When pentest IS
  // present (monorepo + CI), the canonical MUST exist at the expected path — a moved file hard-fails.
  if (!existsSync(canonicalDir)) { console.log('  (pentest plugin not in this install — standalone, skipping drift check)'); return; }
  assert.ok(existsSync(canonical), `pentest op-signature.mjs canonical is missing or moved (${canonical}) — re-sync`);
  assert.equal(readFileSync(path.join(HERE, 'op-signature.mjs'), 'utf8'), readFileSync(canonical, 'utf8'),
    'plugins/playwright/stealth/op-signature.mjs has DRIFTED from the pentest canonical — re-sync them byte-for-byte');
});
