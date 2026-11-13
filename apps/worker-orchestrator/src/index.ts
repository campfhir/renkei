/**
 * The sandbox orchestrator — the process that makes, suspends, resumes
 * and removes sandboxes (docs/sandbox-orchestrator-design.md), and the
 * only one that holds the means to: the Docker engine's socket locally,
 * the sandbox group's identity on Azure. It runs nobody's code.
 *
 * WHERE sandboxes are made, how large they are, when they are suspended
 * and evicted, and what each is started with are the organization's own
 * configuration: one sealed row an operator edits under Organization →
 * Sandboxes, read here and picked up again when it changes (host.ts,
 * stored.ts). Nothing of that is in this process's environment.
 *
 * Callers (the web app, the queue worker) ask it where a scope's sandbox
 * is before each call (server.ts); a timer applies the idle rules and
 * the housekeeping (the orchestrator's `sweep`). Any number of these may
 * run: every decision is a compare-and-set on the `sandboxes` table.
 *
 * Env contract — only what this process needs before it can read the
 * database, and the two keys it shares with its callers:
 *   DATABASE_URL                 — the shared Postgres.
 *   TOKEN_ENCRYPTION_KEY         — opens the stored configuration's
 *     secrets, as it does every connector's.
 *   SANDBOX_ORCHESTRATOR_API_KEY — required; comma-separated bearer keys
 *     callers present.
 *   SANDBOX_WORKER_API_KEY       — required; the deployment's sandbox
 *     key. Each sandbox's own key is derived from it, so it is never
 *     handed to a sandbox.
 *   SANDBOX_ORCHESTRATOR_PORT    — listen port, default 8097.
 *   SANDBOX_SWEEP_SECONDS        — how often the idle rules run, default 30.
 *   SANDBOX_DEPLOYMENT           — names this deployment among others
 *     sharing an engine or a sandbox group, default `renkei`.
 */

import { getConnectorConfig } from '@renkei/connector-config';
import { loadKeyring } from '@renkei/crypto';
import { checkDataStore, closeDataStore, getDataStore } from '@renkei/db';
import { SANDBOX_ORCHESTRATOR_CONNECTOR } from '@renkei/sandbox-client';
import { watchLogLevel } from '@renkei/settings';
import { schedulePeriodicSweep } from '@renkei/worker-loop';
import { archiveBlobsOf, archiveRetentionMs, organizationBlobStore } from './archive-blobs';
import { OrchestratorHost } from './host';
import { createOrchestratorServer } from './server';
import { checkStored, type StoredRow } from './stored';
import { attachPersistentLogging, logger } from './logger';

const COMPONENT = 'worker-orchestrator';

function fatal(message: string): never {
  console.error(`FATAL [worker-orchestrator]: ${JSON.stringify(message)}`);
  process.exit(1);
}

function keys(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
}

async function main(): Promise<void> {
  await attachPersistentLogging();
  watchLogLevel(logger);

  const apiKeys = keys('SANDBOX_ORCHESTRATOR_API_KEY');
  if (apiKeys.length === 0) {
    fatal('SANDBOX_ORCHESTRATOR_API_KEY is required (comma-separated bearer keys)');
  }
  // The first key is the one sandboxes' keys are derived from; a rotation
  // of it gives every sandbox made afterwards a new key.
  const masterKey = keys('SANDBOX_WORKER_API_KEY')[0];
  if (!masterKey) fatal('SANDBOX_WORKER_API_KEY is required (the deployment’s sandbox key)');

  const encryptionKey = loadKeyring('TOKEN_ENCRYPTION_KEY');
  if (!encryptionKey.ok) {
    fatal(
      'TOKEN_ENCRYPTION_KEY must be 32 bytes base64: it opens the stored sandbox configuration'
    );
  }

  const ready = checkDataStore();
  if (!ready.ok) fatal(`database unavailable: ${String(ready.err)}`);

  const portEnv = process.env.SANDBOX_ORCHESTRATOR_PORT;
  const port = Number(portEnv ?? '8097');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    fatal(`SANDBOX_ORCHESTRATOR_PORT is not a usable port: ${portEnv}`);
  }
  const sweepSeconds = Number(process.env.SANDBOX_SWEEP_SECONDS ?? '30');
  if (!Number.isFinite(sweepSeconds) || sweepSeconds <= 0) {
    fatal(`SANDBOX_SWEEP_SECONDS is not a usable interval: ${process.env.SANDBOX_SWEEP_SECONDS}`);
  }

  /** The organization's stored configuration, secrets opened. */
  const read = async (): Promise<StoredRow | null> => {
    const row = await getConnectorConfig(SANDBOX_ORCHESTRATOR_CONNECTOR, encryptionKey.val);
    if (!row.ok) throw new Error(`the stored configuration could not be read (${row.err.type})`);
    return row.val
      ? { enabled: row.val.enabled, settings: row.val.settings, secrets: row.val.secrets }
      : null;
  };

  const host = new OrchestratorHost({
    read,
    masterKey,
    logger,
    archives: {
      store: () => getDataStore().sandboxArchives,
      blobs: archiveBlobsOf(organizationBlobStore),
      retentionMs: archiveRetentionMs,
    },
  });
  await host.reload();
  host.start();

  const stopSweep = schedulePeriodicSweep(
    logger,
    'sandbox lifecycle',
    `${COMPONENT}/sweep`,
    sweepSeconds * 1000,
    async () => {
      const orchestrator = host.maybe();
      if (!orchestrator) return;
      const report = await orchestrator.sweep();
      const acted =
        report.suspended +
        report.removed +
        report.recovered +
        report.orphans +
        report.archivesExpired +
        report.failures;
      if (acted > 0) {
        logger.info(
          'sandbox sweep: {suspended} suspended, {removed} evicted ({archived} archived first), {recovered} recovered, {orphans} machines without a record removed, {archivesExpired} old archives dropped, {failures} failed',
          { component: `${COMPONENT}/sweep`, ...report }
        );
      }
    }
  );

  const server = createOrchestratorServer({
    apiKeys,
    orchestrator: () => host.current(),
    status: () => host.status(),
    store: () => getDataStore().sandboxes,
    check: async (candidate) => {
      const row = candidate ? { enabled: true, ...candidate } : await read();
      if (!row) {
        return { ok: false, detail: 'Nothing is configured yet: save the sandbox setup first.' };
      }
      return checkStored(row);
    },
  });
  server.listen(port, '0.0.0.0', () => {
    const status = host.status();
    logger.info('started {application} {version}, listening on port {port}; {state}', {
      component: `${COMPONENT}/server`,
      port,
      state: status.problem
        ? `no sandbox can be made yet: ${status.problem}`
        : `sandboxes are made by ${status.provider}`,
    });
  });

  const shutdown = (signal: string): void => {
    logger.info('received {signal}; closing the server, then stopping', {
      component: `${COMPONENT}/server`,
      signal,
    });
    stopSweep();
    host.stop();
    // Sandboxes are left as they are: the next orchestrator carries on from the table.
    server.close(() => {
      void (async () => {
        await logger.flush();
        await closeDataStore();
        process.exit(0);
      })();
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void main();
