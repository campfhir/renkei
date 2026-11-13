/**
 * The sandbox worker's entry. In a sandbox the orchestrator made, the
 * worker's secrets and its data store are fetched and set up first
 * (sealed-boot.ts) — before the worker's own modules, which read the
 * environment as they load, are loaded at all. Then the worker itself
 * starts (worker-main.ts, which says what it is and what it reads).
 */

import { sealedBoot } from './sealed-boot';

try {
  await sealedBoot({ env: process.env });
} catch (error) {
  console.error(
    `FATAL [worker-sandbox]: ${JSON.stringify(error instanceof Error ? error.message : String(error))}`
  );
  process.exit(1);
}
await import('./worker-main');
