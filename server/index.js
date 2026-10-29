#!/usr/bin/env node
// YojaTV-server: entry point. Arranca el plugin de YojaTV dentro de Node y le pone un HTTP encima.
//   node index.js            (PORT por defecto 8787; Render define el suyo)
import { createServer } from 'node:http';
import { runtime } from './lib/runtime.js';
import { createResolver } from './lib/resolve.js';
import { createHandler } from './lib/app.js';
import { logger } from './lib/log.js';

const port = Number(process.env.PORT) || 8787;
const host = process.env.HOST || '0.0.0.0';

const resolver = createResolver({
  runtime,
  logger,
  config: {
    perRefTimeoutMs: Number(process.env.PER_REF_TIMEOUT_MS) || 9000,
    requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS) || 14000,
    maxParallel: Number(process.env.MAX_PARALLEL) || 4,
    maxNewPerRequest: Number(process.env.MAX_NEW) || 4,
  },
});

const handler = createHandler({ resolver });

const server = createServer(handler);
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 45_000;

server.listen(port, host, () => {
  logger.info('YojaTV-server escuchando', { port, host, env: process.env.NODE_ENV || 'production' });
});

server.on('error', (err) => {
  logger.error('error del servidor', { error: err.message });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('promesa rechazada sin manejar', { error: reason && reason.message ? reason.message : String(reason) });
});
process.on('uncaughtException', (err) => {
  logger.error('excepción no capturada', { error: err && err.message ? err.message : String(err) });
});

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  logger.info('cerrando', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
