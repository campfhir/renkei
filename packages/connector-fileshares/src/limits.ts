/**
 * Bounds on what one process will do to a file server.
 *
 * A NAS is not a SaaS API: it has no 429s, no per-app quotas, and often no
 * headroom — an agent loop that opens forty SMB sessions can genuinely
 * degrade a share other people are using. Three bounds compose here:
 *
 *   - the lane limiter (same shape as every connector client) keeps
 *     interactive callers ahead of background sweeps;
 *   - a per-share connection cap holds concurrent sessions to a handful,
 *     queueing the rest instead of stacking sockets;
 *   - per-operation timeouts turn a wedged server into a typed 'timeout'
 *     error instead of a hung tool call.
 */

import { LaneLimiter, type RequestLane } from '@renkei/rate-limit';

export const CONNECT_TIMEOUT_MS = 10_000;
export const OP_TIMEOUT_MS = 15_000;
export const TRANSFER_TIMEOUT_MS = 60_000;

/** Concurrent protocol sessions per share; excess callers wait their turn. */
const MAX_SESSIONS_PER_SHARE = 4;

export const fileshareLimiter = new LaneLimiter({
  interactive: { capacity: 10, refillPerSecond: 5 },
  background: { capacity: 4, refillPerSecond: 2 },
});

const sessionCounts = new Map<string, { active: number; waiters: Array<() => void> }>();

async function acquireSession(shareId: string): Promise<void> {
  const state = sessionCounts.get(shareId) ?? { active: 0, waiters: [] };
  sessionCounts.set(shareId, state);
  if (state.active < MAX_SESSIONS_PER_SHARE) {
    state.active += 1;
    return;
  }
  await new Promise<void>((resolve) => {
    state.waiters.push(resolve);
  });
  state.active += 1;
}

function releaseSession(shareId: string): void {
  const state = sessionCounts.get(shareId);
  if (!state) return;
  state.active = Math.max(0, state.active - 1);
  const next = state.waiters.shift();
  if (next) next();
  if (state.active === 0 && state.waiters.length === 0) sessionCounts.delete(shareId);
}

/**
 * Run one backend session under all three bounds. The session slot is held
 * for the whole callback so "open, operate, close" counts as one session,
 * not one slot per operation.
 */
export async function withSessionLimits<T>(
  shareId: string,
  lane: RequestLane,
  work: () => Promise<T>
): Promise<T> {
  await fileshareLimiter.take(lane);
  await acquireSession(shareId);
  try {
    return await work();
  } finally {
    releaseSession(shareId);
  }
}

export class OperationTimeout extends Error {
  constructor(operation: string, ms: number) {
    super(`${operation} timed out after ${ms}ms`);
    this.name = 'OperationTimeout';
  }
}

/**
 * Race a protocol promise against a deadline. The underlying library call
 * is not cancellable; the caller must close the session afterwards so an
 * eventually-completing operation cannot act on a connection someone else
 * is now using.
 */
export async function withTimeout<T>(operation: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new OperationTimeout(operation, ms)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
