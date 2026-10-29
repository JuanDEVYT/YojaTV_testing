import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamCache, looksVolatile, ttlMsFor } from '../lib/cache.js';

test('TTL: enlaces con token viven menos que los directos', () => {
  assert.equal(ttlMsFor('https://cdn.example.com/video.m3u8?token=abc'), 10 * 60 * 1000);
  assert.equal(ttlMsFor('https://vimeos.example.com/file.mp4'), 5 * 60 * 1000);
  assert.equal(ttlMsFor('https://cdn.example.com/movie.mp4'), 45 * 60 * 1000);
  assert.equal(ttlMsFor('https://cdn.example.com/live/index.m3u8'), 30 * 60 * 1000);
  assert.ok(ttlMsFor('https://x.example.com/a.mp4') <= 6 * 60 * 60 * 1000);
  assert.ok(looksVolatile('https://cdn.example.com/v.mp4?expires=123'));
  assert.ok(!looksVolatile('https://cdn.example.com/v.mp4'));
});

test('la caché devuelve la entrada mientras no venza y la borra al vencer', () => {
  let now = 1_000_000;
  const cache = new StreamCache({ now: () => now });
  assert.equal(cache.set('fuente:1', { url: 'https://cdn.example.com/a.mp4' }, { quality: '1080p' }), true);

  const hit = cache.get('fuente:1');
  assert.ok(hit, 'debe haber caché');
  assert.equal(hit.quality, '1080p');
  assert.equal(hit.url, 'https://cdn.example.com/a.mp4');

  now += 46 * 60 * 1000; // pasado el TTL
  assert.equal(cache.get('fuente:1'), null, 'entrada vencida');
  assert.equal(cache.stats().entries, 0);
});

test('evictUrl borra cualquier ref que use ese enlace', () => {
  const cache = new StreamCache();
  cache.set('a:1', { url: 'https://cdn.example.com/uno.mp4' });
  cache.set('b:2', { url: 'https://cdn.example.com/uno.mp4' });
  cache.set('c:3', { url: 'https://cdn.example.com/dos.mp4' });
  assert.equal(cache.evictUrl('https://cdn.example.com/uno.mp4'), 2);
  assert.equal(cache.map.size, 1);
  assert.ok(cache.peek('c:3'));
});

test('evictRef borra el ref y sus variantes con dos puntos', () => {
  const cache = new StreamCache();
  cache.set('jkanime:serie:1', { url: 'https://a.example/1.mp4' });
  cache.set('jkanime:serie:2', { url: 'https://a.example/2.mp4' });
  cache.set('otra:1', { url: 'https://a.example/3.mp4' });
  assert.equal(cache.evictRef('jkanime:serie:1'), 1);
  assert.equal(cache.map.size, 2);
});

test('el tope LRU descarta las entradas más viejas', () => {
  const cache = new StreamCache({ maxEntries: 3 });
  for (let i = 0; i < 6; i++) cache.set(`s:${i}`, { url: `https://cdn.example.com/${i}.mp4` });
  assert.equal(cache.map.size, 3);
  assert.equal(cache.peek('s:0'), null);
  assert.ok(cache.peek('s:5'));
});
