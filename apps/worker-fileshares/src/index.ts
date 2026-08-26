/**
 * The Renkei fileshare worker — the process that owns every SMB/SFTP
 * session (see docs/fileshares-connector-design.md).
 *
 * File-share I/O is heavy and slow against servers that cannot defend
 * themselves, so it runs HERE, isolated, instead of inside web request
 * handlers: the web app and its MCP tools call this process over
 * bearer-authenticated HTTP (FILESHARES_WORKER_URL on the web side). This
 * is also the only process that decrypts share credentials outside the
 * admin save path — the ACL and the sockets live and die together.
 *
 * Env contract:
 *   FILESHARES_WORKER_API_KEY — required; comma-separated bearer keys the
 *     web app must present (rotation overlaps like LOG_SHIP_API_KEY).
 *   FILESHARES_WORKER_PORT    — listen port, default 8090.
 *   TOKEN_ENCRYPTION_KEY      — same key the web app holds; opens the
 *     stored share credentials.
 *   DATABASE_URL              — the shared Postgres, for ACL and settings.
 */

import { parseEncryptionKey } from '@renkei/crypto';
import { closeDatabase, getDatabase } from '@renkei/db';
import { createFileshareServer } from './server';
import { logger, attachPersistentLogging } from './logger';

function fatal(message: string): never {
  console.error(`FATAL [worker-fileshares]: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  await attachPersistentLogging();

  const apiKeys = (process.env.FILESHARES_WORKER_API_KEY ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
  if (apiKeys.length === 0) {
    fatal('FILESHARES_WORKER_API_KEY is required (comma-separated bearer keys)');
  }

  const key = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!key.ok) {
    fatal('TOKEN_ENCRYPTION_KEY must be 32 bytes base64 (openssl rand -base64 32)');
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) fatal(`database unavailable: ${String(dbResult.err)}`);

  const port = Number(process.env.FILESHARES_WORKER_PORT ?? '8090');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    fatal(`FILESHARES_WORKER_PORT is not a usable port: ${process.env.FILESHARES_WORKER_PORT}`);
  }

  const server = createFileshareServer({
    db: dbResult.val,
    encryptionKey: key.val,
    apiKeys,
  });
  server.listen(port, '0.0.0.0', () => {
    logger.info('started {application} {version} on port {port}', {
      component: 'worker-fileshares/server',
      port,
    });
  });

  const shutdown = (signal: string): void => {
    logger.info('{signal} received, closing', { component: 'worker-fileshares/server', signal });
    server.close(() => {
      void (async () => {
        await logger.flush();
        await closeDatabase();
        process.exit(0);
      })();
    });
    // In-flight SMB/SFTP sessions are bounded by the package's own
    // timeouts; if close() cannot drain within that horizon something is
    // wedged and the container's stop timeout should win.
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void main();
