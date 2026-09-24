import { createWorkerLogger } from '@renkei/worker-kit/logger';
import packageJson from '../package.json';

/**
 * This worker's identity, handed to the shared factory
 * (@renkei/worker-kit's createWorkerLogger) — see that package for the
 * console + Postgres/HTTP persistence logic itself, which is the same
 * across every egress worker.
 *
 * Kept as this worker's own file, rather than called inline from
 * index.ts, so jest.config.js's `^\\./logger$` mapping keeps swapping in
 * test-support/logger-mock.ts unchanged (the real logger reaches the
 * bored-logs Postgres adapter, which reaches ESM-only kysely helpers
 * jest cannot parse).
 */
export const { logger, attachPersistentLogging } = createWorkerLogger({
  component: 'worker-onbase',
  applicationName: packageJson.name,
  applicationVersion: packageJson.version,
});
