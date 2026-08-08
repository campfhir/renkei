import { logger } from '@/lib/logger';
import { getDatabase } from '@renkei/db';

// register() re-runs on dev recompiles, and the logger it decorates is a
// process-wide singleton — without this guard each recompile would attach
// another PostgresAdapter and every log line would be written to the table
// once per recompile.
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const globalMarks = globalThis as unknown as { __renkeiPgLogAdapterAttached?: boolean };

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    if (globalMarks.__renkeiPgLogAdapterAttached) return;

    const { PostgresAdapter } = await import('@campfhir/bored-logs/adapters/psql');

    const dbResult = getDatabase();
    if (!dbResult.ok) {
      logger.error('Failed to initialize database for bored-logs', {
        component: 'web/instrumentation',
        error: String(dbResult.err),
      });
      return;
    }

    logger.addAdapter(
      new PostgresAdapter({
        db: dbResult.val,
        level: process.env.LOG_DB_LEVEL ?? 'info',
        onWarning(w) {
          if (w.type === 'attr_keys_truncated') {
            logger.warn('attribute keys truncated', { component: 'logging/adapter' });
          } else if (w.type === 'attr_value_truncated') {
            logger.warn('attribute value truncated', { component: 'logging/adapter' });
          }
        },
      })
    );

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
