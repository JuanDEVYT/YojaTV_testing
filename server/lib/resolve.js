// Núcleo del servidor: recibe los refs candidatos de un título, los intenta en el orden en que
// responde cada fuente, guarda lo bueno en caché y devuelve la lista ordenada para que en Kino
// se pueda elegir ("1080p: FuegoCine"). Si el plugin reporta un enlace vencido, se borra aquí y
// el siguiente intento trae otro funcional.
import { StreamCache, looksVolatile } from './cache.js';
import { SourceStats, srcIdOfRef } from './sources.js';
import { verifyStream } from './probe.js';
import { qualityOf, qualityRank, labelFor } from './quality.js';

const REF_MAX = 512;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const clamp = (v, min, max, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
};

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  // si gana el tiempo, el trabajo original sigue en segundo plano pero no rompe nada
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function eagerAlts(raw) {
  const list = Array.isArray(raw && raw.alternatives) ? raw.alternatives : [];
  const out = [];
  for (const a of list) {
    if (a && typeof a === 'object' && typeof a.url === 'string' && a.url && out.length < 8) {
      out.push({ label: a.label || null, url: a.url, headers: a.headers || null, mime: a.mime || null });
    }
  }
  return out;
}

export function createResolver({
  runtime,
  cache = new StreamCache(),
  stats = new SourceStats(),
  config = {},
  verify = verifyStream,
  logger = null,
}) {
  const cfg = {
    perRefTimeoutMs: 9000,
    requestTimeoutMs: 14000,
    maxParallel: 4,
    maxNewPerRequest: 4,
    maxStreams: 8,
    probeAfterMs: 45 * 1000,
    probeTimeoutMs: 2500,
    ...config,
  };
  const inflight = new Map();
  const log = (msg, data) => { if (logger) logger.debug(msg, data); };

  /** Refs válidos, sin repetir, a partir de { ref, refs } (acepta un "mg:" como los agrupa el plugin). */
  function normalizeRefs(body) {
    const out = [];
    const push = (r) => {
      if (typeof r !== 'string') return;
      const s = r.trim();
      if (!s || s.length > REF_MAX || CONTROL_RE.test(s)) return;
      if (!out.includes(s)) out.push(s);
    };
    if (Array.isArray(body.refs)) for (const r of body.refs.slice(0, 40)) push(r);
    const single = typeof body.ref === 'string' ? body.ref : null;
    if (single) {
      if (single.startsWith('mg:')) {
        try {
          const arr = JSON.parse(decodeURIComponent(single.slice(3)));
          if (Array.isArray(arr)) for (const r of arr) push(r);
        } catch { /* ref fusionado malformado */ }
      } else push(single);
    }
    return out.slice(0, 16);
  }

  /** Un resolve, con su propia medición y su cortacircuitos; si hay dos a la vez, comparten. */
  function resolveOne(ref) {
    const existing = inflight.get(ref);
    if (existing) return existing;
    const srcId = srcIdOfRef(ref);
    const p = (async () => {
      const t0 = Date.now();
      if (stats.isOpen(srcId)) return { ref, ok: false, reason: 'fuente_en_pausa', ms: 0 };
      runtime.resetBudget();
      let raw = null;
      try {
        raw = await withTimeout(Promise.resolve().then(() => runtime.plugin.resolve({ ref })), cfg.perRefTimeoutMs);
      } catch (e) {
        const ms = Date.now() - t0;
        stats.observe(srcId, ms, false);
        log('resolve falló', { ref, ms, reason: e && e.message });
        return { ref, ok: false, reason: e && e.message === 'timeout' ? 'sin_tiempo' : 'error', ms };
      }
      const ms = Date.now() - t0;
      if (!raw || !raw.url) {
        stats.observe(srcId, ms, false);
        return { ref, ok: false, reason: 'sin_stream', ms };
      }
      stats.observe(srcId, ms, true);
      const stream = {
        url: raw.url,
        headers: raw.headers || null,
        mime: raw.mime || null,
        label: raw.label || null,
        subtitles: raw.subtitles || null,
        alts: eagerAlts(raw),
      };
      cache.set(ref, stream, { quality: qualityOf(stream), label: stream.label });
      log('resolve ok', { ref, ms });
      // se devuelve la entrada guardada: trae calidad, vencimiento y las copias ya resueltas
      return { ref, ok: true, ms, stream: cache.peek(ref) || stream };
    })().finally(() => inflight.delete(ref));
    inflight.set(ref, p);
    return p;
  }

  function toStream(ref, entry, { cached, ms }) {
    const srcId = entry.srcId || srcIdOfRef(ref) || '';
    const quality = entry.quality || qualityOf(entry);
    const expiresAt = entry.expiresAt || 0;
    const expiresInSeconds = expiresAt
      ? Math.max(30, Math.min(86400, Math.round((expiresAt - Date.now()) / 1000)))
      : null;
    const out = {
      label: labelFor(quality, entry.label ? labelName(entry, quality) : null) || entry.label || srcId,
      url: entry.url,
      quality: quality || null,
      srcId: srcId || null,
      ref: ref || null,
      ms: Number.isFinite(ms) ? ms : 0,
      cached: !!cached,
    };
    if (entry.headers) out.headers = entry.headers;
    if (entry.mime) out.mime = entry.mime;
    if (entry.subtitles) out.subtitles = entry.subtitles;
    if (expiresInSeconds) out.expiresInSeconds = expiresInSeconds;
    return out;
  }

  /** El rótulo del plugin ya suele venir como "1080p: FuegoCine"; si no, se arma con la fuente. */
  function labelName(entry, quality) {
    const l = String(entry.label || '');
    if (!l) return entry.srcId || '';
    if (quality && l.startsWith(quality)) return l.slice(quality.length).replace(/^:\s*/, '');
    if (l.includes(':')) return l.slice(l.indexOf(':') + 1).trim();
    return l;
  }

  async function resolveRequest(body) {
    const started = Date.now();
    const refs = normalizeRefs(body || {});
    if (!refs.length) return { ok: false, error: 'ref_invalido' };

    const budgetMs = clamp(body.timeoutMs, 2000, 30000, cfg.requestTimeoutMs);
    const maxStreams = clamp(body.maxStreams, 1, 8, cfg.maxStreams);

    // 1. orden por velocidad de respuesta de cada fuente
    const ranked = stats.rankRefs(refs);

    // 2. qué ya está en caché y qué enlaces viejos conviene comprobar
    const hits = [];
    const misses = [];
    for (const r of ranked) {
      const e = cache.get(r);
      if (e) hits.push({ ref: r, entry: e });
      else misses.push(r);
    }
    const suspect = hits.filter(
      (h) => looksVolatile(h.entry.url) && started - h.entry.at > cfg.probeAfterMs,
    );
    const suspectRefs = new Set(suspect.map((s) => s.ref));

    // 3. cuánto resolver de nuevo: menos cuanto más haya ya cacheado
    const wantNew = Math.max(0, Math.min(cfg.maxNewPerRequest, 4 - Math.min(hits.length, 3)));
    const todo = misses.filter((r) => !suspectRefs.has(r)).slice(0, wantNew);

    // 4. en paralelo: comprobar los sospechosos y resolver los que faltan
    const probeP = Promise.all(
      suspect.map(async (h) => ({ ref: h.ref, entry: h.entry, state: await verify(h.entry, cfg.probeTimeoutMs) })),
    );
    const resolveP = Promise.all(todo.map((r) => resolveOne(r)));
    const [probeResults, resolved] = await Promise.all([probeP, resolveP]);

    const results = [...resolved];
    const deadRefs = [];
    for (const p of probeResults) {
      if (p.state === 'dead') {
        cache.evictUrl(p.entry.url);
        deadRefs.push(p.ref);
        log('enlace vencido detectado', { ref: p.ref });
      } else {
        results.push({ ref: p.ref, ok: true, ms: 0, stream: p.entry, fromCache: true });
      }
    }

    // 5. segunda oleada: solo lo que se intentó y no dio (o lo que se cayó al comprobarlo),
    // y solo si aún cabe en el tiempo del pedido. Lo que no se intentó se queda para después.
    const attempted = new Set([...todo, ...deadRefs]);
    const failedRefs = new Set([
      ...deadRefs,
      ...[...attempted].filter((r) => !results.some((x) => x.ref === r && x.ok)),
    ]);
    const elapsed = Date.now() - started;
    if (failedRefs.size && elapsed < budgetMs * 0.6) {
      const extra = stats.rankRefs([...failedRefs]).slice(0, 2);
      const more = await Promise.all(
        extra.map((r) =>
          withTimeout(resolveOne(r), Math.max(500, budgetMs - (Date.now() - started))).catch(() => null),
        ),
      );
      for (const m of more) if (m) results.push(m);
    }

    // 6. armar la lista: calidad primero, luego la fuente que responde más rápido
    const streams = [];
    const seen = new Set();
    const add = (ref, entry, meta) => {
      if (!entry || !entry.url || seen.has(entry.url)) return;
      seen.add(entry.url);
      streams.push(toStream(ref, entry, meta));
    };
    for (const h of hits) {
      if (deadRefs.includes(h.ref)) continue;
      const live = results.find((x) => x.ref === h.ref && x.ok);
      if (live && !live.fromCache) add(h.ref, live.stream, { cached: false, ms: live.ms });
      else add(h.ref, h.entry, { cached: true, ms: 0 });
    }
    for (const r of results) {
      if (r.ok && !r.fromCache) add(r.ref, r.stream, { cached: false, ms: r.ms });
      else if (r.ok && r.fromCache && !hits.some((h) => h.ref === r.ref)) add(r.ref, r.stream, { cached: true, ms: 0 });
    }
    // las copias que el propio resolve ya trae resueltas, como más opciones
    for (const s of [...streams]) {
      const entry = s.ref ? cache.peek(s.ref) : null;
      for (const alt of (entry && entry.alts) || []) {
        if (streams.length >= maxStreams * 2) break;
        if (!alt.url || seen.has(alt.url)) continue;
        seen.add(alt.url);
        const quality = qualityOf({ url: alt.url, label: alt.label });
        streams.push({
          label: labelFor(quality, alt.label || s.srcId) || alt.label || s.srcId,
          url: alt.url,
          quality: quality || null,
          srcId: s.srcId,
          ref: null,
          ms: s.ms,
          cached: s.cached,
          ...(alt.headers ? { headers: alt.headers } : {}),
          ...(alt.mime ? { mime: alt.mime } : {}),
        });
      }
    }

    streams.sort((a, b) => {
      const q = qualityRank(b.quality) - qualityRank(a.quality);
      if (q) return q;
      const sa = stats.score(a.srcId);
      const sb = stats.score(b.srcId);
      if (sa !== sb) return sa - sb;
      return a.ms - b.ms;
    });
    const finalStreams = streams.slice(0, maxStreams);

    const unresolved = refs
      .filter((r) => !finalStreams.some((s) => s.ref === r))
      .map((r) => {
        const failed = results.find((x) => x.ref === r && !x.ok);
        return { ref: r, reason: failed ? failed.reason : deadRefs.includes(r) ? 'enlace_vencido' : 'sin_intentarlo' };
      });

    const payload = {
      ok: finalStreams.length > 0,
      ...(finalStreams.length ? {} : { error: 'sin_streams' }),
      tookMs: Date.now() - started,
      cache: { hits: hits.length, misses: misses.length },
      streams: finalStreams,
      unresolved,
    };
    log('resolve pedido', {
      refs: refs.length,
      streams: finalStreams.length,
      tookMs: payload.tookMs,
      cache: payload.cache,
    });
    return payload;
  }

  /** El plugin avisa que un enlace ya no sirve: se borra y, si se pide, se resuelve otra vez. */
  function report(body) {
    const ref = typeof body.ref === 'string' ? body.ref : null;
    const url = typeof body.url === 'string' ? body.url : null;
    let evicted = 0;
    if (url) evicted += cache.evictUrl(url);
    if (ref) evicted += cache.evictRef(ref);
    const srcId = srcIdOfRef(ref);
    if (srcId) stats.observe(srcId, 0, false);
    logger && logger.info('reporte', { ref, url: url ? url.slice(0, 120) : undefined, reason: body.reason, evicted });
    return { ok: true, evicted };
  }

  /** El plugin resolvió en el dispositivo (el servidor no pudo): lo guardamos para la próxima. */
  function seed(body) {
    const ref = typeof body.ref === 'string' ? body.ref.trim() : '';
    const stream = body && body.stream;
    if (!ref || ref.length > REF_MAX || !stream || typeof stream.url !== 'string' || !/^https?:\/\//i.test(stream.url)) {
      return { ok: false, error: 'seed_invalido' };
    }
    const quality = qualityOf({ url: stream.url, label: stream.label });
    const saved = cache.set(ref, {
      url: stream.url,
      headers: stream.headers || null,
      mime: stream.mime || null,
      label: stream.label || null,
      subtitles: stream.subtitles || null,
      alts: [],
    }, { quality });
    return { ok: saved, ttlMs: saved ? ttlOf(ref) : 0 };
  }

  function ttlOf(ref) {
    const e = cache.peek(ref);
    return e ? e.ttlMs : 0;
  }

  return {
    resolveRequest,
    report,
    seed,
    cache,
    stats,
    inflight: () => inflight.size,
    config: cfg,
  };
}
