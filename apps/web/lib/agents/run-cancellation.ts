/**
 * The human half of stopping a run: requesting it. Deciding it belongs to
 * the ENGINE alone (see approvals.ts's header, the same rule) — this file
 * never writes `agent_runs.status`. It writes `cancel_requested_at`, a
 * one-way flag, and for a run with no active executor (queued or waiting)
 * wakes one the same way an approval decision does. A `running` run needs
 * no wake: it is already inside its one continuous executeRun call, and
 * that call notices the flag itself between steps — see engine.ts's
 * per-step checkpoint.
 *
 * The route and the MCP tool are both callers, so the semantics live here
 * once, same reasoning as decideApproval/answerQuestion.
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { QueueProducer } from '@renkei/queue';

export type RequestCancelRunResult =
  | { outcome: 'canceling' }
  | { outcome: 'already-final'; status: string }
  | { outcome: 'not-found' };

export async function requestRunCancellation(
  db: Kysely<DB>,
  producer: QueueProducer,
  input: {
    tenantId: string;
    agentId: string;
    runId: string;
    /** The run's owner_subject — whose grants it acts under. */
    ownerSubject: string;
    /** Who clicked cancel — the owner, or a grantee troubleshooting for them. */
    canceledBySubject: string;
  }
): Promise<RequestCancelRunResult> {
  const run = await db
    .selectFrom('agent_runs')
    .select(['id', 'status'])
    .where('id', '=', input.runId)
    .where('tenant_id', '=', input.tenantId)
    .where('agent_id', '=', input.agentId)
    .where('owner_subject', '=', input.ownerSubject)
    .executeTakeFirst();
  if (!run) return { outcome: 'not-found' };
  if (
    run.status === 'succeeded' ||
    run.status === 'failed' ||
    run.status === 'stopped' ||
    run.status === 'canceled'
  ) {
    return { outcome: 'already-final', status: run.status };
  }

  // The one-way claim: first request wins, a repeat click or a second
  // caller racing it is a no-op rather than a second wake.
  const claimed = await db
    .updateTable('agent_runs')
    .set({
      cancel_requested_at: sql`NOW()`,
      cancel_requested_by: input.canceledBySubject,
      updated_at: sql`NOW()`,
    })
    .where('id', '=', input.runId)
    .where('cancel_requested_at', 'is', null)
    .where('status', 'in', ['queued', 'running', 'waiting'])
    .executeTakeFirst();
  if (Number(claimed.numUpdatedRows ?? 0) === 0) {
    // Already requested, or it reached a terminal status in the gap above
    // — either way there is nothing more for this call to do.
    return { outcome: 'canceling' };
  }

  // Queued and waiting runs have no worker actively driving them right
  // now — wake one, exactly the way an approval decision does, so the
  // flag gets noticed promptly instead of at the next unrelated poll.
  if (run.status === 'queued' || run.status === 'waiting') {
    await producer.enqueue({
      tenantId: input.tenantId,
      source: `agents:${input.agentId}`,
      type: 'run',
      payload: { runId: input.runId },
      orderingKey: `agent:${input.agentId}`,
    });
  }

  return { outcome: 'canceling' };
}
