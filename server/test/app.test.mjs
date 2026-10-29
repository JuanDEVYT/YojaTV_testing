import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHandler, makeLimiter } from '../lib/app.js';
import { createResolver } from '../lib/resolve.js';

function fakeRuntime() {
  const calls = [];
  return {
    calls,
    resetBudget() {},
    labels: {},
    plugin: {
      async resolve({ ref }) {
        calls.push(ref);
        return { url: `https://cdn.test/${encodeURIComponent(ref)}.mp4`, label: '1080p: FuegoCine' };
      },
    },
  };
}

async function withServer(t, { resolver, limiter } = {}) {
  const runtime = resolver ? null : fakeRuntime();
  const res = resolver || createResolver({ runtime });
  const server = createServer(createHandler({ resolver: res, limiter }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  t.after(() => new Promise((r) => server.close(r)));
  return { base: `http://127.0.0.1:${port}`, resolver: res, runtime };
}

test('GET /health responde salud', async (t) => {
  const { base } = await withServer(t);
  const r = await fetch(base + '/health');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, 'YojaTV-server');
});

test('GET / trae el estado del servidor', async (t) => {
  const { base } = await withServer(t);
  const body = await (await fetch(base + '/')).json();
  assert.equal(body.ok, true);
  assert.ok(body.cache && typeof body.cache.entries === 'number');
  assert.ok(body.rutas.includes('POST /resolve'));
});

test('POST /resolve devuelve la lista con su calidad', async (t) => {
  const { base, runtime } = await withServer(t);
  const r = await fetch(base + '/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refs: ['fuegocine:movie:x', 'jkanime:serie:y'] }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.streams.length, 2);
  assert.equal(body.streams[0].label, '1080p: FuegoCine');
  assert.ok(body.streams[0].url.startsWith('https://'));
  assert.equal(runtime.calls.length, 2);
});

test('POST /resolve sin ref devuelve 400', async (t) => {
  const { base } = await withServer(t);
  const r = await fetch(base + '/resolve', { method: 'POST', body: '{}' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'ref_invalido');
});

test('POST /report borra y POST /seed guarda', async (t) => {
  const { base, runtime } = await withServer(t);
  await fetch(base + '/resolve', { method: 'POST', body: JSON.stringify({ refs: ['a:1'] }) });

  const rep = await (await fetch(base + '/report', {
    method: 'POST',
    body: JSON.stringify({ ref: 'a:1', url: runtime.calls.length ? undefined : undefined, reason: 'expired' }),
  })).json();
  assert.equal(rep.ok, true);

  const seed = await (await fetch(base + '/seed', {
    method: 'POST',
    body: JSON.stringify({ ref: 'b:1', stream: { url: 'https://cdn.test/seeded.mp4', label: '720p: Semilla' } }),
  })).json();
  assert.equal(seed.ok, true);

  const out = await (await fetch(base + '/resolve', { method: 'POST', body: JSON.stringify({ refs: ['b:1'] }) })).json();
  assert.equal(out.streams[0].cached, true, 'la semilla se sirve de caché');
  assert.equal(out.streams[0].label, '720p: Semilla');
});

test('GET /sources lista el ranking de fuentes', async (t) => {
  const { base } = await withServer(t);
  await fetch(base + '/resolve', { method: 'POST', body: JSON.stringify({ refs: ['a:1'] }) });
  const body = await (await fetch(base + '/sources')).json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.sources));
  assert.equal(body.sources[0].id, 'a');
  assert.ok(body.sources[0].samples >= 1);
});

test('ruta desconocida -> 404 y método desconocido -> 405', async (t) => {
  const { base } = await withServer(t);
  assert.equal((await fetch(base + '/nada')).status, 404);
  assert.equal((await fetch(base + '/resolve', { method: 'DELETE' })).status, 405);
});

test('OPTIONS responde con CORS para navegadores', async (t) => {
  const { base } = await withServer(t);
  const r = await fetch(base + '/resolve', { method: 'OPTIONS' });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
});

test('la cuota por IP devuelve 429 cuando se pasa', async (t) => {
  const { base } = await withServer(t, { limiter: makeLimiter({ capacity: 2 }) });
  const a = await fetch(base + '/health');
  const b = await fetch(base + '/health');
  const c = await fetch(base + '/health');
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(c.status, 429);
});
