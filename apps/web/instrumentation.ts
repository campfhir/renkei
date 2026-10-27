import type { Instrumentation } from 'next';
import { logger } from '@/lib/logger';
import {
  checkDataStore,
  createLogAdapter,
  createMemoryDataStore,
  memoryDataStoreRequested,
  registerDataStore,
} from '@renkei/db';
import { developmentDelegateKeyRefusal } from '@renkei/delegate-client';
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

    // The delegate key is this process's identity to the key service; the
    // compose file's development default is a key everyone has, so a
    // production boot with it stops here (docs/delegate-key-design.md).
    const delegateKeyRefusal = developmentDelegateKeyRefusal();
    if (delegateKeyRefusal) {
      console.error(`FATAL [web/instrumentation]: ${delegateKeyRefusal}`);
      process.exit(1);
    }

    // RENKEI_DATA_STORE=memory: the data store is plain JavaScript in this
    // process (packages/db/src/store/memory.ts), for the UI suite that
    // needs no database (playwright.memory.config.ts). Nothing here then
    // has a database to reach — no log table, no schema to check, no turn
    // or apply-job rows to recover — so boot stops after registering it.
    // Fixtures arrive per spec through app/api/test/data-store. The
    // delegate runs in this process too (lib/memory-delegate.ts), on the
    // same store: imported only here, so nothing of it loads on Postgres.
    if (memoryDataStoreRequested()) {
      registerDataStore(createMemoryDataStore());
      const { startMemoryDelegate } = await import('@/lib/memory-delegate');
      await startMemoryDelegate();
      watchLogLevel(logger);
      globalMarks.__renkeiPgLogAdapterAttached = true;
      logger.warn('Running on the IN-MEMORY data store: nothing is persisted', {
        component: 'web/instrumentation',
      });
      return;
    }

    // Every adapter starts at info, which holds only for the few seconds
    // before the database is reachable; once it is, the org `logLevel` dial
    // (packages/settings) governs, polled and reapplied here so a saved
    // change takes effect without a restart. Started here (real server
    // boot, guarded above against re-running on a dev recompile) rather
    // than at module load in lib/logger.ts, which hundreds of unit tests
    // import without expecting a background DB-polling timer to start.
    watchLogLevel(logger);

    const ready = checkDataStore();
    if (!ready.ok) {
      logger.error('Failed to initialize database for bored-logs', {
        component: 'web/instrumentation',
        error: String(ready.err),
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

    // The adapter rides @renkei/db's own connection: this process never
    // holds the handle.
    const built = await createLogAdapter({
      level: 'info',
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
    if (!built.ok) {
      logger.error('Failed to initialize database for bored-logs', {
        component: 'web/instrumentation',
        error: String(built.err),
      });
      return;
    }
    const adapter = built.val;

    // Idempotent (CREATE IF NOT EXISTS) — brings a table set created by an
    // older bored-logs up to the current schema on every boot.
    await adapter.migrate();
    logger.addAdapter(adapter);

    globalMarks.__renkeiPgLogAdapterAttached = true;
    logger.info('PostgresAdapter registered', { component: 'web/instrumentation' });

    await reportSchemaDrift();

    // Shutdown and recovery for the chat turns this process runs. Next's
    // own SIGTERM/SIGINT handler stays: it waits for after() work, and
    // this is what makes a turn's after() work end promptly — suspended,
    // for any web process's recovery sweep (this one's, after a restart)
    // to pick up where the rows say it was. See lib/shutdown.ts and
    // lib/chat/turn-recovery.ts.
    const { installShutdownHandlers } = await import('@/lib/shutdown');
    const { startTurnRecovery } = await import('@/lib/chat/turn-recovery');
    installShutdownHandlers((signal) =>
      logger.info('{signal} received: suspending running chat turns', {
        component: 'web/instrumentation',
        signal,
      })
    );
    startTurnRecovery();

    // Approved Salesforce and Jira admin changes run as jobs in this
    // process (an after() from the approve route); this sweep starts any
    // that were queued as a process went away, and takes over any whose job
    // stopped reporting. See lib/salesforce-admin/apply-job.ts.
    const { startApplyJobRecovery } = await import('@/lib/salesforce-admin/apply-job');
    startApplyJobRecovery();
    const { startApplyJobRecovery: startJiraApplyJobRecovery } =
      await import('@/lib/jira-admin/apply-job');
    startJiraApplyJobRecovery();
  }
}

/**
 * Every error a page render, route handler or server action let escape,
 * on its way to the browser's error boundary (app/(app)/error.tsx). Next
 * prints these to the console only; this puts them in the log table too,
 * keyed by the digest the boundary shows the person, so an "it errored
 * again" report can be matched to its cause. Headers are left out: they
 * carry the session cookie.
 */
export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  const digest =
    typeof error === 'object' && error !== null && 'digest' in error
      ? String(error.digest)
      : undefined;
  logger.error('Unhandled {routeType} error on {routePath}: {message}', {
    component: 'web/request-error',
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : undefined,
    stack: error instanceof Error ? error.stack : undefined,
    digest,
    method: request.method,
    path: request.path,
    routePath: context.routePath,
    routeType: context.routeType,
    renderSource: context.renderSource,
  });
};

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
