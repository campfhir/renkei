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
 *   ADMANAGER_PRODUCT_NAME   — optional; the PRODUCT_NAME the legacy
 *     /RestAPI/* endpoints (unlock, reset-password, create, group
 *     membership) identify this caller as. Defaults to 'Renkei'.
 */

import { runWorker } from '@renkei/worker-kit';
import { createAdManagerServer } from './server';
import { logger, attachPersistentLogging } from './logger';

void runWorker({
  name: 'worker-admanager',
  envPrefix: 'ADMANAGER_WORKER',
  defaultPort: 8095,
  logger,
  attachPersistentLogging,
  createServer: ({ db, encryptionKey, apiKeys }) =>
    createAdManagerServer({
      db,
      encryptionKey,
      apiKeys,
      legacyProductName: process.env.ADMANAGER_PRODUCT_NAME,
    }),
});
