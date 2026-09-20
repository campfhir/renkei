import { logger } from '@/lib/logger';
import { getDatabase } from '@renkei/db';
import { watchLogLevel } from '@renkei/settings';
import type { LogCipher } from '@/lib/log-encryption';

// register() re-runs on dev recompiles, and the logger it decorates is a
// process-wide singleton — without this guard each recompile would attach
// another PostgresAdapter and every log line would be written to the table
// once per recompile.
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const globalMarks = globalThis as unknown as { __renkeiPgLogAdapterAttached?: boolean };

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    if (globalMarks.__renkeiPgLogAdapterAttached) return;

    // application/version/commit ride on every line as global attrs (see
    // lib/logger.ts) — this boot line just makes the plain-English
    // announcement, first, before anything that could fail.
    logger.info('booting {application} {version}', { component: 'web/instrumentation' });

    // CONSOLE_LOG_LEVEL/LOG_DB_LEVEL only set the level for the few seconds
    // before the database is reachable; once it is, the org `logLevel` dial
    // (packages/settings) governs, polled and reapplied here so a saved
    // change takes effect without a restart. Started here (real server
    // boot, guarded above against re-running on a dev recompile) rather
    // than at module load in lib/logger.ts, which hundreds of unit tests
    // import without expecting a background DB-polling timer to start.
    watchLogLevel(logger);

    const { PostgresAdapter } = await import('@campfhir/bored-logs/adapters/psql');

    const dbResult = getDatabase();
    if (!dbResult.ok) {
      logger.error('Failed to initialize database for bored-logs', {
        component: 'web/instrumentation',
        error: String(dbResult.err),
      });
      return;
    }

    // secure()-marked attributes (failed-request payloads) encrypt at rest
    // with LOG_ENCRYPTION_KEY. Encryption is mandatory: a missing or malformed
    // key is a fatal misconfiguration, not a silent downgrade to plaintext, so
    // we crash the process rather than write sensitive bodies in the clear.
    const { requireLogCipher } = await import('@/lib/log-encryption');
    let cipher: LogCipher;
    try {
      cipher = requireLogCipher();
    } catch (error) {
      console.error(
        `FATAL [web/instrumentation]: ${error instanceof Error ? error.message : String(error)}`
      );
      process.exit(1);
    }

    const adapter = new PostgresAdapter({
      db: dbResult.val,
      level: process.env.LOG_DB_LEVEL ?? 'info',
      encrypt: cipher.encrypt,
      decrypt: cipher.decrypt,
      onWarning(w) {
        if (w.type === 'attr_keys_truncated') {
          logger.warn('attribute keys truncated', { component: 'logging/adapter' });
        } else if (w.type === 'attr_value_truncated') {
          logger.warn('attribute value truncated', { component: 'logging/adapter' });
        }
      },
    });

    // Idempotent (CREATE IF NOT EXISTS) — brings a table set created by an
    // older bored-logs up to the current schema on every boot.
    await adapter.migrate();
    logger.addAdapter(adapter);

    globalMarks.__renkeiPgLogAdapterAttached = true;
    logger.info('PostgresAdapter registered', {
      component: 'web/instrumentation',
      level: process.env.LOG_DB_LEVEL ?? 'info',
    });

    await reportSchemaDrift();
  }
}

/**
 * Say loudly, once, at startup if the schema is behind the code.
 *
 * Migrations are a separate deliberate step, so this only reports: an operator
 * who pulled new images and skipped it otherwise finds out when an MCP client
 * fails to register, several layers away from the cause.
 */
async function reportSchemaDrift(): Promise<void> {
  const { getMigrationStatus, MIGRATION_COMMAND } = await import('@renkei/db');
  const status = await getMigrationStatus();

  if (status.error) {
    logger.error('Could not check migration status: {error}', {
      component: 'web/instrumentation',
      error: status.error,
    });
    return;
  }

  if (status.pending.length === 0) {
    logger.info('Schema up to date', { component: 'web/instrumentation', applied: status.applied });
    return;
  }

  logger.error('DATABASE SCHEMA IS BEHIND THIS BUILD — {count} migration(s) pending', {
    component: 'web/instrumentation',
    count: status.pending.length,
    pending: status.pending.join(', '),
    applied: status.applied,
    action: MIGRATION_COMMAND,
    consequence:
      'Requests touching the new schema will fail until this is run. /api/health reports 503.',
  });
}
