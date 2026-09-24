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

import { runWorker } from '@renkei/worker-kit';
import { createMirthServer } from './server';
import { logger, attachPersistentLogging } from './logger';

void runWorker({
  name: 'worker-mirth',
  envPrefix: 'MIRTH_WORKER',
  defaultPort: 8093,
  logger,
  attachPersistentLogging,
  createServer: ({ db, encryptionKey, apiKeys }) =>
    createMirthServer({ db, encryptionKey, apiKeys }),
});
