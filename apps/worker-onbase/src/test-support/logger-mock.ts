/**
 * Jest stand-in for src/logger.ts, wired via moduleNameMapper. The real
 * module imports the bored-logs Postgres adapter, which reaches ESM-only
 * kysely helpers jest cannot parse.
 *
 * Silent, but no longer amnesiac: warn/error calls are recorded so a test can
 * assert on the SENTENCE a failure produces. That matters because the
 * interpolator leaves an unresolved `{placeholder}` sitting in the message
 * instead of throwing — a defect nothing but the rendered text reveals, and
 * one that shipped unnoticed precisely because no test could see it.
 */

export interface RecordedLog {
  level: 'warn' | 'error';
  template: string;
  attrs: Record<string, unknown>;
}

const recorded: RecordedLog[] = [];

/** Every warn/error since the last reset, oldest first. */
export function recordedLogs(): RecordedLog[] {
  return recorded;
}

export function resetRecordedLogs(): void {
  recorded.length = 0;
}

/**
 * The message as bored-logs would render it: `{key}` replaced by its
 * attribute, and left ALONE when the attribute is missing. Kept faithful to
 * the real `interpolate` so a test that passes here would pass in production.
 */
export function renderLog(entry: RecordedLog): string {
  return entry.template.replace(/\{([\w$]+)\}/g, (whole, key: string) => {
    const value = entry.attrs[key];
    if (value === undefined) return whole;
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
}

const noop = (): void => undefined;

const capture =
  (level: 'warn' | 'error') =>
  (template: string, attrs: Record<string, unknown> = {}): void => {
    recorded.push({ level, template, attrs });
  };

export const logger = {
  flush: (): Promise<void> => Promise.resolve(),
  critical: noop,
  error: capture('error'),
  warn: capture('warn'),
  info: noop,
  http: noop,
  verbose: noop,
  cache: noop,
  request: noop,
  response: noop,
  sql: noop,
  debug: noop,
};

export function attachPersistentLogging(): void {}
