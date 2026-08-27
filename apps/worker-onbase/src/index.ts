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

import { parseEncryptionKey } from '@renkei/crypto';
import { closeDatabase, getDatabase } from '@renkei/db';
import { createOnBaseServer } from './server';
import { logger, attachPersistentLogging } from './logger';

function fatal(message: string): never {
  console.error(`FATAL [worker-onbase]: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  await attachPersistentLogging();

  const apiKeys = (process.env.ONBASE_WORKER_API_KEY ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
  if (apiKeys.length === 0) {
    fatal('ONBASE_WORKER_API_KEY is required (comma-separated bearer keys)');
  }

  const key = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!key.ok) {
    fatal('TOKEN_ENCRYPTION_KEY must be 32 bytes base64 (openssl rand -base64 32)');
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) fatal(`database unavailable: ${String(dbResult.err)}`);

  const port = Number(process.env.ONBASE_WORKER_PORT ?? '8091');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    fatal(`ONBASE_WORKER_PORT is not a usable port: ${process.env.ONBASE_WORKER_PORT}`);
  }

  const server = createOnBaseServer({
    encryptionKey: key.val,
    apiKeys,
  });
  server.listen(port, '0.0.0.0', () => {
    logger.info('started {application} {version} on port {port}', {
      component: 'worker-onbase/server',
      port,
    });
  });

  const shutdown = (signal: string): void => {
    logger.info('{signal} received, closing', { component: 'worker-onbase/server', signal });
    server.close(() => {
      void (async () => {
        await logger.flush();
        await closeDatabase();
        process.exit(0);
      })();
    });
    // In-flight requests are bounded by this server's own fetch timeouts; if
    // close() cannot drain within that horizon something is wedged and the
    // container's stop timeout should win.
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void main();
