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

const kit = createKino(manifest, hasFixtures ? { replay: fixturesPath } : {});
const { kino } = kit;
globalThis.kino = kino;

// The shim counts kino.fetch per process (60 max) and caches TMDB responses in
// storage: every test that drives the catalog must start from a clean budget and
// cache, or it fails based on what ran before it.
function freshCatalogCall() {
  kit.resetBudget();
  for (const k of kino.storage.keys()) if (String(k).startsWith('tmdb:')) kino.storage.remove(k);
}

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

test('early-exit collector: the healthy server wins and vimeos never becomes primary', async () => {
  const real = globalThis.kino;
  globalThis.kino = { ...real, fetch: hsFakeFetch({ vimeosProbeOk: true, goodstreamHs: true, withVoe: true }) };
  try {
    const t0 = Date.now();
    const out = await Promise.race([
      plugin.resolve({ ref: 'hs:peliculas:peli-falsa' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('resolve se quedó esperando al servidor colgado')), 12000))
    ]);
    const elapsed = Date.now() - t0;
    assert.ok(out && out.url, 'resolve must return a stream');
    assert.ok(out.url.includes('fakecdn.example'), 'the healthy non-vimeos server wins');
    assert.ok(!out.url.includes('vimeos'), 'vimeos (player-403) must not win while another stream exists');
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

test('vimeos is still offered as the last resort when it is the only candidate', async () => {
  const real = globalThis.kino;
  globalThis.kino = { ...real, fetch: hsFakeFetch({ vimeosProbeOk: true, goodstreamHs: false, withVoe: false }) };
  try {
    const out = await Promise.race([
      plugin.resolve({ ref: 'hs:peliculas:peli-falsa' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('resolve demasiado lento')), 12000))
    ]);
    assert.ok(out && out.url.includes('vimeos'), 'with no other stream, vimeos remains the last resort');
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
      (e) => e && e.code === 'unavailable' &&
        e.userMessage === 'Este título no se ha encontrado en YojaTV',
      'a dead CDN must surface as the friendly user message, never as a broken stream'
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
    if (url.includes('cdn.n79play.example')) {
      return { ok: true, status: 206, url, headers: { 'content-range': 'bytes 0-0/524288000' }, text: () => '' };
    }
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

// Fake-intro bait: sites serve a real 2-8MB file (studio logo/teaser) titled as
// the movie so playback "works" for seconds. Measured: 2.5MB and 7.2MB baits.
test('a mp4 smaller than 15MB is rejected as bait (fake intro)', async () => {
  const real = globalThis.kino;
  globalThis.kino = { ...real, fetch: async (url) => {
    if (url.startsWith('https://net79.cc/api/embed-tmdb/1561726')) {
      return { ok: true, status: 200, url, text: () => JSON.stringify({ mp4: 'https://cdn.n79play.example/resource/logo.mp4' }) };
    }
    if (url.includes('cdn.n79play.example')) {
      return { ok: true, status: 206, url, headers: { 'content-range': 'bytes 0-0/2663878' }, text: () => '' };
    }
    return { ok: false, status: 404, url, text: () => '' };
  } };
  try {
    await assert.rejects(
      () => plugin.resolve({ ref: 'n79:movie:1561726' }),
      (e) => e && e.code === 'unavailable',
      'a 2.5MB fake intro must never reach the player'
    );
  } finally {
    globalThis.kino = real;
  }
});

// Catálogo sin títulos sin estrenar: fecha de estreno FUTURA oculta el título en
// búsqueda; un estreno reciente (con stream o sin él) sigue visible. Decisión del
// usuario: Street Fighter (PelisPlusHD) se muestra; lo no estrenado no.
test('search hides titles TMDB marks as not yet released', { skip: !hasFixtures }, async () => {
  freshCatalogCall();
  const real = globalThis.kino;
  const fake = async (path, params) => {
    if (path === '/search/multi') {
      return { results: [
        { id: 777001, media_type: 'movie', title: 'Batman & Robin', release_date: '2027-05-01', adult: false, vote_average: 5, overview: '' },
        { id: 777002, media_type: 'movie', title: 'Batman: Año Uno', release_date: '2026-10-16', adult: false, vote_average: 7, overview: '' }
      ] };
    }
    return { results: [] };
  };
  globalThis.kino = { ...real, tmdb: fake };
  try {
    const items = await plugin.search('batman');
    assert.ok(!items.some((it) => it.title === 'Batman & Robin'), 'the not-yet-released title must be hidden');
    assert.ok(items.some((it) => it.title === 'Batman: Año Uno'), 'a recently premiered title must stay visible');
    assert.ok(items.some((it) => it.title === 'Batman Returns'), 'released titles must stay visible');
  } finally {
    globalThis.kino = real;
  }
});

test('section hides TMDB catalog items whose release is still in the future', async () => {
  freshCatalogCall();
  const real = globalThis.kino;
  const fake = async (path, params) => ({
    results: [
      { id: 888001, media_type: 'movie', title: 'Reciente Estreno', overview: '', adult: false,
        backdrop_path: '/rt.jpg', poster_path: '/rt2.jpg', vote_average: 7, release_date: '2026-10-16' },
      { id: 888002, media_type: 'movie', title: 'Estreno Futuro', overview: '', adult: false,
        backdrop_path: '/up.jpg', poster_path: '/up2.jpg', vote_average: 7, release_date: '2027-01-15' }
    ]
  });
  globalThis.kino = { ...real, tmdb: fake };
  try {
    const sec = await plugin.section('peliculas');
    const tmdbItems = sec.rows.filter((r) => String(r.id).startsWith('tmdb-')).flatMap((r) => r.items);
    assert.ok(tmdbItems.some((it) => it.title === 'Reciente Estreno'), 'a premiered TMDB item must stay visible');
    assert.ok(!tmdbItems.some((it) => it.title === 'Estreno Futuro'), 'a future release must not appear');
    assert.ok(sec.hero.image, 'the hero keeps a usable image');
  } finally {
    globalThis.kino = real;
  }
});

// Un resolve TMDB caminaba decenas de candidatos (Street Fighter: 35) hasta vaciar
// el cupo de 60 kino.fetch de una sola llamada.
test('tmdb resolve caps candidates at 10 so the fetch budget survives', { skip: !hasFixtures }, async () => {
  freshCatalogCall();
  const real = globalThis.kino;
  const lines = [];
  globalThis.kino = { ...real, log: (...a) => { lines.push(a.join(' ')); } };
  try {
    await assert.rejects(
      () => plugin.resolve({ ref: 'tmdb:movie:1:batman' }),
      (e) => e && e.code === 'unavailable',
      'nothing resolves offline: this test only measures the candidate walk'
    );
    const c = lines.find((l) => l.includes('[tmdb] "batman" (movie):'));
    assert.ok(c, 'the candidate count must be logged');
    const m = /(\d+) candidate\(s\)/.exec(c);
    assert.ok(m && +m[1] > 0, 'candidates were scored');
    assert.ok(+m[1] <= 10, 'at most 10 candidates may be walked, got ' + (m && m[1]));
    assert.ok(lines.some((l) => l.includes('candidatos recortados')), 'the caps must engage on a franchise query');
  } finally {
    globalThis.kino = real;
  }
});
