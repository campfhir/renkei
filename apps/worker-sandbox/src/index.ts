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
 *   SANDBOX_WORKSPACES_ENABLED — `true` to serve code workspaces (a
 *     repository cloned here, commands run in it — see workspaces.ts);
 *     unset answers every workspace verb "not enabled". When enabled the
 *     process should run as root so each caller's commands can be dropped
 *     to their own uid (docker/sandbox-entrypoint.sh does exactly that);
 *     without root it still works, unisolated, and says so below.
 *   SANDBOX_WORKSPACES_DIR — where checkouts live, default /workspaces
 *     (its own volume, apart from the staged-file disk).
 *   SANDBOX_ENV_SECRETS_KEY — seals workspace environment secrets; falls
 *     back to TOKEN_ENCRYPTION_KEY, and without either the env verbs are
 *     closed.
 */

import { closeDatabase, getDatabase } from '@renkei/db';
import { ensureDataRoot, getDataRoot } from './disk';
import { createBrowserStateStore } from './browser-state';
import { createSecretKeyStore } from './secret-key-store';
import { canIsolateByUid, ensureWorkspacesRoot, verifyUidIsolation } from './workspaces';
import { envSecretsEnabled } from './env-secrets';
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

  const workspacesEnabled = envFlag('SANDBOX_WORKSPACES_ENABLED');
  if (workspacesEnabled) {
    // Nothing this process creates from here on is readable by the uids
    // a caller's commands run as: a staged file, a log, a lock.
    process.umask(0o077);
    await ensureWorkspacesRoot();
    if (!canIsolateByUid()) {
      logger.warn(
        'workspaces are enabled but this process is not root: commands run as the worker user with NO per-caller isolation — fine for one developer, wrong for a shared deployment',
        { component: 'worker-sandbox/workspaces' }
      );
    } else {
      // Root only so that each caller's commands can be dropped to their
      // own uid; if that drop cannot happen, the alternative is running
      // every caller's commands as root, which is not an option — so this
      // is fatal here, with the cause, rather than a failed spawn on
      // every command later.
      const problem = await verifyUidIsolation();
      if (problem) {
        fatal(
          `workspaces are enabled and this process is root, but a command cannot be dropped to a caller's uid: ${problem}. ` +
            'The sandbox image (docker/Dockerfile, target sandbox) supplies setpriv from util-linux, and the container needs CAP_SETUID, CAP_SETGID and CAP_SETPCAP (Docker grants them by default).'
        );
      }
    }
    if (!envSecretsEnabled()) {
      logger.warn(
        'workspaces are enabled without SANDBOX_ENV_SECRETS_KEY or TOKEN_ENCRYPTION_KEY: environment secrets are closed',
        { component: 'worker-sandbox/workspaces' }
      );
    }
  }

  const port = Number(process.env.SANDBOX_WORKER_PORT ?? '8092');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    fatal(`SANDBOX_WORKER_PORT is not a usable port: ${process.env.SANDBOX_WORKER_PORT}`);
  }

  // The browser launches lazily on the first navigate, so enabling it costs
  // nothing until an agent actually opens a page. The secret vault holds
  // a browser secret's key between an unlock and its expiry — on the
  // shared data disk, sealed, so every replica can type it and a restart
  // does not lock it; in this process's memory when there is no key to
  // seal with.
  const secretKeys = createSecretKeyStore(getDataRoot());
  if (!secretKeys) {
    logger.warn(
      'unlocked browser secrets live in this process only (no SANDBOX_ENV_SECRETS_KEY or TOKEN_ENCRYPTION_KEY to seal them on disk): another replica, or this one after a restart, sees them locked',
      { component: 'worker-sandbox/secrets' }
    );
  }
  const vault = new SecretVault({ store: secretKeys });
  let browser: BrowserSessions | null = null;
  if (envFlag('SANDBOX_BROWSER_ENABLED')) {
    // Sessions are kept on the data disk between calls so a replica that
    // did not open one can carry it on; sealed, so only with a key.
    const state = createBrowserStateStore(getDataRoot());
    if (!state) {
      logger.warn(
        'browser sessions live in this process only (no SANDBOX_ENV_SECRETS_KEY or TOKEN_ENCRYPTION_KEY to seal them on disk): a call that lands on another replica, or after a restart, starts over',
        { component: 'worker-sandbox/browser' }
      );
    }
    browser = new BrowserSessions({ secrets: createSecretResolver(dbResult.val, vault), state });
  }

  const server = createSandboxServer({
    db: dbResult.val,
    apiKeys,
    browser,
    vault,
    workspaces: workspacesEnabled,
  });
  server.listen(port, '0.0.0.0', () => {
    logger.info(
      'started {application} {version} on port {port} (browser {browser}, workspaces {workspaces})',
      {
        component: 'worker-sandbox/server',
        port,
        browser: browser ? 'enabled' : 'disabled',
        workspaces: workspacesEnabled
          ? canIsolateByUid()
            ? 'enabled, per-caller uids'
            : 'enabled, UNISOLATED'
          : 'disabled',
      }
    );
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
