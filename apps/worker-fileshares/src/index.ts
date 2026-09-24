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

import { runWorker } from '@renkei/worker-kit';
import { createFileshareServer } from './server';
import { logger, attachPersistentLogging } from './logger';

void runWorker({
  name: 'worker-fileshares',
  envPrefix: 'FILESHARES_WORKER',
  defaultPort: 8090,
  logger,
  attachPersistentLogging,
  createServer: ({ db, encryptionKey, apiKeys }) =>
    createFileshareServer({ db, encryptionKey, apiKeys }),
});
