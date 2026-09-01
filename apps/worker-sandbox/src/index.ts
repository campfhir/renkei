/**
 * The Renkei sandbox worker — the process that owns the agent scratch
 * space's disk (see docs/sandbox-connector-design.md).
 *
 * File staging is the first place Renkei deliberately holds bytes at rest
 * outside a provider or a browser, so it runs HERE, isolated, instead of
 * inside web request handlers or the shared queue workers — the same
 * reasoning that put SMB/SFTP in apps/worker-fileshares and OnBase egress
 * in apps/worker-onbase. The web app and its MCP tools call this process
 * over bearer-authenticated HTTP (SANDBOX_WORKER_URL on the web side).
 *
 * Env contract:
 *   SANDBOX_WORKER_API_KEY — required; comma-separated bearer keys the web
 *     app must present (rotation overlaps like LOG_SHIP_API_KEY).
 *   SANDBOX_WORKER_PORT    — listen port, default 8092.
 *   SANDBOX_DATA_DIR       — where staged files live on disk, default /data.
 *   DATABASE_URL           — the shared Postgres, for file metadata.
 */

import { closeDatabase, getDatabase } from '@renkei/db';
import { ensureDataRoot } from './disk';
import { createSandboxServer } from './server';
import { logger, attachPersistentLogging } from './logger';

function fatal(message: string): never {
  console.error(`FATAL [worker-sandbox]: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  await attachPersistentLogging();

  const apiKeys = (process.env.SANDBOX_WORKER_API_KEY ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
  if (apiKeys.length === 0) {
    fatal('SANDBOX_WORKER_API_KEY is required (comma-separated bearer keys)');
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) fatal(`database unavailable: ${String(dbResult.err)}`);

  await ensureDataRoot();

  const port = Number(process.env.SANDBOX_WORKER_PORT ?? '8092');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    fatal(`SANDBOX_WORKER_PORT is not a usable port: ${process.env.SANDBOX_WORKER_PORT}`);
  }

  const server = createSandboxServer({ db: dbResult.val, apiKeys });
  server.listen(port, '0.0.0.0', () => {
    logger.info('started {application} {version} on port {port}', {
      component: 'worker-sandbox/server',
      port,
    });
  });

  const shutdown = (signal: string): void => {
    logger.info('{signal} received, closing', { component: 'worker-sandbox/server', signal });
    server.close(() => {
      void (async () => {
        await logger.flush();
        await closeDatabase();
        process.exit(0);
      })();
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void main();
