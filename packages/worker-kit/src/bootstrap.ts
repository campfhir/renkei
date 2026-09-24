import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { Server } from 'node:http';
import { parseEncryptionKey } from '@renkei/crypto';
import { closeDatabase, getDatabase } from '@renkei/db';
import { watchLogLevel } from '@renkei/settings';
import type { WorkerLogger } from './logger';

/**
 * Every egress worker's `main()`: read the bearer keys and encryption key
 * off env, reach the shared Postgres, pick a port, build the server, listen,
 * and drain on SIGTERM/SIGINT. Hand-copied into worker-mirth, worker-onbase,
 * worker-admanager and worker-fileshares before this, differing only in the
 * worker's name, its env var prefix, and its default port — `runWorker` is
 * that same body taking those three as parameters.
 *
 * What stays in each worker's own index.ts: the doc comment explaining
 * what THIS worker dials and why, the `createXServer` import, and the
 * `logger`/`attachPersistentLogging` pair from that worker's own thin
 * `./logger.ts` (itself a `createWorkerLogger` call) — kept as real,
 * separate files rather than re-exported through here so each worker's
 * jest config can go on mapping the relative `./logger` import to its
 * silent test-support mock, unchanged.
 */
export interface WorkerServerDeps {
  db: Kysely<DB>;
  encryptionKey: Buffer;
  apiKeys: string[];
}

export interface RunWorkerOptions {
  /** e.g. 'worker-admanager' — stamped on log lines and fatal-error prefixes. */
  name: string;
  /** e.g. 'ADMANAGER_WORKER' — this worker's env var prefix: `${envPrefix}_API_KEY`, `${envPrefix}_PORT`. */
  envPrefix: string;
  defaultPort: number;
  /** The exact object `createWorkerLogger` returned — bound to THIS worker's
   *  own `application`/`version` attributes, so `logger.info('… {application}
   *  {version} …', …)` below doesn't need to repeat them per call. */
  logger: WorkerLogger['logger'];
  attachPersistentLogging: () => Promise<void>;
  createServer: (deps: WorkerServerDeps) => Server;
}

export async function runWorker(options: RunWorkerOptions): Promise<void> {
  const { name, envPrefix, logger } = options;

  function fatal(message: string): never {
    console.error(`FATAL [${name}]: ${message}`);
    process.exit(1);
  }

  await options.attachPersistentLogging();
  // CONSOLE_LOG_LEVEL/LOG_DB_LEVEL only set the level for the few seconds
  // before the database is reachable; once it is, the org `logLevel` dial
  // (packages/settings) governs, polled and reapplied here so a saved
  // change takes effect without restarting this process.
  watchLogLevel(logger);

  const apiKeys = (process.env[`${envPrefix}_API_KEY`] ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
  if (apiKeys.length === 0) {
    fatal(`${envPrefix}_API_KEY is required (comma-separated bearer keys)`);
  }

  const key = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!key.ok) {
    fatal('TOKEN_ENCRYPTION_KEY must be 32 bytes base64 (openssl rand -base64 32)');
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) fatal(`database unavailable: ${String(dbResult.err)}`);

  const portEnv = process.env[`${envPrefix}_PORT`];
  const port = Number(portEnv ?? String(options.defaultPort));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    fatal(`${envPrefix}_PORT is not a usable port: ${portEnv}`);
  }

  const server = options.createServer({ db: dbResult.val, encryptionKey: key.val, apiKeys });
  server.listen(port, '0.0.0.0', () => {
    logger.info('started {application} {version} on port {port}', {
      component: `${name}/server`,
      port,
    });
  });

  const shutdown = (signal: string): void => {
    logger.info('{signal} received, closing', { component: `${name}/server`, signal });
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
