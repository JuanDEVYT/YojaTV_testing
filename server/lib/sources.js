// Memoria de qué fuente responde más rápido: media móvil de la latencia, tasa de éxito y
// cortacircuitos para no insistir con una fuente caída. Es lo que decide el orden en que se
// intentan las fuentes y el orden en que se devuelven.

const DEFAULT_SCORE_MS = 2500; // sin datos: ni ventaja ni castigo
const ALPHA = 0.35; // peso de la última medición
const OPEN_AFTER = 3; // fallos seguidos que abren el cortacircuitos
const OPEN_MS = 45 * 1000;
const OPEN_MS_MAX = 5 * 60 * 1000;

export function srcIdOfRef(ref) {
  const r = typeof ref === 'string' ? ref : '';
  if (!r) return null;
  if (r.startsWith('mg:')) return null;
  const i = r.indexOf(':');
  return i > 0 ? r.slice(0, i) : r;
}

export class SourceStats {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.map = new Map(); // srcId -> { emaMs, ok, fail, consecutive, openUntil, samples }
  }

  _get(srcId) {
    let s = this.map.get(srcId);
    if (!s) {
      s = { emaMs: null, ok: 0, fail: 0, consecutive: 0, openUntil: 0, samples: 0, openCount: 0 };
      this.map.set(srcId, s);
    }
    return s;
  }

  /** Registrar un intento de resolve. */
  observe(srcId, ms, ok) {
    if (!srcId) return;
    const s = this._get(srcId);
    const t = Number.isFinite(ms) ? Math.max(0, ms) : 0;
    s.samples++;
    if (ok) {
      s.ok++;
      s.consecutive = 0;
      s.emaMs = s.emaMs === null ? t : Math.round(s.emaMs * (1 - ALPHA) + t * ALPHA);
    } else {
      s.fail++;
      s.consecutive++;
      // un fallo también deja constancia: la media no sube, pero sí cuenta como lentitud
      if (s.emaMs === null) s.emaMs = Math.max(t, DEFAULT_SCORE_MS);
      if (s.consecutive >= OPEN_AFTER && s.openUntil <= this.now()) {
        s.openCount++;
        s.openUntil = this.now() + Math.min(OPEN_MS * Math.pow(2, Math.max(0, s.openCount - 1)), OPEN_MS_MAX);
        s.consecutive = 0;
      }
    }
  }

  /** true si la fuente está en cuarentena y no conviene preguntarle. */
  isOpen(srcId) {
    const s = srcId && this.map.get(srcId);
    return !!(s && s.openUntil > this.now());
  }

  /** Puntuación en ms: menor = mejor. */
  score(srcId) {
    if (!srcId) return DEFAULT_SCORE_MS;
    const s = this.map.get(srcId);
    if (!s) return DEFAULT_SCORE_MS;
    if (s.openUntil > this.now()) return Number.POSITIVE_INFINITY;
    if (s.emaMs === null) return DEFAULT_SCORE_MS;
    const total = s.ok + s.fail;
    const failRate = total ? s.fail / total : 0;
    return s.emaMs + failRate * 3000;
  }

  /** Los refs ordenados por quién responde más rápido (estable: los desconocidos conservan su orden). */
  rankRefs(refs) {
    return refs
      .map((ref, index) => ({ ref, index, score: this.score(srcIdOfRef(ref)) }))
      .sort((a, b) => a.score - b.score || a.index - b.index)
      .map((x) => x.ref);
  }

  snapshot() {
    const out = [];
    for (const [id, s] of this.map) {
      const total = s.ok + s.fail;
      out.push({
        id,
        avgMs: s.emaMs,
        samples: s.samples,
        ok: s.ok,
        fail: s.fail,
        successRate: total ? Math.round((s.ok / total) * 1000) / 1000 : null,
        open: s.openUntil > this.now(),
        openForMs: s.openUntil > this.now() ? s.openUntil - this.now() : 0,
        score: this.score(id) === Number.POSITIVE_INFINITY ? null : Math.round(this.score(id)),
      });
    }
    out.sort((a, b) => (a.score ?? 1e9) - (b.score ?? 1e9));
    return out;
  }
}
