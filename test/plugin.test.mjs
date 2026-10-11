// Offline test: answers come from test/fixtures.json (record it once with
//   node sdk/run.mjs --record test/fixtures.json . search "algo").
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createKino } from '../sdk/kino-shim.mjs';

const manifest = JSON.parse(readFileSync('./kino-plugin.json', 'utf8'));
const fixturesPath = './test/fixtures.json';
const hasFixtures = existsSync(fixturesPath);
const tape = hasFixtures ? JSON.parse(readFileSync(fixturesPath, 'utf8')) : [];

const { kino } = createKino(manifest, hasFixtures ? { replay: fixturesPath } : {});
globalThis.kino = kino;

const plugin = await import('../plugin.js');

test('manifest is apiVersion 6 with browser pages', () => {
  assert.equal(manifest.apiVersion, 6);
  assert.equal(manifest.browser, 'pages');
  assert.ok(Array.isArray(manifest.hosts) && manifest.hosts.length > 20);
  assert.equal(manifest.streamHosts, 'any');
  assert.ok(manifest.theme, 'manifest must declare theme');
  assert.equal(manifest.theme.accent, '#FF6B00');
  assert.ok(manifest.section, 'manifest must declare section');
  assert.equal(manifest.section.label, 'YojaTV');
  assert.deepEqual(manifest.categories, ['movies', 'series', 'anime']);
});

test('categories export returns categories array', async () => {
  const cats = await plugin.categories();
  assert.ok(Array.isArray(cats), 'categories must return an array');
  assert.ok(cats.length >= 3, 'at least 3 categories');
  for (const c of cats) {
    assert.ok(c.id && c.title && c.ref);
    assert.ok(c.ref.startsWith('browse:'));
  }
});

test('section export returns tabs and rows', async () => {
  const sec = await plugin.section('peliculas');
  assert.ok(sec && typeof sec === 'object', 'section must return object');
  assert.ok(Array.isArray(sec.tabs), 'section must have tabs');
  assert.ok(Array.isArray(sec.rows), 'section must have rows');
  assert.equal(sec.tab, 'peliculas');
});

test('home returns rows', { skip: !hasFixtures }, async () => {
  const rows = await plugin.home();
  assert.ok(Array.isArray(rows), 'home must return an array');
  for (const row of rows) {
    assert.ok(row.id && row.id.length > 0, 'row must have id');
    assert.ok(row.title && row.title.length > 0, 'row must have title');
    assert.ok(Array.isArray(row.items), 'row must have items');
    for (const item of row.items) {
      assert.match(item.id, /^[A-Za-z0-9._~-]{1,128}$/, 'item id must match pattern');
      assert.ok(item.ref && item.ref.length <= 4096, 'item ref must be present');
      assert.ok(item.title && item.title.length > 0, 'item must have title');
      assert.ok(['movie', 'series'].includes(item.kind), 'item kind must be movie or series');
    }
  }
});

test('search returns filtered items', { skip: !hasFixtures }, async () => {
  const items = await plugin.search('batman');
  assert.ok(Array.isArray(items), 'search must return an array');
  for (const item of items.slice(0, 20)) {
    assert.match(item.id, /^[A-Za-z0-9._~-]{1,128}$/);
    assert.ok(item.ref && item.ref.includes(':'), 'ref must be <srcId>:<path>');
    assert.ok(item.title);
  }
});

test('episodes returns list for a series ref', { skip: !hasFixtures }, async () => {
  const result = await plugin.episodes({ ref: 'jkanime:one-piece' });
  assert.ok(result && Array.isArray(result.episodes), 'episodes must return object with array');
  if (result.episodes.length > 0) {
    assert.equal(typeof result.episodes[0].number, 'number');
    assert.ok(result.episodes[0].ref);
  }
});

test('resolve returns a stream with url', { skip: !hasFixtures }, async () => {
  const stream = await plugin.resolve({ ref: 'jkanime:one-piece/1' });
  assert.ok(stream && stream.url, 'resolve must return object with url');
  assert.ok(stream.url.startsWith('http'), 'url must start with http');
});

test('registry has sources with resolve', async () => {
  // The registry is internal; exercise it through the public surface instead:
  // an unknown source ref must throw a typed kino error, not crash.
  await assert.rejects(async () => await plugin.resolve({ ref: 'nope:x' }), (e) => e && e.code === 'not_found');
});

test('an empty query returns an empty list', async () => {
  const items = await plugin.search('');
  assert.deepEqual(items, []);
});
