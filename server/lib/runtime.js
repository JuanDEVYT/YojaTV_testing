// Arranca el plugin de YojaTV dentro de Node con el mismo `kino` que le da la app
// (sdk/kino-shim.mjs): el servidor reutiliza la lógica de resolución real en lugar de
// duplicarla. Si el kit no puede algo (kino.browser.page, que solo existe en la app), el
// plugin lo atrapa solo y devuelve lo que pudo; lo que falte lo resuelve el plugin en el
// dispositivo y nos lo manda por /seed.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createKino } from '../../sdk/kino-shim.mjs';
import { logger } from './log.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const manifest = JSON.parse(readFileSync(join(ROOT, 'kino-plugin.json'), 'utf8'));

// Un solo runtime en memoria: la caché de TMDB y las cookies de los orígenes se aprovechan
// entre peticiones. storageFile/cookiesFile = null -> vive en RAM, nada de escritura en disco.
const kit = createKino(manifest, { appVersion: 'YojaTV-server', storageFile: null, cookiesFile: null });
globalThis.kino = kit.kino;

const plugin = await import(pathToFileURL(join(ROOT, 'plugin.js')).href);

// Etiquetas de cada fuente, para los rótulos: "1080p: FuegoCine".
const labels = {};
try {
  for (const id of Object.keys(plugin.__sources ? plugin.__sources() : {})) labels[id] = id;
} catch { /* el plugin no expone fuentes: los rótulos vienen de sus propias etiquetas */ }

logger.info('runtime listo', {
  plugin: `${manifest.id}@${manifest.version}`,
  apiVersion: manifest.apiVersion,
  hosts: Array.isArray(manifest.hosts) ? manifest.hosts.length : 0,
});

export const runtime = {
  manifest,
  plugin,
  kit,
  labels,
  /** Presupuesto de kino.fetch: cada resolve es "una llamada" para el kit. */
  resetBudget: () => { try { kit.resetBudget(); } catch { /* nada */ } },
};
