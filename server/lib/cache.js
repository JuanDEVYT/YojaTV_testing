// Caché de streams resueltos: TTL por tipo de URL, tope de entradas (LRU) y purga explícita
// cuando el plugin reporta que un enlace se venció o no reproduce.

const MIN_TTL_MS = 30 * 1000;
const MAX_TTL_MS = 6 * 60 * 60 * 1000;

// Hostes cuyos enlaces llevan token y viven poco.
const VOLATILE_HOST_RE = /vimeos|goodstream|mixdrop|streamtape|dood|uqload|voe\.sx|filemoon|streamwish|vidhide|unlimplay|hglink|fotise|kaembed|nontongo|vidfast|vidplayz|playmogo|megankiddifference|chaliceguzzlerlandlord|derricknationtop|opuxa/i;

/** true si el enlace puede vencer pronto (token, consulta o host volátil): se comprueba antes de servirlo. */
export function looksVolatile(url) {
  const u = String(url || '');
  if (!u) return false;
  if (/\?[^#]+/.test(u)) return true;
  return VOLATILE_HOST_RE.test(u);
}

/** Vida útil de un enlace. */
export function ttlMsFor(url) {
  const u = String(url || '');
  let ttl;
  if (VOLATILE_HOST_RE.test(u)) ttl = 5 * 60 * 1000;
  else if (/\?[^#]+/.test(u)) ttl = 10 * 60 * 1000;
  else if (/\.m3u8(\?|#|$)/i.test(u)) ttl = 30 * 60 * 1000;
  else ttl = 45 * 60 * 1000;
  return Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, ttl));
}

export class StreamCache {
  constructor({ maxEntries = 800, now = Date.now } = {}) {
    this.maxEntries = maxEntries;
    this.now = now;
    this.map = new Map(); // ref -> entry
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  get(ref) {
    const e = this.map.get(ref);
    if (!e) { this.misses++; return null; }
    if (e.expiresAt <= this.now()) {
      this.map.delete(ref);
      this.evictions++;
      this.misses++;
      return null;
    }
    // tope LRU: se reubica al final
    this.map.delete(ref);
    this.map.set(ref, e);
    this.hits++;
    e.hits = (e.hits || 0) + 1;
    return e;
  }

  /** Igual que get() pero sin contar hits/misses (para mirar sin gastar estadística). */
  peek(ref) {
    const e = this.map.get(ref);
    if (!e || e.expiresAt <= this.now()) return null;
    return e;
  }

  set(ref, stream, { srcId = null, ttlMs = null, label = null, quality = null } = {}) {
    if (!ref || !stream || !stream.url) return false;
    const ttl = ttlMs || ttlMsFor(stream.url);
    const at = this.now();
    const entry = {
      ref,
      url: stream.url,
      headers: stream.headers || null,
      mime: stream.mime || null,
      label: label || stream.label || null,
      quality: quality || null,
      srcId: srcId || (String(ref).includes(':') ? String(ref).slice(0, ref.indexOf(':')) : null),
      at,
      expiresAt: at + ttl,
      ttlMs: ttl,
      hits: 0,
      subtitles: stream.subtitles || null,
      alts: Array.isArray(stream.alts) && stream.alts.length ? stream.alts : null,
    };
    this.map.delete(ref);
    this.map.set(ref, entry);
    this.trim();
    return true;
  }

  trim() {
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
      this.evictions++;
    }
  }

  /** Borra una entrada por ref. Devuelve cuántas borró. */
  evictRef(ref) {
    if (!ref) return 0;
    let n = 0;
    for (const key of [...this.map.keys()]) {
      if (key === ref || key.startsWith(ref + ':') || ref.startsWith(key + ':')) {
        this.map.delete(key);
        n++;
      }
    }
    this.evictions += n;
    return n;
  }

  /** Borra toda entrada que use esa URL (el enlace que se venció). */
  evictUrl(url) {
    if (!url) return 0;
    let n = 0;
    for (const [key, e] of [...this.map.entries()]) {
      if (e.url === url) { this.map.delete(key); n++; }
    }
    this.evictions += n;
    return n;
  }

  clear() {
    const n = this.map.size;
    this.map.clear();
    this.evictions += n;
    return n;
  }

  stats() {
    let bytes = 0;
    for (const e of this.map.values()) bytes += (e.url ? e.url.length : 0) + (e.headers ? JSON.stringify(e.headers).length : 0);
    return {
      entries: this.map.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      approxBytes: bytes,
    };
  }
}
