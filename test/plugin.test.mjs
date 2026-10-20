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

test('kino.tmdb (Kino 0.9.53+): catalog and details with no person key', async () => {
  const calls = [];
  const fake = async (path, params) => {
    calls.push({ path, params });
    return {
      results: [{
        id: 4242, media_type: 'movie', title: 'Pelis Falsa', overview: 'Resumen falso',
        backdrop_path: '/bk.jpg', poster_path: '/bp.jpg', vote_average: 8.1,
        release_date: '2024-02-03', adult: false
      }]
    };
  };
  const real = globalThis.kino;
  globalThis.kino = { ...real, tmdb: fake };
  try {
    const sec = await plugin.section('peliculas');
    assert.ok(calls.length >= 4, 'kino.tmdb must answer the catalog rows');
    for (const c of calls) {
      assert.ok(c.path.startsWith('/') && !c.path.includes('/3'), 'path is a v3 path without /3');
      assert.ok(c.params && typeof c.params === 'object', 'params is an object');
      assert.ok(!('api_key' in c.params), 'kino.tmdb must never receive api_key');
      assert.ok(c.params.language, 'language is passed');
    }
    const tmdbRow = sec.rows.find((r) => String(r.id).startsWith('tmdb-'));
    assert.ok(tmdbRow, 'a TMDB row exists without any API key');
    const it = tmdbRow.items[0];
    assert.equal(it.ids && it.ids.tmdb, 4242, 'items carry ids.tmdb');
    assert.ok(it.overview, 'items carry overview');
    assert.ok(sec.hero.image.includes('/w780/bk.jpg'), 'hero uses the TMDB backdrop');
  } finally {
    globalThis.kino = real;
  }
});

// Fake kino.fetch answering a Hackstore page whose servers are vimeos + goodstream
// (+ optionally voe). goodstreamHs: when true the goodstream embed NEVER answers,
// reproducing the "server hangs and the whole resolve waited 15 s" stall.
// vimeosProbeOk: the stream probe (GET, like the player) verdict for the vimeos m3u8.
function hsFakeFetch({ vimeosProbeOk, goodstreamHs, withVoe }) {
  const respond = (url, opts) => {
    if (url.startsWith('https://www.hackstore.fo/peliculas/peli-falsa/')) {
      return {
        ok: true, status: 200, url,
        text: () => '<a href="play.php?u=AAAA&b=BBBB">a</a><a href="play.php?u=CCCC&b=DDDD">b</a>' +
          (withVoe ? '<a href="play.php?u=EEEE&b=FFFF">c</a>' : '')
      };
    }
    if (url.includes('play.php?u=AAAA')) return { ok: true, status: 200, url, text: () => "<script>location.href='https://vimeos.net/embed-xyz.html'</script>" };
    if (url.includes('play.php?u=CCCC')) return { ok: true, status: 200, url, text: () => "<script>location.href='https://goodstream.one/embed-xyz.html'</script>" };
    if (url.includes('play.php?u=EEEE')) return { ok: true, status: 200, url, text: () => "<script>location.href='https://voe.sx/e/abc123'</script>" };
    if (url.includes('vimeos.net/embed-xyz.html')) {
      return { ok: true, status: 200, url, text: () => '<script>sources:["https://s1.vimeos.net/hls2/01/00001/xyz_,n,.urlset/master.m3u8?t=abc&s=1&e=2"]</script>' };
    }
    if (url.includes('vimeos.net/hls2')) {
      return { ok: !!vimeosProbeOk, status: vimeosProbeOk ? 200 : 403, url, text: () => '' };
    }
    if (url.includes('goodstream.one/embed-xyz.html') && goodstreamHs) {
      return new Promise(() => {}); // never answers: the old stall
    }
    if (url.includes('goodstream.one/embed-xyz.html')) {
      return { ok: true, status: 200, url, text: () => '<script>file:"https://goodstream.one/dl/fake.mp4"</script>' };
    }
    if (url.includes('voe.sx/e/abc123')) {
      return { ok: true, status: 200, url, text: () => 'sources:[{src:"https://fakecdn.example/v/master.m3u8"}]' };
    }
    return { ok: false, status: 404, url, text: () => '' };
  };
  return async (url, opts) => respond(url, opts);
}

