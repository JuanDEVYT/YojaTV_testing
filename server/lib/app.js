// HTTP del servidor: rutas, CORS, límite de cuerpo y una cuota por IP. Cero dependencias.
import { logger } from './log.js';

const MAX_BODY = 128 * 1024;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJson(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('cuerpo demasiado grande'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(Object.assign(new Error('JSON inválido'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

/** Cuota sencilla por IP: ~20 req/min con ráfaga de 10 (suficiente para un plugin, corta el abuso). */
function makeLimiter({ capacity = 10, refillPerMs = 20 / 60000, now = Date.now } = {}) {
  const buckets = new Map();
  return (key) => {
    const t = now();
    let b = buckets.get(key);
    if (!b) { b = { tokens: capacity, at: t }; buckets.set(key, b); }
    b.tokens = Math.min(capacity, b.tokens + (t - b.at) * refillPerMs);
    b.at = t;
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) if (t - v.at > 600000) buckets.delete(k);
    }
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

export function createHandler({ resolver, startedAt = Date.now(), limiter = makeLimiter() }) {
  const bootAt = startedAt;

  return async function handler(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    cors(res);
    res.setHeader('X-Service', 'YojaTV-server');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim();
    if (!limiter(`${ip}:${path}`)) {
      send(res, 429, { ok: false, error: 'rate_limited', retryAfterS: 30 });
      return;
    }

    try {
      if (req.method === 'GET') {
        if (path === '/health' || path === '/healthz') return send(res, 200, { ok: true, service: 'YojaTV-server' });
        if (path === '/') {
          return send(res, 200, {
            ok: true,
            service: 'YojaTV-server',
            version: '1.0.0',
            uptimeS: Math.round((Date.now() - bootAt) / 1000),
            cache: resolver.cache.stats(),
            inflight: resolver.inflight(),
            rutas: ['GET /health', 'GET /sources', 'GET /stats', 'POST /resolve', 'POST /report', 'POST /seed'],
          });
        }
        if (path === '/sources') return send(res, 200, { ok: true, sources: resolver.stats.snapshot() });
        if (path === '/stats') {
          return send(res, 200, {
            ok: true,
            uptimeS: Math.round((Date.now() - bootAt) / 1000),
            cache: resolver.cache.stats(),
            sources: resolver.stats.snapshot(),
            inflight: resolver.inflight(),
          });
        }
        return send(res, 404, { ok: false, error: 'no_existe' });
      }

      if (req.method === 'POST') {
        const body = await readJson(req);
        if (path === '/resolve') {
          const started = Date.now();
          const result = await resolver.resolveRequest(body || {});
          const status = result && result.ok ? 200 : result && result.error === 'ref_invalido' ? 400 : 200;
          if (result && !result.ok && result.error === 'ref_invalido') return send(res, status, result);
          return send(res, 200, { ...result, serverMs: Date.now() - started });
        }
        if (path === '/report') return send(res, 200, resolver.report(body || {}));
        if (path === '/seed') return send(res, 200, resolver.seed(body || {}));
        return send(res, 404, { ok: false, error: 'no_existe' });
      }

      return send(res, 405, { ok: false, error: 'metodo_no_permitido' });
    } catch (e) {
      const status = (e && e.status) || 500;
      logger.error('error de petición', { path, status, error: e && e.message });
      return send(res, status, { ok: false, error: status === 500 ? 'error_interno' : String(e.message || 'error') });
    }
  };
}

export { makeLimiter };
