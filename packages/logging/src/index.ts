/**
 * The logger the packages write to. A package has no logger of its own: it
 * calls `log.warn('… {reason}', { component, … })` where it hits a failure,
 * and that line lands in whichever process loaded the package.
 *
 * The process registers its own logger once at boot (apps/web's logger, the
 * worker kit's, each worker's), so a package's lines reach the same console
 * and Postgres log as everything else that process writes. Until one is
 * registered, and in tests, warnings and errors still go to the console, so a
 * failure is never silent.
 *
 * Anchored on globalThis for the same reason apps/web's logger is: Next
 * bundles the server, its routes and its instrumentation as separate
 * compilation graphs, and each evaluates this module on its own.
 */

/** The shape every process logger already has (bored-logs and its adapters). */
export interface LogSink {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

type Level = keyof LogSink;

const anchor = globalThis as unknown as { __renkeiLogSink?: LogSink };

function fallback(level: Level, message: string, fields?: Record<string, unknown>): void {
  // Debug and info are for a running process's own logger; without one they
  // are dropped, while warnings and errors still reach the console.
  if (level === 'debug' || level === 'info') return;
  const line = fields ? `${message} ${JSON.stringify(fields)}` : message;
  if (level === 'error') console.error(line);
  else console.warn(line);
}

/** Called once, at boot, by the process that owns the logger. */
export function registerLogSink(sink: LogSink): void {
  anchor.__renkeiLogSink = sink;
}

function emit(level: Level, message: string, fields?: Record<string, unknown>): void {
  const sink = anchor.__renkeiLogSink;
  if (sink) sink[level](message, fields);
  else fallback(level, message, fields);
}

export const log: LogSink = {
  debug: (message, fields) => emit('debug', message, fields),
  info: (message, fields) => emit('info', message, fields),
  warn: (message, fields) => emit('warn', message, fields),
  error: (message, fields) => emit('error', message, fields),
};
