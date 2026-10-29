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

test('manifest is apiVersion 11 with browser pages', () => {
  assert.equal(manifest.apiVersion, 11);
  assert.equal(manifest.browser, 'pages');
  assert.ok(Array.isArray(manifest.hosts) && manifest.hosts.length > 20);
  assert.equal(manifest.streamHosts, 'any');
  assert.equal(manifest.fetchHosts, 'any');
  assert.ok(manifest.theme, 'manifest must declare theme');
  assert.equal(manifest.theme.accent, '#FF6B00');
  assert.equal(manifest.color, '#FF6B00');
  assert.ok(manifest.section, 'manifest must declare section');
  assert.equal(manifest.section.label, 'YojaTV');
  assert.ok(manifest.panel && manifest.panel.iconFile, 'manifest must declare the player panel');
  assert.ok(Array.isArray(manifest.capabilities) && manifest.capabilities.includes('migrate'), 'migrate capability');
  assert.ok(manifest.capabilities.includes('nuvio'), 'nuvio capability is enabled');
  assert.ok(Array.isArray(manifest.nuvioRepos) && manifest.nuvioRepos.includes('D3adlyRocket/All-in-One-Nuvio'), 'nuvioRepos names the Nuvio repo');
  assert.ok(!manifest.capabilities.includes('externalResolve'), 'external resolve stays disabled');
  assert.ok(Array.isArray(manifest.settingsLayout) && manifest.settingsLayout.some((s) => s.type === 'card'), 'settingsLayout cards');
  assert.deepEqual(manifest.categories, ['movies', 'series', 'anime', 'live']);
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

/* ---------- 6.0.0: fila "Ver más", scopedSearch, migrate, panel, action ---------- */

test('manifest declares the scopedSearch capability', () => {
  assert.ok(Array.isArray(manifest.capabilities) && manifest.capabilities.includes('scopedSearch'), 'scopedSearch capability');
});

test('home rows carry a browse ref for "Ver más"', { skip: !hasFixtures }, async () => {
  freshCatalogCall();
  const rows = await plugin.home();
  assert.ok(rows.length > 0, 'home must return rows');
  for (const row of rows) {
    assert.ok(typeof row.ref === 'string' && row.ref.startsWith('browse:'), 'row ref must be a browse ref: ' + row.id);
    assert.ok(row.ref.length <= 4096, 'row ref within limit');
  }
});

test('section rows carry a browse ref for "Ver más"', { skip: !hasFixtures }, async () => {
  freshCatalogCall();
  const sec = await plugin.section('peliculas');
  assert.ok(sec.rows.length > 0, 'section must return rows');
  for (const row of sec.rows) {
    assert.ok(typeof row.ref === 'string' && row.ref.startsWith('browse:'), 'row ref must be a browse ref: ' + row.id);
  }
});

test('browse opens a source row ref with the two-argument signature', { skip: !hasFixtures }, async () => {
  freshCatalogCall();
  const page = await plugin.browse('browse:src:sl', null);
  assert.ok(page && Array.isArray(page.items), 'browse must return a page');
  assert.ok(page.items.length > 0, 'a source row must open');
  assert.equal(page.next, null, 'source rows have no further pages');
  for (const it of page.items) assert.ok(it.ref && it.id, 'page items are full items');
});

test('browse opens the classic topic refs unchanged', { skip: !hasFixtures }, async () => {
  freshCatalogCall();
  const page = await plugin.browse('browse:movies', null);
  assert.ok(page && Array.isArray(page.items) && page.items.length > 0, 'topic browse keeps working');
});

test('browse pages a TMDB row ref through its cursor', async () => {
  freshCatalogCall();
  const real = globalThis.kino;
  const seen = [];
  const fake = async (path, params) => {
    seen.push({ path, page: params && params.page });
    return { results: Array.from({ length: 20 }, (_, i) => ({
      id: 900000 + i, media_type: 'movie', title: 'Película ' + i, overview: '', adult: false,
      backdrop_path: '/b.jpg', poster_path: '/p.jpg', vote_average: 6, release_date: '2024-01-01'
    })) };
  };
  globalThis.kino = { ...real, tmdb: fake };
  try {
    const ref = 'browse:tmdb:' + encodeURIComponent(JSON.stringify({ p: '/movie/popular', k: 'movie', g: null }));
    const page1 = await plugin.browse(ref, null);
    assert.equal(seen[0].page, '1', 'the first page is page 1');
    assert.equal(page1.items.length, 20, 'a full page comes back');
    assert.equal(page1.next, '2', 'a full page offers the next cursor');
    const page2 = await plugin.browse(ref, page1.next);
    assert.equal(seen[1].page, '2', 'the cursor drives the next page');
    assert.equal(page2.next, '3', 'the fixture page is still full, so it still offers a next cursor');
    assert.ok(!page1.items.some((it) => it.ref.startsWith('browse:')), 'page items are titles, not rows');
  } finally {
    globalThis.kino = real;
  }
});

test('search within a row ref filters locally and answers null when it cannot', async () => {
  freshCatalogCall();
  const real = globalThis.kino;
  const fake = async () => ({ results: Array.from({ length: 5 }, (_, i) => ({
    id: 910000 + i, media_type: 'movie', title: i === 0 ? 'Alpha Película' : 'Otra Cinta ' + i, overview: '', adult: false,
    backdrop_path: '/b.jpg', poster_path: '/p.jpg', vote_average: 6, release_date: '2024-01-01'
  })) });
  globalThis.kino = { ...real, tmdb: fake };
  try {
    const within = 'browse:tmdb:' + encodeURIComponent(JSON.stringify({ p: '/movie/popular', k: 'movie', g: null }));
    const hits = await plugin.search({ q: 'alpha', within });
    assert.ok(Array.isArray(hits), 'scoped search answers an array');
    assert.equal(hits.length, 1, 'the local filter keeps only the match');
    assert.equal(hits[0].title, 'Alpha Película');
    const empty = await plugin.search({ q: 'zzz-nada', within });
    assert.deepEqual(empty, [], 'no match inside the scope is an empty list');
    const unknown = await plugin.search({ q: 'algo', within: 'browse:src:nope' });
    assert.equal(unknown, null, 'an unopenable scope answers null so Kino filters itself');
  } finally {
    globalThis.kino = real;
  }
});

test('migrate claims an IMDb id through TMDB as an n79 ref', async () => {
  freshCatalogCall();
  const real = globalThis.kino;
  const fake = async (path) => {
    if (path.indexOf('/find/tt13999') === 0) {
      return { movie_results: [], tv_results: [{ id: 1399, name: 'Juego de tronos' }] };
    }
    return { results: [] };
  };
  globalThis.kino = { ...real, tmdb: fake };
  try {
    const ans = await plugin.migrate({ kind: 'title', ref: 'tt1399999' });
    assert.ok(ans, 'an IMDb id must be claimed');
    assert.equal(ans.kind, 'series', 'the TMDB answer decides the kind');
    assert.equal(ans.ref, 'n79:series:1399', 'the claimed ref must open in this plugin');
    assert.match(ans.id, /^[A-Za-z0-9._~-]{1,128}$/, 'the id must match the item id pattern');
  } finally {
    globalThis.kino = real;
  }
});

test('migrate claims own refs with their known kind and refuses foreign ones', async () => {
  const movie = await plugin.migrate({ kind: 'title', ref: 'cc:movie:batman-begins' });
  assert.ok(movie, 'an own movie ref must be claimed');
  assert.equal(movie.kind, 'movie');
  assert.equal(movie.ref, 'cc:movie:batman-begins', 'the ref is kept as is');
  assert.match(movie.id, /^[A-Za-z0-9._~-]{1,128}$/);

  const serie = await plugin.migrate({ kind: 'title', ref: 'n79:series:1399' });
  assert.ok(serie && serie.kind === 'series', 'an own series ref must be claimed as series');

  const foreign = await plugin.migrate({ kind: 'title', ref: 'str:tt1234567' });
  assert.equal(foreign, null, 'a ref that is not ours and not IMDb is not claimed');

  const live = await plugin.migrate({ kind: 'live', ref: 'pluto:canal' });
  assert.equal(live, null, 'live refs stay untouched');

  const chapter = await plugin.migrate({ kind: 'chapter', ref: 'cc:serie:algo', season: '3', episode: '7' });
  assert.ok(chapter, 'an own chapter ref must be claimed');
  assert.equal(chapter.kind, 'episode');
  assert.equal(chapter.ref, 'cc:serie:algo', 'the chapter ref is kept');
  assert.equal(chapter.season, 3);
  assert.equal(chapter.number, 7);
});

test('action clearCache empties the TMDB cache entries', async () => {
  kino.storage.set('tmdb:/movie/popular', JSON.stringify({ t: Date.now(), v: { results: [] } }));
  const ans = await plugin.action('clearCache');
  assert.ok(ans && typeof ans.message === 'string', 'the action answers a message');
  assert.ok(ans.message.length <= 300, 'the message is short');
  assert.equal(kino.storage.get('tmdb:/movie/popular'), null, 'the entry must be gone');
  const unknown = await plugin.action('nope');
  assert.equal(unknown, null, 'an unknown action answers null');
});

test('action testTmdb reports the TMDB state', async () => {
  const real = globalThis.kino;
  const fake = async (path) => path === '/configuration' ? { images: {} } : null;
  globalThis.kino = { ...real, tmdb: fake };
  try {
    const ans = await plugin.action('testTmdb');
    assert.ok(ans && ans.message.indexOf('TMDB responde bien') === 0, 'a working TMDB answers well: ' + (ans && ans.message));
  } finally {
    globalThis.kino = real;
  }
  const noKey = { ...real, tmdb: undefined };
  globalThis.kino = noKey;
  try {
    const ans = await plugin.action('testTmdb');
    assert.ok(ans && ans.message.indexOf('Falta') === 0, 'no key at all says so');
  } finally {
    globalThis.kino = real;
  }
});

test('validateSettings rejects a bad language code and a refused key', async () => {
  const badLang = await plugin.validateSettings({ tmdbLang: 'Español' });
  assert.ok(badLang && badLang.tmdbLang, 'a non-code language is rejected');
  const okLang = await plugin.validateSettings({ tmdbLang: 'es-MX' });
  assert.equal(okLang, null, 'a real code passes');
  const real = globalThis.kino;
  globalThis.kino = { ...real, fetch: async () => ({ ok: false, status: 401, headers: {}, json: async () => ({}) }) };
  try {
    const badKey = await plugin.validateSettings({ tmdbKey: 'mala' });
    assert.ok(badKey && badKey.tmdbKey, 'a refused key is rejected');
  } finally {
    globalThis.kino = real;
  }
});

test('panel draws status, transport, step and the series episodes', { skip: !hasFixtures }, async () => {
  const ctx = {
    kind: 'movie', ref: 'cc:movie:x', title: 'Película de prueba', ids: {},
    playing: { label: 'Servidor 1080p' }, positionMs: 60000, durationMs: 600000, paused: false,
    seekStepMs: 10000, stats: { width: 1280, height: 720, network: 'wifi' },
    device: 'tv', lang: 'es-CO', values: { video: {}, plugin: {} },
    player: { seekStepMs: 10000, speed: 1 }
  };
  const p = await plugin.panel(ctx);
  assert.ok(p && Array.isArray(p.elements), 'panel returns elements');
  assert.ok(p.title && p.title.length <= 60, 'title within limit');
  assert.equal(p.accent, '#FF6B00', 'the brand accent');
  assert.ok(p.refreshMs >= 2000 && p.refreshMs <= 60000, 'refreshMs within bounds');
  const status = p.elements.find((el) => el.type === 'status');
  assert.ok(status && status.text.includes('Servidor 1080p'), 'the status names the copy');
  const row = p.elements.find((el) => el.type === 'row');
  assert.ok(row && row.children.length === 3, 'the transport row has three buttons');
  const sel = p.elements.find((el) => el.type === 'select');
  assert.ok(sel && sel.key === 'step' && sel.options.length === 3, 'the step select is there');
  assert.ok(p.elements.some((el) => el.type === 'toggle' && el.key === 'autoNext'), 'auto-next toggle is there');
  assert.ok(p.elements.some((el) => el.type === 'select' && el.key === 'resize'), 'resize select is there');
  assert.equal(p.elements.filter((el) => !el.type || typeof el.type !== 'string').length, 0, 'every element has a type');

  // Una vez vistas las episodios de una serie, el panel de un episodio la lista.
  const eps = await plugin.episodes({ ref: 'jkanime:one-piece' });
  assert.ok(eps.episodes.length > 0, 'fixtures must provide episodes');
  const epCtx = { ...ctx, kind: 'episode', ref: eps.episodes[0].ref, title: 'One Piece' };
  const p2 = await plugin.panel(epCtx);
  const listEl = p2.elements.find((el) => el.type === 'episodes');
  assert.ok(listEl && listEl.ref === 'jkanime:one-piece', 'the panel links the series episodes');
});

test('panelAction seeks with the step, cycles the speed and applies the step select', async () => {
  const ctx = {
    kind: 'movie', ref: 'cc:movie:x', title: 'X', ids: {}, playing: {}, positionMs: 120000,
    paused: false, seekStepMs: 15000, stats: {}, device: 'tv', lang: 'es-CO',
    values: { video: {}, plugin: {} }, player: { seekStepMs: 15000, speed: 1 }
  };
  const back = await plugin.panelAction({ key: 'seekback', trigger: 'press', values: {} }, ctx);
  assert.equal(back.player.seekToMs, 105000, 'back subtracts the step in effect');
  const fwd = await plugin.panelAction({ key: 'seekfwd', trigger: 'press', values: {} }, ctx);
  assert.equal(fwd.player.seekToMs, 135000, 'forward adds the step in effect');
  const sp = await plugin.panelAction({ key: 'speed', trigger: 'press', values: {} }, ctx);
  assert.equal(sp.player.speed, 1.25, 'the speed cycles forward');
  const step = await plugin.panelAction({ key: 'step', trigger: 'change', values: {}, value: '30' }, ctx);
  assert.equal(step.player.seekStepMs, 30000, 'the select applies the step in ms');
  const next = await plugin.panelAction({ key: 'autoNext', trigger: 'change', values: {}, value: true }, ctx);
  assert.deepEqual(next.player.autoNext, { enabled: true, countdownS: 8 });
  const resize = await plugin.panelAction({ key: 'resize', trigger: 'change', values: {}, value: 'fill' }, ctx);
  assert.equal(resize.player.resize, 'fill');
  const junk = await plugin.panelAction({ key: 'speed', trigger: 'press', values: {} }, { ...ctx, positionMs: 0 });
  assert.equal(junk.player.seekToMs, undefined, 'unknown combinations answer nothing extra');
  const none = await plugin.panelAction({ key: 'otra', trigger: 'press', values: {} }, ctx);
  assert.equal(none, null, 'an unknown key answers null');
});

test('playerEvent answers null and just logs', async () => {
  const out = await plugin.playerEvent({ type: 'failed', kind: 'timeout' }, {});
  assert.equal(out, null, 'playerEvent is fire and forget');
});

test('details uses Kino metadata by TMDB id', async () => {
  const real = globalThis.kino;
  globalThis.kino = {
    ...real,
    meta: async (query) => ({ title: 'Matrix', overview: 'Resumen', poster: 'https://img.example/m.jpg', ids: query.ids, genres: ['Acción'], rating: 8.7, sources: ['tmdb'] })
  };
  try {
    const answer = await plugin.details('tmdb:movie:603:Matrix');
    assert.equal(answer.title, 'Matrix');
    assert.equal(answer.ids.tmdb, 603);
    assert.equal(answer.rating, 8.7);
  } finally { globalThis.kino = real; }
});

test('details uses byTitle when a source has no id', async () => {
  const real = globalThis.kino;
  const queries = [];
  const meta = async (query) => { queries.push(query); return { title: query.title, year: '1999', ids: { tmdb: 603 }, sources: ['tmdb'] }; };
  meta.byTitle = true;
  globalThis.kino = { ...real, meta };
  try {
    const answer = await plugin.details('cc:movie:matrix');
    assert.equal(answer.ids.tmdb, 603);
    assert.equal(queries[0].title, 'Matrix');
  } finally { globalThis.kino = real; }
});

test('home and section do not fan out metadata calls for every card', async () => {
  const real = globalThis.kino;
  let metaCalls = 0;
  globalThis.kino = { ...real, meta: async () => { metaCalls++; return null; } };
  try {
    await plugin.home();
    await plugin.section('series');
    assert.equal(metaCalls, 0, 'metadata is loaded on title details, not catalog rows');
  } finally { globalThis.kino = real; }
});

test('TMDB episodes use Kino meta episodes before Net79', async () => {
  const real = globalThis.kino;
  const calls = [];
  globalThis.kino = {
    ...real,
    meta: async () => ({ title: 'Serie meta', ids: { tmdb: 1399 }, episodes: [{ season: 1, number: 1, title: 'Inicio' }], sources: ['tmdb'] }),
    fetch: async (url) => { calls.push(url); return { ok: false, status: 404, url, text: () => '' }; }
  };
  try {
    const result = await plugin.episodes({ ref: 'tmdb:series:1399:Serie' });
    assert.equal(result.episodes.length, 1);
    assert.equal(result.episodes[0].ref, 'n79:serie:1399:1:1');
    assert.ok(!calls.some((url) => url.includes('net79.cc')), 'Net79 is not needed when Kino has episodes');
  } finally { globalThis.kino = real; }
});

test('safe HLS resolve results are cached within the runtime', async () => {
  const real = globalThis.kino;
  let calls = 0;
  const countIf = (url) => {
    if (url.includes('cinehdplus.org')) calls++;
  };
  globalThis.kino = {
    ...real,
    fetch: async (url) => {
      countIf(url);
      if (url === 'https://cinehdplus.org/pelicula/batman/') {
        return { ok: true, status: 200, url, text: () => '<iframe src="//api.cinehdplus.org/ir/player.php?h=abc"></iframe>' };
      }
      if (url.includes('player.php')) {
        return { ok: true, status: 200, url, text: () => '<script>window.location.replace("goto.php?h=token123");</script>' };
      }
      if (url.includes('goto.php')) {
        return { ok: true, status: 200, url, text: () => '<script>location.replace("https://api.cinehdplus.org/ir/rd.php?id=xyz");</script>' };
      }
      if (url.includes('rd.php')) {
        return { ok: true, status: 200, url, text: () => '<iframe src="https://cdn.example/hls.m3u8"></iframe>' };
      }
      return { ok: false, status: 404, url, text: () => '' };
    }
  };
  try {
    const ref = 'chp:movie:https://cinehdplus.org/pelicula/batman/';
    await plugin.resolve({ ref });
    const first = calls;
    assert.ok(first > 0, 'the first resolve fetched the source');
    await plugin.resolve({ ref });
    assert.equal(calls, first, 'second resolve reuses the safe HLS stream cache');
  } finally {
    globalThis.kino = real;
  }
});


test('Kino metadata series episodes produce directly resolvable Net79 refs', async () => {
  const real = globalThis.kino;
  globalThis.kino = {
    ...real,
    meta: async () => ({ title: 'Serie', ids: { tmdb: 1399 }, episodes: [{ season: 2, number: 3, title: 'Capítulo' }], sources: ['tmdb'] })
  };
  try {
    const episodes = await plugin.episodes({ ref: 'tmdb:series:1399:Serie' });
    assert.equal(episodes.episodes[0].ref, 'n79:serie:1399:2:3');
  } finally { globalThis.kino = real; }
});

/* ---------- 6.0.2 fixes: Cuevana domain, SoloLatino storage CSRF, CineHDPlus redirects ---------- */

test('sololatino persists csrf state in storage across runs', async () => {
  const real = globalThis.kino;
  let csrfFetches = 0;
  globalThis.kino = {
    ...real,
    fetch: async (url) => {
      if (url.includes('csrf-cookie')) {
        csrfFetches++;
        return { ok: true, status: 200, url, text: () => '' };
      }
      return { ok: true, status: 200, url, text: () => '<button class="btn-play" data-opt="t1">1</button>' };
    }
  };
  try {
    kino.storage.remove('sl_csrf_ok');
    delete globalThis._slCsrfTs;
    await plugin.resolve({ ref: 'sl:pelicula:test-peli' }).catch(() => null);
    assert.equal(csrfFetches, 1, 'first resolve calls csrf-cookie');
    assert.equal(kino.storage.get('sl_csrf_ok'), '1', 'storage holds csrf state');

    // Simulate new runtime: globalThis variable lost, but storage preserved
    delete globalThis._slCsrfTs;
    await plugin.resolve({ ref: 'sl:pelicula:test-peli' }).catch(() => null);
    assert.equal(csrfFetches, 1, 'second resolve reuses storage without extra csrf fetch');
  } finally {
    globalThis.kino = real;
  }
});

test('cinehdplus handles window.location.replace redirects', async () => {
  const real = globalThis.kino;
  const urls = [];
  globalThis.kino = {
    ...real,
    fetch: async (url) => {
      urls.push(url);
      if (url === 'https://cinehdplus.org/pelicula/batman/') {
        return { ok: true, status: 200, url, text: () => '<iframe src="//api.cinehdplus.org/ir/player.php?h=abc"></iframe>' };
      }
      if (url.includes('player.php')) {
        return { ok: true, status: 200, url, text: () => '<script>window.location.replace("goto.php?h=token123");</script>' };
      }
      if (url.includes('goto.php')) {
        return { ok: true, status: 200, url, text: () => '<script>location.replace("https://api.cinehdplus.org/ir/rd.php?id=xyz");</script>' };
      }
      if (url.includes('rd.php')) {
        return { ok: true, status: 200, url, text: () => '<iframe src="https://cdn.example/hls.m3u8"></iframe>' };
      }
      return { ok: false, status: 404, url, text: () => '' };
    }
  };
  try {
    const st = await plugin.resolve({ ref: 'chp:movie:https://cinehdplus.org/pelicula/batman/' });
    assert.ok(st && st.url.includes('hls.m3u8'), 'cinehdplus follows location.replace chain to the stream');
  } finally {
    globalThis.kino = real;
  }
});

test('merged ref resolves fast with early exit and lazy alternatives', async () => {
  const real = globalThis.kino;
  const queried = [];
  globalThis.kino = {
    ...real,
    fetch: async (url) => {
      queried.push(url);
      if (url.includes('entrepeliculasyseries.nz/pelicula/peli-rapida')) {
        return { ok: true, status: 200, url, text: () => 'src="https://fastcdn.example/play.m3u8"' };
      }
      return { ok: false, status: 404, url, text: () => '' };
    }
  };
  try {
    const mgRef = 'mg:' + encodeURIComponent(JSON.stringify([
      'ent:/pelicula/peli-rapida/',
      'av1:peli-rapida',
      'afv:peli-rapida:1:https://fake.example/ep',
      'vpo:movie:peli-rapida'
    ]));
    const t0 = Date.now();
    const st = await plugin.resolve({ ref: mgRef });
    const elapsed = Date.now() - t0;
    assert.ok(st && st.url.includes('fastcdn.example'), 'first available source stream is returned');
    assert.ok(elapsed < 4000, 'resolve must exit early, took ' + elapsed + 'ms');
    assert.ok(Array.isArray(st.alternatives), 'alternatives are provided');
    assert.ok(st.alternatives.some((a) => a.ref && a.ref.startsWith('afv:')), 'untried sources become lazy alternatives');
    assert.ok(st.alternatives.some((a) => a.ref && a.ref.startsWith('vpo:')), 'untried sources become lazy alternatives');
    assert.ok(queried.some((u) => u.includes('entrepeliculasyseries.nz')), 'the merged ref asks the first source');
  } finally {
    globalThis.kino = real;
  }
});


test('live sources expose native TDT playlist and cached IPTV categories', async () => {
  assert.ok(manifest.capabilities.includes('channels'), 'channels capability');
  assert.equal(manifest.liveStreamHosts, 'any');
  const real = globalThis.kino;
  const catalog = [{ id: 'mx', title: 'México', items: [{ id: 'uno', title: 'Canal Uno', kind: 'live', logo: 'https://example.com/tvplus-logo.png', ref: 'https://live.example/uno.m3u8' }] }];
  globalThis.kino = {
    ...real,
    fetch: async (url) => ({
      ok: true,
      status: 200,
      url,
      text: () => JSON.stringify(catalog)
    })
  };
  try {
    const categories = await plugin.liveCategories();
    assert.ok(categories.some((entry) => entry.id === 'iptv-mx'));
    assert.ok(!categories.some((entry) => entry.playlist), 'native playlists must not leak external logos');
    const page = await plugin.liveChannels({ categoryId: 'iptv-mx', cursor: null });
    assert.equal(page.items[0].title, 'Canal Uno');
    assert.equal(page.items[0].categoryId, 'iptv-mx');
    assert.equal(page.items[0].logo, undefined, 'external plugin logos must not leak into YojaTV');
    const hits = await plugin.liveSearch({ query: 'uno' });
    assert.equal(hits.items[0].title, 'Canal Uno');
  } finally {
    globalThis.kino = real;
  }
});

test('TMDB series episodes use the stable Net79 id before title fallback', async () => {
  const real = globalThis.kino;
  const calls = [];
  globalThis.kino = {
    ...real,
    fetch: async (url) => {
      calls.push(url);
      if (url.includes('/api/catalog/detail?tmdbId=1399&type=tv')) {
        return {
          ok: true,
          status: 200,
          url,
          text: () => JSON.stringify({ seasons: [{ season: 1, episodes: [{ episode: 1, title: 'Pilot' }] }] })
        };
      }
      return { ok: false, status: 404, url, text: () => '' };
    }
  };
  try {
    const result = await plugin.episodes({ ref: 'tmdb:series:1399:' + encodeURIComponent('Juego de tronos') });
    assert.equal(result.episodes.length, 1);
    assert.equal(result.episodes[0].ref, 'n79:serie:1399:1:1');
    assert.ok(calls.some((url) => url.includes('tmdbId=1399&type=tv')));
    assert.ok(!calls.some((url) => url.includes('/api/catalog/search?q=')), 'title fan-out is not needed');
  } finally {
    globalThis.kino = real;
  }
});
