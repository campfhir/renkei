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
  // GIT_COMMIT is baked in by docker-build.sh: every row names the exact
  // build that produced it (0.1.0+sha), absent in bare local runs.
  version: process.env.GIT_COMMIT
    ? `${packageJson.version}+${process.env.GIT_COMMIT}`
    : packageJson.version,
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
export async function attachDbLogging(): Promise<void> {
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    logger.error('Could not attach Postgres log adapter; logging to console only', {
      component: 'worker/logging',
      error: String(dbResult.err),
    });
    return;
  }
  const adapter = new PostgresAdapter({
    db: dbResult.val,
    level: process.env.LOG_DB_LEVEL ?? 'info',
  });
  try {
    // Idempotent (CREATE IF NOT EXISTS) — safe on every boot, and what keeps
    // the log tables current across bored-logs upgrades.
    await adapter.migrate();
  } catch (error) {
    logger.error('Log table migration failed; logging to console only', {
      component: 'worker/logging',
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  logger.addAdapter(adapter);
}