test('resolve does not wait for a hanging server (early-exit collector)', async () => {
  const real = globalThis.kino;
  globalThis.kino = { ...real, fetch: hsFakeFetch({ vimeosProbeOk: true, goodstreamHs: true, withVoe: false }) };
  try {
    const t0 = Date.now();
    const out = await Promise.race([
      plugin.resolve({ ref: 'hs:peliculas:peli-falsa' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('resolve se quedó esperando al servidor colgado')), 12000))
    ]);
    const elapsed = Date.now() - t0;
    assert.ok(out && out.url, 'resolve must return a stream');
    assert.ok(out.url.includes('vimeos.net'), 'the healthy server wins');
    assert.ok(elapsed < 8000, 'must not wait for the hung server, took ' + elapsed + 'ms');
  } finally {
    globalThis.kino = real;
  }
});

test('a vimeos stream whose manifest 403s on this device is skipped', async () => {
  const real = globalThis.kino;
  globalThis.kino = { ...real, fetch: hsFakeFetch({ vimeosProbeOk: false, goodstreamHs: false, withVoe: true }) };
  try {
    const out = await Promise.race([
      plugin.resolve({ ref: 'hs:peliculas:peli-falsa' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('resolve demasiado lento')), 12000))
    ]);
    assert.ok(out && out.url, 'resolve must return a stream');
    assert.ok(!out.url.includes('vimeos'), '403-ing vimeos must not be the primary');
    const all = JSON.stringify(out);
    assert.ok(!all.includes('vimeos.net'), 'nor an alternative');
    assert.ok(out.url.includes('fakecdn.example') || out.url.includes('goodstream'), 'another server wins instead');
  } finally {
    globalThis.kino = real;
  }
});

// The net79 CDN (hakunaymatata) rate-limits media with 429: without a probe the
// dead URL was returned as the ONLY stream and the whole title failed to play.
test('n79: a 429-ing CDN is not offered (probe rejects the stream)', async () => {
  const real = globalThis.kino;
  globalThis.kino = { ...real, fetch: async (url) => {
    if (url.startsWith('https://net79.cc/api/embed-tmdb/1561726')) {
      return { ok: true, status: 200, url, text: () => JSON.stringify({ mp4: 'https://bcdnxw.hakunaymatata.com/resource/x.mp4' }) };
    }
    if (url.includes('hakunaymatata.com')) return { ok: false, status: 429, url, text: () => '' };
    return { ok: false, status: 404, url, text: () => '' };
  } };
  try {
    await assert.rejects(
      () => plugin.resolve({ ref: 'n79:movie:1561726' }),
      (e) => e && e.code === 'unavailable',
      'a dead CDN must surface as unavailable, never as a broken stream'
    );
  } finally {
    globalThis.kino = real;
  }
});

test('n79: a healthy stream is kept and carries the net79 referer', async () => {
  const real = globalThis.kino;
  globalThis.kino = { ...real, fetch: async (url) => {
    if (url.startsWith('https://net79.cc/api/embed-tmdb/1561726')) {
      return { ok: true, status: 200, url, text: () => JSON.stringify({ mp4: 'https://cdn.n79play.example/resource/x.mp4' }) };
    }
    if (url.includes('cdn.n79play.example')) return { ok: true, status: 206, url, text: () => '' };
    return { ok: false, status: 404, url, text: () => '' };
  } };
  try {
    const out = await plugin.resolve({ ref: 'n79:movie:1561726' });
    assert.ok(out && out.url.includes('cdn.n79play.example'), 'the healthy n79 stream is returned');
    assert.equal(out.headers && out.headers.Referer, 'https://net79.cc/', 'streams carry the net79 referer');
  } finally {
    globalThis.kino = real;
  }
});
