/**
 * The Renkei Mirth worker — the process that dials an organization's Mirth
 * Connect (NextGen Connect 4.5.2) servers (see
 * docs/mirth-connector-design.md).
 *
 * Those servers usually live in private address space that the web app's
 * SSRF guard refuses by design, so every byte to or from them travels
 * through THIS process: the login, the session, and every REST call. The
 * web app and its MCP tools reach it over bearer-authenticated HTTP
 * (MIRTH_WORKER_URL on the web side). This is also the only process that
 * decrypts a person's stored Mirth credential outside the save path — the
 * password and the socket live and die together.
 *
 * Env contract:
 *   MIRTH_WORKER_API_KEY — required; comma-separated bearer keys the web
 *     app must present (rotation overlaps like LOG_SHIP_API_KEY).
 *   MIRTH_WORKER_PORT    — listen port, default 8093.
 *   TOKEN_ENCRYPTION_KEY — same key the web app holds; opens the stored
 *     instance credentials.
 *   DATABASE_URL         — the shared Postgres, for the instance registry
 *     and connections.
 */

import { parseEncryptionKey } from '@renkei/crypto';
import { closeDatabase, getDatabase } from '@renkei/db';
import { createMirthServer } from './server';
import { logger, attachPersistentLogging } from './logger';

function fatal(message: string): never {
  console.error(`FATAL [worker-mirth]: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  await attachPersistentLogging();

  const apiKeys = (process.env.MIRTH_WORKER_API_KEY ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
  if (apiKeys.length === 0) {
    fatal('MIRTH_WORKER_API_KEY is required (comma-separated bearer keys)');
  }

  const key = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!key.ok) {
    fatal('TOKEN_ENCRYPTION_KEY must be 32 bytes base64 (openssl rand -base64 32)');
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) fatal(`database unavailable: ${String(dbResult.err)}`);

  const port = Number(process.env.MIRTH_WORKER_PORT ?? '8093');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    fatal(`MIRTH_WORKER_PORT is not a usable port: ${process.env.MIRTH_WORKER_PORT}`);
  }

  const server = createMirthServer({
    db: dbResult.val,
    encryptionKey: key.val,
    apiKeys,
  });
  server.listen(port, '0.0.0.0', () => {
    logger.info('started {application} {version} on port {port}', {
      component: 'worker-mirth/server',
      port,
    });
  });

  const shutdown = (signal: string): void => {
    logger.info('{signal} received, closing', { component: 'worker-mirth/server', signal });
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
