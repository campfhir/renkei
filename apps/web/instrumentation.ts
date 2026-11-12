import type { Instrumentation } from 'next';
import { logger } from '@/lib/logger';
import {
  checkDataStore,
  createLogAdapter,
  createMemoryDataStore,
  memoryDataStoreRequested,
  migrateLogTables,
  registerDataStore,
} from '@renkei/db';
import { developmentDelegateKeyRefusal } from '@renkei/delegate-client';
import { publicBaseUrlRefusal, watchLogLevel } from '@renkei/settings';
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
    logger.info('the web app is booting: {application} {version}', {
      component: 'web/instrumentation',
    });

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
    // needs no database (playwright.config.ts). Nothing here then
    // has a database to reach — no log table, no schema to check, no turn
    // or apply-job rows to recover — so boot stops after registering it.
    // Specs stage their data through the app's own routes, signed in
    // through app/api/test/session. The delegate runs in this process too
    // (lib/memory-delegate.ts), on the same store, and so do the agents
    // worker's consumer and the event dispatcher (lib/memory-workers.ts):
    // imported only here, so nothing of them loads on Postgres.
    if (memoryDataStoreRequested()) {
      registerDataStore(createMemoryDataStore());
      const { startMemoryDelegate } = await import('@/lib/memory-delegate');
      await startMemoryDelegate();
      const { startMemoryWorkers } = await import('@/lib/memory-workers');
      startMemoryWorkers();
      watchLogLevel(logger);
      globalMarks.__renkeiPgLogAdapterAttached = true;
      logger.warn(
        'the web app is running on the IN-MEMORY data store: nothing is persisted and no log table is attached',
        { component: 'web/instrumentation' }
      );
      return;
    }

    // The declared public origin: production never derives it from request
    // headers (see getOrigin), so a boot without one stops here. Not asked
    // of the in-memory store above, which only the UI suite runs.
    const originRefusal = publicBaseUrlRefusal();
    if (originRefusal) {
      console.error(`FATAL [web/instrumentation]: ${originRefusal}`);
      process.exit(1);
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
      logger.error(
        'the data store is not ready, so the log table was not attached; log lines go to the console only: {error}',
        {
          component: 'web/instrumentation',
          error: String(ready.err),
        }
      );
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

    // The log table and the schema check need the database, and register()
    // must finish before Next serves a single request — health checks
    // included. So they run beside the server rather than ahead of it: a
    // slow or locked database delays when log lines reach the table (they
    // are on the console meanwhile), never when the app answers.
    globalMarks.__renkeiPgLogAdapterAttached = true;
    void attachLogTable(cipher)
      .catch((error: unknown) =>
        logger.error(
          'the Postgres log adapter could not be attached; log lines go to the console only: {error}',
          {
            component: 'web/instrumentation',
            error: error instanceof Error ? error.message : String(error),
          }
        )
      )
      .then(reportSchemaDrift)
      .catch((error: unknown) =>
        logger.error(
          'the migration status could not be checked at boot; a schema behind this build would go unreported: {error}',
          {
            component: 'web/instrumentation',
            error: error instanceof Error ? error.message : String(error),
          }
        )
      );

    // Shutdown and recovery for the chat turns this process runs. Next's
    // own SIGTERM/SIGINT handler stays: it waits for after() work, and
    // this is what makes a turn's after() work end promptly — suspended,
    // for any web process's recovery sweep (this one's, after a restart)
    // to pick up where the rows say it was. See lib/shutdown.ts and
    // lib/chat/turn-recovery.ts.
    const { installShutdownHandlers } = await import('@/lib/shutdown');
    const { startTurnRecovery } = await import('@/lib/chat/turn-recovery');
    installShutdownHandlers((signal) =>
      logger.info(
        '{signal} received: the web app is shutting down and suspending its running chat turns',
        {
          component: 'web/instrumentation',
          signal,
        }
      )
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

    // The library's bulk acts (delete, OCR, add to a project) run the same
    // way: started in after() by the route, picked up here when the process
    // that took them went away. See lib/chat/artifact-bulk-job.ts.
    const { startBulkJobRecovery } = await import('@/lib/chat/artifact-bulk-job');
    startBulkJobRecovery();
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
  logger.error(
    'an unhandled error escaped the {routeType} {routePath} ({method} {path}); the person saw the error page: {message}',
    {
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
    }
  );
};

/**
 * The bored-logs Postgres adapter, its tables brought current, added to the
 * logger. Throws when the tables cannot be brought current.
 */
async function attachLogTable(cipher: LogCipher): Promise<void> {
  // The adapter rides @renkei/db's own connection: this process never
  // holds the handle.
  const built = await createLogAdapter({
    level: 'info',
    encrypt: cipher.encrypt,
    decrypt: cipher.decrypt,
    onWarning(w) {
      if (w.type === 'attr_keys_truncated') {
        logger.warn(
          'a log line carried more attribute keys than the log table keeps; the extra keys were dropped',
          { component: 'logging/adapter' }
        );
      } else if (w.type === 'attr_value_truncated') {
        logger.warn('a log attribute value was longer than the log table keeps; it was cut short', {
          component: 'logging/adapter',
        });
      }
    },
  });
  if (!built.ok) {
    logger.error(
      'the log table adapter could not be built; log lines go to the console only: {error}',
      {
        component: 'web/instrumentation',
        error: String(built.err),
      }
    );
    return;
  }
  const adapter = built.val;

  // DDL only when a table or index is missing: the "idempotent" CREATE ...
  // IF NOT EXISTS still queues for a table lock behind every other
  // process's log inserts (see migrateLogTables).
  await migrateLogTables(adapter);
  logger.addAdapter(adapter);
  logger.info('log lines are now written to the log table as well as the console', {
    component: 'web/instrumentation',
  });
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
    logger.error(
      'the migration status could not be read; a schema behind this build would go unreported: {error}',
      {
        component: 'web/instrumentation',
        error: status.error,
      }
    );
    return;
  }

  if (status.pending.length === 0) {
    logger.info('the database schema is up to date with this build', {
      component: 'web/instrumentation',
      applied: status.applied,
    });
    return;
  }

  logger.error(
    'DATABASE SCHEMA IS BEHIND THIS BUILD: {count} migration(s) pending; requests touching the new schema fail and /api/health answers 503 until {action} is run',
    {
      component: 'web/instrumentation',
      count: status.pending.length,
      pending: status.pending.join(', '),
      applied: status.applied,
      action: MIGRATION_COMMAND,
      consequence:
        'Requests touching the new schema will fail until this is run. /api/health reports 503.',
    }
  );
}
