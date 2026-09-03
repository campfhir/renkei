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
 *   SANDBOX_BROWSER_ENABLED — `true` to run the headless browser behind the
 *     sandbox_browser_* tools (see browser.ts); anything else, or unset,
 *     answers every browser verb "not enabled" — closed, never open.
 *   SANDBOX_BROWSER_EXECUTABLE — optional Chromium binary; by default
 *     playwright-core resolves its own installed headless shell.
 */

import { closeDatabase, getDatabase } from '@renkei/db';
import { ensureDataRoot } from './disk';
import { createSandboxServer } from './server';
import { BrowserSessions } from './browser';
import { SecretVault } from './secret-vault';
import { createSecretResolver } from './secrets';
import { logger, attachPersistentLogging } from './logger';

function envFlag(name: string): boolean {
  return /^(1|true|yes|on)$/i.test((process.env[name] ?? '').trim());
}

function fatal(message: string): never {
  console.error(`FATAL [worker-sandbox]: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  await attachPersistentLogging();

  // A rejection nobody awaited must not take the whole worker — and every
  // browser session and unlocked secret — down with it; log it and carry
  // on. A genuinely uncaught exception still exits (the process may be in
  // no state to continue), but says so first, so a restart is explained.
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection: {error}', {
      component: 'worker-sandbox/process',
      error: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
    });
  });
  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception, exiting: {error}', {
      component: 'worker-sandbox/process',
      error: error.stack ?? error.message,
    });
    void logger.flush().finally(() => process.exit(1));
  });

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

  // The browser launches lazily on the first navigate, so enabling it costs
  // nothing until an agent actually opens a page. The secret vault is the
  // one place a browser secret's key exists — in memory, until its unlock
  // window closes or this process exits.
  const vault = new SecretVault();
  const browser = envFlag('SANDBOX_BROWSER_ENABLED')
    ? new BrowserSessions({ secrets: createSecretResolver(dbResult.val, vault) })
    : null;

  const server = createSandboxServer({ db: dbResult.val, apiKeys, browser, vault });
  server.listen(port, '0.0.0.0', () => {
    logger.info('started {application} {version} on port {port} (browser {browser})', {
      component: 'worker-sandbox/server',
      port,
      browser: browser ? 'enabled' : 'disabled',
    });
  });

  const shutdown = (signal: string): void => {
    logger.info('{signal} received, closing', { component: 'worker-sandbox/server', signal });
    server.close(() => {
      void (async () => {
        await browser?.shutdown();
        vault.close();
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
