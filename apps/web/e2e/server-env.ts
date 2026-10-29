/**
 * The memory server's environment: what playwright.config.ts starts the
 * web app with, and what `pnpm e2e:build` (e2e/build.ts) builds it with,
 * so the build CI makes once and hands to each shard is the one a local
 * `CI=1` run makes.
 */

import path from 'node:path';
import {
  E2E_SETUP_SECRET,
  MEMORY_BASE_URL,
  MEMORY_DELEGATE_API_KEY,
  MEMORY_DELEGATE_URL,
  MEMORY_SEED_TOKEN,
  MEMORY_TOKEN_ENCRYPTION_KEY,
  SANDBOX_STUB_URL,
} from './constants';

const WEB = path.join(import.meta.dirname, '..');

export function memoryServerEnv(): Record<string, string> {
  return {
    RENKEI_DATA_STORE: 'memory',
    RENKEI_MEMORY_SEED_TOKEN: MEMORY_SEED_TOKEN,
    // The org's settings and connector configs are read fresh on every
    // request (production caches them for a minute in each server
    // bundle), so a switch a spec flips shows at once.
    RENKEI_CONFIG_CACHE_TTL_MS: '0',
    // The server starts its own delegate (lib/memory-delegate.ts) at
    // this URL with this key: named here, never made up at boot, since
    // `next dev` rebuilds and reloads every page when the environment
    // changes under it. The secrets key is the suite's fixed one,
    // which specs seal with too.
    DELEGATE_WORKER_URL: MEMORY_DELEGATE_URL,
    DELEGATE_WORKER_API_KEY: MEMORY_DELEGATE_API_KEY,
    TOKEN_ENCRYPTION_KEY: MEMORY_TOKEN_ENCRYPTION_KEY,
    // The in-process agents worker runs tools through this server's
    // own MCP endpoint (lib/memory-workers.ts).
    RENKEI_WEB_INTERNAL_URL: MEMORY_BASE_URL,
    // The sandbox stub stands in for the sandbox worker and the hosts' APIs.
    SANDBOX_WORKER_URL: SANDBOX_STUB_URL,
    SANDBOX_WORKER_API_KEY: 'e2e-sandbox-key',
    SETUP_SECRET: E2E_SETUP_SECRET,
    BITBUCKET_API_BASE_URL: `${SANDBOX_STUB_URL}/bitbucket/2.0`,
    GITHUB_API_BASE_URL: `${SANDBOX_STUB_URL}/github`,
    JIRA_ADMIN_API_BASE_URL: `${SANDBOX_STUB_URL}/jira`,
    JIRA_AUTOMATION_API_BASE_URL: `${SANDBOX_STUB_URL}/automation`,
    BLOB_STORE_PROVIDER: process.env.BLOB_STORE_PROVIDER ?? 'local',
    BLOB_STORE_LOCAL_DIR:
      process.env.BLOB_STORE_LOCAL_DIR ?? path.join(WEB, 'test-results', 'blobs'),
    ...(process.env.AZURE_BLOB_ACCOUNT
      ? { AZURE_BLOB_ACCOUNT: process.env.AZURE_BLOB_ACCOUNT }
      : {}),
    ...(process.env.AZURE_BLOB_KEY ? { AZURE_BLOB_KEY: process.env.AZURE_BLOB_KEY } : {}),
    ...(process.env.AZURE_BLOB_CONTAINER
      ? { AZURE_BLOB_CONTAINER: process.env.AZURE_BLOB_CONTAINER }
      : {}),
    ...(process.env.AZURE_BLOB_ENDPOINT
      ? { AZURE_BLOB_ENDPOINT: process.env.AZURE_BLOB_ENDPOINT }
      : {}),
  };
}
