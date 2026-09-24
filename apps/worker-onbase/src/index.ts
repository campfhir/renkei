/**
 * The Renkei OnBase worker — the process that dials a customer's on-prem
 * OnBase API Server and Hyland IdP (see docs/onbase-connector-design.md).
 *
 * Those hosts usually live in private address space that the web app's
 * SSRF guard refuses by design, so every byte to or from them travels
 * through THIS process: OIDC discovery, the PKCE token exchange, token
 * refresh, Document API calls and content. The web app and its MCP tools
 * reach it over bearer-authenticated HTTP (ONBASE_WORKER_URL on the web
 * side). The worker holds no tokens: per-user access tokens ride each
 * request, and the only secret it reads is the tenant's connector config.
 *
 * Env contract:
 *   ONBASE_WORKER_API_KEY — required; comma-separated bearer keys the web
 *     app must present (rotation overlaps like LOG_SHIP_API_KEY).
 *   ONBASE_WORKER_PORT    — listen port, default 8091.
 *   TOKEN_ENCRYPTION_KEY  — same key the web app holds; opens the stored
 *     connector configuration (IdP client secret).
 *   DATABASE_URL          — the shared Postgres, for connector config and
 *     org limits.
 */

import { runWorker } from '@renkei/worker-kit';
import { createOnBaseServer } from './server';
import { logger, attachPersistentLogging } from './logger';

void runWorker({
  name: 'worker-onbase',
  envPrefix: 'ONBASE_WORKER',
  defaultPort: 8091,
  logger,
  attachPersistentLogging,
  createServer: ({ encryptionKey, apiKeys }) => createOnBaseServer({ encryptionKey, apiKeys }),
});
