/**
 * The Renkei ADManager Plus worker — the process that dials an
 * organization's ManageEngine ADManager Plus servers (see
 * docs/admanager-connector-design.md).
 *
 * Those servers usually live in private address space that the web app's
 * SSRF guard refuses by design, so every byte to or from them travels
 * through THIS process. The web app and its MCP tools reach it over
 * bearer-authenticated HTTP (ADMANAGER_WORKER_URL on the web side). This
 * is also the only process that decrypts a person's stored ADManager
 * Plus authtoken outside the save path.
 *
 * Env contract:
 *   ADMANAGER_WORKER_API_KEY — required; comma-separated bearer keys the
 *     web app must present (rotation overlaps like LOG_SHIP_API_KEY).
 *   ADMANAGER_WORKER_PORT    — listen port, default 8095.
 *   TOKEN_ENCRYPTION_KEY     — same key the web app holds; opens the
 *     stored instance credentials.
 *   DATABASE_URL             — the shared Postgres, for the instance
 *     registry and connections.
 */

import { parseEncryptionKey } from '@renkei/crypto';
import { closeDatabase, getDatabase } from '@renkei/db';
import { createAdManagerServer } from './server';
import { logger, attachPersistentLogging } from './logger';
import { watchLogLevel } from '@renkei/settings';

function fatal(message: string): never {
  console.error(`FATAL [worker-admanager]: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  await attachPersistentLogging();
  // CONSOLE_LOG_LEVEL/LOG_DB_LEVEL only set the level for the few seconds
  // before the database is reachable; once it is, the org `logLevel` dial
  // (packages/settings) governs, polled and reapplied here so a saved
  // change takes effect without restarting this process.
  watchLogLevel(logger);

  const apiKeys = (process.env.ADMANAGER_WORKER_API_KEY ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
  if (apiKeys.length === 0) {
    fatal('ADMANAGER_WORKER_API_KEY is required (comma-separated bearer keys)');
  }

  const key = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!key.ok) {
    fatal('TOKEN_ENCRYPTION_KEY must be 32 bytes base64 (openssl rand -base64 32)');
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) fatal(`database unavailable: ${String(dbResult.err)}`);

  const port = Number(process.env.ADMANAGER_WORKER_PORT ?? '8095');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    fatal(`ADMANAGER_WORKER_PORT is not a usable port: ${process.env.ADMANAGER_WORKER_PORT}`);
  }

  const server = createAdManagerServer({
    db: dbResult.val,
    encryptionKey: key.val,
    apiKeys,
  });
  server.listen(port, '0.0.0.0', () => {
    logger.info('started {application} {version} on port {port}', {
      component: 'worker-admanager/server',
      port,
    });
  });

  const shutdown = (signal: string): void => {
    logger.info('{signal} received, closing', { component: 'worker-admanager/server', signal });
    server.close(() => {
      void (async () => {
        await logger.flush();
        await closeDatabase();
        process.exit(0);
      })();
    });
    // In-flight requests are bounded by this server's own upstream
    // timeouts; if close() cannot drain within that horizon something is
    // wedged and the container's stop timeout should win.
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void main();
