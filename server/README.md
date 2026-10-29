# YojaTV-server

Webservice que resuelve los streams de YojaTV para Kino: el plugin le manda los refs candidatos de
un título y el servidor devuelve la lista ordenada con su calidad (`"1080p: FuegoCine"`), lista
para que la persona elija en el menú **Servidor**.

- **Caché** de enlaces resueltos, con TTL según el tipo de URL (los que llevan token viven poco).
- **Autocuración**: si un enlace cacheado está viejo y el origen ya lo rechaza, se comprueba con
  un rango de un byte, se borra y se vuelve a resolver.
- **Reporte**: el plugin avisa por `/report` cuando un enlace se vence o no reproduce y el servidor
  lo borra al instante (y opcionalmente devuelve otro funcional).
- **Prioridad por velocidad**: cada fuente tiene una media de latencia y tasa de éxito; primero se
  intentan las rápidas y así sale ordenada la lista.
- **Cortacircuitos**: una fuente que falla tres veces seguidas se aparta 45 s (y sube exponencial
  hasta 5 min) en vez de hacer perder el tiempo a todo el mundo.
- **Fallback**: si el servidor no contesta o no sabe, el plugin resuelve en el dispositivo como
  siempre; si resuelve allá, se lo manda por `/seed` para que la próxima vez esté en caché.

## Endpoints

| Ruta | Qué hace |
| --- | --- |
| `GET /health` | Salud (para Render) |
| `GET /` · `GET /stats` | Estado, caché y métricas |
| `GET /sources` | Ranking de fuentes (ms medios, aciertos, cortacircuitos) |
| `POST /resolve` | `{ ref?, refs: [...] }` → `{ ok, streams: [{ label, url, headers, quality, ms, cached, expiresInSeconds }], unresolved, tookMs }` |
| `POST /report` | `{ ref?, url?, reason }` → borra de la caché; `{ fresh: true }` además resuelve otra vez |
| `POST /seed` | `{ ref, stream }` → guarda un stream que el plugin resolvió en el dispositivo |

## Correr

```bash
node index.js                 # PORT=8787
npm test                      # node --test test/
```

Sin dependencias: `package.json` no tiene `dependencies`, así que `npm install` es un no-op en Render.

## Variables

| Variable | Por defecto | Qué hace |
| --- | --- | --- |
| `PORT` | `8787` | Puerto (Render lo inyecta) |
| `LOG_LEVEL` | `info` | `debug\|info\|warn\|error` |
| `PER_REF_TIMEOUT_MS` | `9000` | Tope por fuente |
| `REQUEST_TIMEOUT_MS` | `14000` | Tope total del pedido |
| `MAX_NEW` | `4` | Cuántas fuentes se resuelven de nuevo por petición |

## Cómo se arma el runtime

`lib/runtime.js` importa `plugin.js` con `sdk/kino-shim.mjs`, el mismo stand-in de `kino` que usa
el kit de desarrollo, así que el servidor ejecuta **la misma lógica de resolución** que el plugin
(una sola copia del código, sin duplicar fuentes). Lo que el kit no puede (`kino.browser.page`,
solo existe en la app) lo atrapa el plugin y devuelve lo que pudo; eso lo resuelve luego el
dispositivo y se guarda con `/seed`.

**Nota de firma:** el manifiesto firma el `plugin.js` contra `owner/repo`. Si cambia `plugin.js`:
`node sdk/seal.mjs --sign --repo YojaTV-kino/YojaTV_plugin` (y `--repo JuanDEVYT/YojaTV_testing`
si se instala desde el repositorio de pruebas).
