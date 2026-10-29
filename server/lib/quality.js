// Calidad y etiquetas: la misma regla que el plugin ("1080p: FuegoCine").

const QUALITY_RE = /(?:^|[^\d])(2160|1440|1080|720|576|480|360)p?(?=[^\d]|$)/i;

/** Calidad que se lee de la URL, o null. */
export function qualityFromUrl(u) {
  const m = QUALITY_RE.exec(String(u || ''));
  return m ? m[1] + 'p' : null;
}

/** Calidad de un stream ya resuelto: etiqueta primero, luego URL. */
export function qualityOf(stream) {
  if (!stream) return null;
  const fromLabel = QUALITY_RE.exec(String(stream.label || ''));
  if (fromLabel) return fromLabel[1] + 'p';
  return qualityFromUrl(stream.url);
}

/** Orden de calidad: más grande primero (desconocido = 0). */
export function qualityRank(q) {
  const n = parseInt(String(q || '').replace(/p$/i, ''), 10);
  if (!Number.isFinite(n)) return 0;
  if (n >= 1440) return 4;
  if (n >= 1080) return 3;
  if (n >= 720) return 2;
  if (n >= 480) return 1;
  return 0;
}

/** "1080p: FuegoCine", o la parte que se conozca. */
export function labelFor(quality, name) {
  const q = quality ? String(quality) : '';
  const n = name ? String(name) : '';
  if (q && n) return `${q}: ${n}`;
  return q || n || null;
}

/** Un nombre legible para un ref "fuente:camino". */
export function nameOfRef(ref, labels) {
  const r = typeof ref === 'string' ? ref : '';
  if (!r) return '';
  const srcId = r.includes(':') ? r.slice(0, r.indexOf(':')) : r;
  return (labels && labels[srcId]) || srcId;
}
