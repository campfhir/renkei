import { createWorkerLogger } from '@renkei/worker-kit/logger';
import packageJson from '../package.json';

/**
 * This worker's identity, handed to the shared factory
 * (@renkei/worker-kit's createWorkerLogger). Kept as its own file so
 * jest.config.js's `^\\./logger$` mapping can swap in
 * test-support/logger-mock.ts, the way every egress worker does.
 */
export const { logger, attachPersistentLogging } = createWorkerLogger({
  component: 'worker-delegate',
  applicationName: packageJson.name,
  applicationVersion: packageJson.version,
});
