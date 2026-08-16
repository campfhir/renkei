/**
 * This worker's binding of @renkei/worker-loop — the machinery moved to a
 * package when a third consumer process (apps/worker-agents) arrived, and
 * this module now only closes it over this process's logger so the two
 * dozen call sites and tests keep their signatures.
 */

import {
  createEventLoop as createSharedEventLoop,
  schedulePeriodicSweep as scheduleSharedSweep,
  type EventLoop,
  type EventLoopDeps as SharedEventLoopDeps,
} from '@renkei/worker-loop';
import type { ClaimedEvent } from './queue';
import { logger } from './logger';

export type { EventLoop } from '@renkei/worker-loop';

export type EventLoopDeps = Omit<SharedEventLoopDeps<ClaimedEvent>, 'logger'>;

export function createEventLoop(deps: EventLoopDeps): EventLoop {
  return createSharedEventLoop<ClaimedEvent>({ ...deps, logger });
}

export function schedulePeriodicSweep(
  label: string,
  component: string,
  intervalMs: number,
  sweep: () => Promise<void>
): () => void {
  return scheduleSharedSweep(logger, label, component, intervalMs, sweep);
}
