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

    // application/version/commit ride on every line as global attrs (see
    // lib/logger.ts) — this boot line just makes the plain-English
    // announcement, first, before anything that could fail.
    logger.info('booting {application} {version}', { component: 'web/instrumentation' });

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
    // when LOG_ENCRYPTION_KEY is set. A malformed key is reported loudly but
    // does not stop logging — availability over confidentiality, flagged.
    const { resolveLogCipher } = await import('@/lib/log-encryption');
    const cipherResult = resolveLogCipher();
    if (cipherResult.state === 'invalid') {
      logger.error(
        'LOG_ENCRYPTION_KEY is malformed; secure log attributes will be stored UNENCRYPTED: {error}',
        {
          component: 'web/instrumentation',
          error: cipherResult.error,
        }
      );
    }
    const cipher = cipherResult.state === 'on' ? cipherResult.cipher : undefined;

    const adapter = new PostgresAdapter({
      db: dbResult.val,
      level: process.env.LOG_DB_LEVEL ?? 'info',
      ...(cipher ? { encrypt: cipher.encrypt, decrypt: cipher.decrypt } : {}),
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
