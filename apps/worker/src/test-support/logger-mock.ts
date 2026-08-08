/**
 * Jest stand-in for src/logger.ts, wired via moduleNameMapper. The real
 * module imports the bored-logs Postgres adapter, which reaches ESM-only
 * kysely helpers jest cannot parse — and tests assert on behavior, not log
 * output, so a silent logger is the honest substitute.
 */

const noop = (): void => undefined;

export const logger = {
  critical: noop,
  error: noop,
  warn: noop,
  info: noop,
  http: noop,
  verbose: noop,
  cache: noop,
  request: noop,
  response: noop,
  sql: noop,
  debug: noop,
};

export function attachDbLogging(): void {}
