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

/**
 * Who and where a record came from, when the code writing it is inside a
 * request: the signed-in person, the browser's user agent, and the page or
 * path. Supplied by the process (apps/web's request scope on the server;
 * nothing in a browser unless the caller passes it).
 */
export interface LogContext {
  user?: string;
  browserAgent?: string;
  /** The page the person was on, as the browser sent it. */
  page?: string;
  /** The path the request was made to, on the server. */
  route?: string;
}

const anchor = globalThis as unknown as {
  __renkeiLogSink?: LogSink;
  __renkeiLogContext?: () => LogContext | undefined;
};

/** Called once, at boot, by the process that owns the logger. */
export function registerLogSink(sink: LogSink): void {
  anchor.__renkeiLogSink = sink;
}

/** Called once, at boot, by a process that knows the request a log line belongs to. */
export function registerLogContext(provider: () => LogContext | undefined): void {
  anchor.__renkeiLogContext = provider;
}

/**
 * The stack where the line was written, without this module's own frames, so
 * the first frame is the code that logged. An Error passed in keeps its own
 * stack, which is where the failure really happened.
 */
export function callSiteStack(): string | undefined {
  // V8 keeps 10 frames by default, and this module's own frames use some of
  // them: widen the window for this one capture.
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 30;
  const raw = new Error().stack;
  Error.stackTraceLimit = limit;
  if (!raw) return undefined;
  // The frames from this logger (named after its functions, or its source
  // file, which a bundle may not keep) come first; the caller starts at the
  // first frame that is not one of them.
  const frames = raw.split('\n').slice(1);
  let first = 0;
  while (first < frames.length && LOGGER_FRAME.test(frames[first])) first += 1;
  return ['Error', ...frames.slice(first, first + 12)].join('\n');
}

const LOGGER_FRAME =
  /\b(callSiteStack|enrich|emit|enhanceLogger|logWithContext)\b|packages\/logging\/src\/index\.(ts|js|mjs|cjs):\d|@campfhir\/bored-logs|Object\.(debug|info|warn|error)\b/;

/**
 * The record as it is written: the request's context under the call's own
 * fields, an Error reduced to its message with its stack kept, and a stack for
 * every warning and error.
 */
function enrich(level: Level, fields?: Record<string, unknown>): Record<string, unknown> {
  const { error, ...given } = fields ?? {};
  // A field the caller left undefined says nothing: it must not blank the
  // request's context, nor count as a stack the logger should not add.
  const rest = Object.fromEntries(Object.entries(given).filter(([, value]) => value !== undefined));
  const out: Record<string, unknown> = { ...(anchor.__renkeiLogContext?.() ?? {}), ...rest };
  if (error !== undefined) {
    if (error instanceof Error) {
      out.error = error.message;
      if (error.stack) out.stack = error.stack;
    } else {
      out.error = String(error);
    }
  }
  if ((level === 'warn' || level === 'error') && out.stack === undefined) {
    out.stack = callSiteStack();
  }
  return out;
}

function fallback(level: Level, message: string, fields: Record<string, unknown>): void {
  // Debug and info are for a running process's own logger; without one they
  // are dropped, while warnings and errors still reach the console.
  if (level === 'debug' || level === 'info') return;
  const line = `${message} ${JSON.stringify(fields)}`;
  if (level === 'error') console.error(line);
  else console.warn(line);
}

function emit(level: Level, message: string, fields?: Record<string, unknown>): void {
  const record = enrich(level, fields);
  const sink = anchor.__renkeiLogSink;
  if (sink) sink[level](message, record);
  else fallback(level, message, record);
}

export const log: LogSink = {
  debug: (message, fields) => emit('debug', message, fields),
  info: (message, fields) => emit('info', message, fields),
  warn: (message, fields) => emit('warn', message, fields),
  error: (message, fields) => emit('error', message, fields),
};

const LEVELS: Level[] = ['debug', 'info', 'warn', 'error'];

/**
 * Makes a process logger (bored-logs, or anything with the same four methods)
 * write the request context and the call-site stack with every record, the
 * same way `log` does. A call's own fields win over the context, and the
 * logger is returned as it was passed in.
 */
export function enhanceLogger<T extends object>(target: T): T {
  for (const level of LEVELS) {
    const original: unknown = Reflect.get(target, level);
    if (typeof original !== 'function') continue;
    const logWithContext = (message: string, fields?: Record<string, unknown>) =>
      original.call(target, message, enrich(level, fields));
    Reflect.set(target, level, logWithContext);
  }
  return target;
}
