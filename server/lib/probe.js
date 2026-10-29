// Comprobación barata de que un enlace cacheado sigue vivo antes de devolverlo: un rango de un
// byte, con un tope corto. Solo se usa con enlaces volátiles (los que llevan token) ya
// cierta edad, así la caché se autocura sin frenar a todo el mundo.
// 'dead' = el origen dice claramente que ya no está (403/404/410/…); 'unknown' no borra nada:
// ante la duda la caché se queda y el que falla nos lo cuenta por /report.

const DEAD_STATUSES = new Set([400, 401, 403, 404, 410, 451]);

export async function verifyStream(entry, timeoutMs = 2500) {
  const url = entry && entry.url;
  if (!url || !/^https?:\/\//i.test(url)) return 'unknown';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { ...(entry.headers || {}), Range: 'bytes=0-0', 'Accept-Encoding': 'identity' };
    // Solo las cabeceras que el origen pidió: nada de meter las de otro dominio.
    const clean = {};
    for (const [k, v] of Object.entries(headers)) {
      if (/^(referer|origin|user-agent|authorization|cookie|range|accept|accept-language)$/i.test(k)) clean[k] = v;
    }
    const res = await fetch(url, { method: 'GET', headers: clean, redirect: 'follow', signal: controller.signal });
    if (res.status >= 200 && res.status < 400) {
      // Lee poquito para cerrar la conexión enseguida.
      try { await res.arrayBuffer(); } catch { /* nada */ }
      return 'alive';
    }
    if (DEAD_STATUSES.has(res.status)) return 'dead';
    return 'unknown';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}
