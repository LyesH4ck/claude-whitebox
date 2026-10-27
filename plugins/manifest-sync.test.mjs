// DRIFT GUARD for the marketplace manifest.
//
// `.claude-plugin/marketplace.json` duplicates every plugin's name, version and description from that
// plugin's own `.claude-plugin/plugin.json`. Duplicated metadata drifts silently: the marketplace entry for
// `codeaudit` sat at 0.1.17 / "10 vulnerability domains" while the plugin itself had moved to 0.3.0 / 17
// domains, so users installing from the marketplace saw a stale version and an understated feature list.
// Nothing fails when that happens — the plugin still loads — which is exactly why it needs a test.
//
// Rule: the plugin's own plugin.json is CANONICAL. The marketplace entry must mirror it byte-for-byte.
//
// Run:  node --test plugins/manifest-sync.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const marketplace = readJson(path.join(ROOT, '.claude-plugin/marketplace.json'));

test('marketplace lists at least one plugin and each entry has the required keys', () => {
  assert.ok(Array.isArray(marketplace.plugins), 'marketplace.plugins must be an array');
  assert.ok(marketplace.plugins.length > 0, 'marketplace lists no plugins');
  for (const entry of marketplace.plugins) {
    for (const key of ['name', 'source', 'version', 'description']) {
      assert.ok(entry[key], `marketplace entry ${entry.name ?? '<unnamed>'} is missing "${key}"`);
    }
  }
});

test('every marketplace source resolves to a real plugin directory with a manifest', () => {
  for (const entry of marketplace.plugins) {
    const dir = path.resolve(ROOT, entry.source);
    assert.ok(existsSync(dir) && statSync(dir).isDirectory(),
      `marketplace source "${entry.source}" (${entry.name}) does not resolve to a directory`);
    assert.ok(existsSync(path.join(dir, '.claude-plugin/plugin.json')),
      `${entry.name}: no .claude-plugin/plugin.json under ${entry.source}`);
  }
});

test('DRIFT GUARD: marketplace name/version/description mirror each plugin.json exactly', () => {
  for (const entry of marketplace.plugins) {
    const own = readJson(path.resolve(ROOT, entry.source, '.claude-plugin/plugin.json'));
    assert.equal(entry.name, own.name,
      `${entry.name}: marketplace name != plugin.json name ("${own.name}")`);
    assert.equal(entry.version, own.version,
      `${entry.name}: marketplace version ${entry.version} != plugin.json ${own.version} — ` +
      `bump the marketplace entry (plugin.json is canonical)`);
    assert.equal(entry.description, own.description,
      `${entry.name}: marketplace description has drifted from plugin.json — copy plugin.json's across`);
  }
});

test('every plugin directory on disk is listed in the marketplace', () => {
  const listed = new Set(marketplace.plugins.map((e) => e.name));
  for (const name of readdirSync(HERE, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)) {
    if (!existsSync(path.join(HERE, name, '.claude-plugin/plugin.json'))) continue; // not a plugin
    assert.ok(listed.has(name),
      `plugins/${name} has a plugin.json but is not listed in .claude-plugin/marketplace.json`);
  }
});
