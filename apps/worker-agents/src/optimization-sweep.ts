/**
 * Optimization hygiene — the draft sweep's twin (draft-sweep.ts).
 *
 * A pass is claimed by flipping `queued` → `running`; a process that dies
 * mid-analysis leaves a row nothing can claim again, so a `running` row
 * past a generous deadline is FAILED with a message that says so. And
 * reports accumulate: they quote step names and error messages, so they
 * are pruned rather than kept forever — the newest one is all the agent
 * page ever shows.
 */

import { getDataStore } from '@renkei/db';
import { logger } from './logger';

export const OPTIMIZATION_SWEEP_INTERVAL_MS = 5 * 60_000;

/** Past the worst honest case: one long model call under a 20-minute token. */
const STUCK_MINUTES = 25;

const RETENTION_DAYS = 60;
const RETENTION_BATCH = 500;

export function createOptimizationSweep() {
  return async function sweep(): Promise<void> {
    const store = getDataStore().agentOptimizations;
    const now = Date.now();
    const rescued = await store.failStuck(
      new Date(now - STUCK_MINUTES * 60_000),
      'The analysis stopped unexpectedly and did not finish. Try again.'
    );
    if (rescued > 0) {
      logger.warn('failed {count} optimization(s) stuck mid-flight', {
        component: 'worker-agents/optimization-sweep',
        count: rescued,
      });
    }

    const pruned = await store.pruneBefore(
      new Date(now - RETENTION_DAYS * 86_400_000),
      RETENTION_BATCH
    );
    if (pruned > 0) {
      logger.info('retention pruned {count} optimization(s)', {
        component: 'worker-agents/optimization-sweep',
        count: pruned,
      });
    }
  };
}
