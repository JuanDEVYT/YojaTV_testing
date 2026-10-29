// Registro en una línea JSON por evento: Render lo guarda tal cual y se puede filtrar por `msg`.
// LOG_LEVEL=debug|info|warn|error (por defecto info).
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function emit(level, msg, data) {
  if (LEVELS[level] < MIN) return;
  const line = { t: new Date().toISOString(), level, msg, ...(data || {}) };
  let out;
  try { out = JSON.stringify(line); } catch { out = JSON.stringify({ t: line.t, level, msg: String(msg) }); }
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(out + '\n');
}

export const logger = {
  debug: (msg, data) => emit('debug', msg, data),
  info: (msg, data) => emit('info', msg, data),
  warn: (msg, data) => emit('warn', msg, data),
  error: (msg, data) => emit('error', msg, data),
};
