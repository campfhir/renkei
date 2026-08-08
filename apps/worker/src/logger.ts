import { createLogger, ConsoleAdapter } from '@campfhir/bored-logs';
import { PostgresAdapter } from '@campfhir/bored-logs/adapters/psql';
import { getDatabase } from '@renkei/db';
import packageJson from '../package.json';

/**
 * The worker's logger — same stack as the web app's (console + Postgres
 * adapters, component attributes), so worker activity finally lands in the
 * logs table beside everything else instead of only in docker logs. Identity
 * comes from this package's manifest, so rows say which worker version
 * produced them.
 *
 * A single-process CLI needs no globalThis anchor: one module graph, one
 * evaluation.
 */
export const logger = createLogger({
  application: packageJson.name,
  version: packageJson.version,
});

logger.addAdapter(
  new ConsoleAdapter({
    level: process.env.CONSOLE_LOG_LEVEL ?? 'info',
    showTimestamp: true,
    showLevel: true,
    maskSecure: process.env.NODE_ENV === 'production',
  })
);

/**
 * Attach the Postgres adapter once the database is reachable — called from
 * main() at boot. Failure is reported, not fatal: a worker that can log only
 * to stdout still beats one that refuses to start.
 */
export function attachDbLogging(): void {
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    logger.error('Could not attach Postgres log adapter; logging to console only', {
      component: 'worker/logging',
      error: String(dbResult.err),
    });
    return;
  }
  logger.addAdapter(
    new PostgresAdapter({
      db: dbResult.val,
      level: process.env.LOG_DB_LEVEL ?? 'info',
    })
  );
}
