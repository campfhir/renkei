/**
 * Re-queuing the runs that paused for a person's key.
 *
 * The agents engine parks a run as `waiting` with `error_kind =
 * 'needs-sign-in'` when its owner has no live key delegation at the
 * delegate (docs/delegate-key-design.md, phase 3): the run cannot read the
 * owner's tokens, so it waits rather than fails. The moment the owner is
 * delegated again — a sign-in, an enrollment, a renewed automation window
 * — every such run of theirs goes back to `queued` and the same bare
 * `{ runId }` message every other start uses is enqueued. The engine
 * rebuilds position from the step rows and continues where it stopped,
 * exactly as after a crash.
 *
 * A failed enqueue leaves the row `queued`: the stuck-run janitor fails
 * it with a clear note later, and the next sign-in re-queues nothing
 * (the row is no longer waiting), so a lost message is visible rather
 * than silently re-parked.
 */

import { getDataStore } from '@renkei/db';
import type { QueueProducer } from '@renkei/queue';

export const NEEDS_SIGN_IN = 'needs-sign-in';

/** Puts the owner's parked runs back on the queue; returns how many. */
export async function resumeRunsNeedingSignIn(
  producer: QueueProducer,
  ownerSubject: string
): Promise<number> {
  const rows = await getDataStore().agentRuns.requeueWaiting(ownerSubject, NEEDS_SIGN_IN);
  for (const row of rows) {
    await producer.enqueue({
      source: `agents:${row.agentId}`,
      type: 'run',
      payload: { runId: row.id },
      orderingKey: `agent:${row.agentId}`,
    });
  }
  return rows.length;
}
