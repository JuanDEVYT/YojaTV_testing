import test from 'node:test';
import assert from 'node:assert/strict';
import { createResolver } from '../lib/resolve.js';

/** Runtime falso: mismo contrato que lib/runtime.js, sin red ni plugin real. */
function fakeRuntime(handler, { calls = [] } = {}) {
  return {
    calls,
    resetBudget() {},
    labels: {},
    plugin: {
      async resolve({ ref }) {
        calls.push(ref);
        return handler(ref);
      },
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('devuelve la lista: la calidad manda y a igual calidad gana la fuente más rápida', async () => {
  const runtime = fakeRuntime(async (ref) => {
    if (ref === 'alpha:1') { await sleep(60); return { url: 'https://cdn.test/a_720.mp4', label: '720p: Alpha' }; }
    if (ref === 'beta:1') { await sleep(250); return { url: 'https://cdn.test/b_1080.mp4', label: '1080p: Beta' }; }
    await sleep(400);
    return { url: 'https://cdn.test/c_720.mp4', label: '720p: Gamma' };
  });
  const resolver = createResolver({ runtime });

  const out = await resolver.resolveRequest({ refs: ['alpha:1', 'beta:1', 'gamma:1'] });
  assert.equal(out.ok, true);
  assert.equal(out.streams.length, 3);
  assert.equal(out.streams[0].label, '1080p: Beta', '1080p va primero');
  assert.equal(out.streams[1].label, '720p: Alpha', 'a igual calidad, la más rápida');
  assert.equal(out.streams[2].label, '720p: Gamma');
  assert.equal(out.unresolved.length, 0);
  assert.ok(out.streams[0].expiresInSeconds >= 30 && out.streams[0].expiresInSeconds <= 86400);
});

test('el segundo pedido sale de caché sin volver a resolver', async () => {
  const runtime = fakeRuntime(async () => ({ url: 'https://cdn.test/movie_1080.mp4', label: '1080p: Solo' }));
  const resolver = createResolver({ runtime });

  const first = await resolver.resolveRequest({ refs: ['solo:1'] });
  const second = await resolver.resolveRequest({ refs: ['solo:1'] });
  assert.equal(runtime.calls.length, 1, 'solo una resolución real');
  assert.equal(first.streams[0].cached, false);
  assert.equal(second.streams[0].cached, true);
  assert.equal(second.cache.hits, 1);
});

test('/report borra el enlace vencido y el siguiente pedido lo resuelve otra vez', async () => {
  let n = 0;
  const runtime = fakeRuntime(async () => ({ url: `https://cdn.test/v${++n}.mp4`, label: '720p: Fuente' }));
  const resolver = createResolver({ runtime });

  const a = await resolver.resolveRequest({ refs: ['f:1'] });
  assert.equal(a.streams[0].url, 'https://cdn.test/v1.mp4');

  const rep = resolver.report({ ref: 'f:1', url: 'https://cdn.test/v1.mp4', reason: 'expired' });
  assert.equal(rep.ok, true);
  assert.equal(rep.evicted, 1);

  const b = await resolver.resolveRequest({ refs: ['f:1'] });
  assert.equal(runtime.calls.length, 2, 'resolvió de nuevo');
  assert.equal(b.streams[0].url, 'https://cdn.test/v2.mp4');
});

test('/seed guarda lo que resolvió el dispositivo', async () => {
  const runtime = fakeRuntime(async () => { throw new Error('no debería resolverse'); });
  const resolver = createResolver({ runtime });

  const seed = resolver.seed({
    ref: 'local:1',
    stream: { url: 'https://cdn.test/local_720.mp4', label: '720p: Local', headers: { Referer: 'https://x.test/' } },
  });
  assert.equal(seed.ok, true);
  assert.ok(seed.ttlMs > 0);

  const out = await resolver.resolveRequest({ refs: ['local:1'] });
  assert.equal(out.ok, true);
  assert.equal(out.streams[0].cached, true);
  assert.equal(out.streams[0].label, '720p: Local');
  assert.equal(runtime.calls.length, 0, 'no hizo falta resolver');
});

test('un ref fusionado (mg:) se abre en sus refs candidatos', async () => {
  const runtime = fakeRuntime(async (ref) => ({ url: `https://cdn.test/${ref.length}.mp4`, label: '1080p: ' + ref }));
  const resolver = createResolver({ runtime });
  const mg = 'mg:' + encodeURIComponent(JSON.stringify(['uno:1', 'dos:2']));
  const out = await resolver.resolveRequest({ ref: mg });
  assert.equal(out.ok, true);
  assert.deepEqual(runtime.calls.sort(), ['dos:2', 'uno:1']);
});

test('una fuente que no da stream queda en unresolved y no rompe el pedido', async () => {
  const runtime = fakeRuntime(async (ref) => {
    if (ref.startsWith('mala')) return null;
    return { url: 'https://cdn.test/ok.mp4', label: '1080p: Buena' };
  });
  const resolver = createResolver({ runtime });
  const out = await resolver.resolveRequest({ refs: ['mala:1', 'buena:1'] });
  assert.equal(out.ok, true);
  assert.equal(out.streams.length, 1);
  assert.equal(out.unresolved.length, 1);
  assert.equal(out.unresolved[0].ref, 'mala:1');
});

test('la fuente que falla tres veces seguidas se aparta', async () => {
  const runtime = fakeRuntime(async (ref) => {
    if (ref.startsWith('mala')) return null;
    return { url: 'https://cdn.test/buena.mp4', label: '1080p: Buena' };
  });
  const resolver = createResolver({ runtime });
  for (let i = 0; i < 3; i++) await resolver.resolveRequest({ refs: ['mala:1'] });
  assert.equal(resolver.stats.isOpen('mala'), true);

  const out = await resolver.resolveRequest({ refs: ['mala:1'] });
  assert.equal(out.ok, false);
  assert.equal(out.unresolved[0].reason, 'fuente_en_pausa');
  assert.equal(runtime.calls.length, 3, 'no volvió a intentar la fuente en cuarentena');
});

test('una fuente que se queda colgada no cuelga el pedido', async () => {
  const runtime = fakeRuntime((ref) => {
    if (ref.startsWith('colgada')) return new Promise(() => {}); // nunca contesta
    return Promise.resolve({ url: 'https://cdn.test/ok.mp4', label: '720p: Rápida' });
  });
  const resolver = createResolver({ runtime, config: { perRefTimeoutMs: 200, requestTimeoutMs: 2000 } });
  const out = await resolver.resolveRequest({ refs: ['colgada:1', 'rapida:1'], timeoutMs: 2000 });
  assert.equal(out.ok, true, 'la fuente que sí contestó salva el pedido');
  assert.equal(out.streams[0].label, '720p: Rápida');
  assert.ok(out.unresolved.some((u) => u.ref === 'colgada:1' && u.reason === 'sin_tiempo'));
});

test('un pedido sin refs es inválido', async () => {
  const resolver = createResolver({ runtime: fakeRuntime(async () => null) });
  const out = await resolver.resolveRequest({});
  assert.equal(out.ok, false);
  assert.equal(out.error, 'ref_invalido');
});
