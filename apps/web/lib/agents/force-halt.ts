/**
 * The admin escape hatch for a run the normal machinery will never close.
 *
 * `cancel_requested_at` (run-cancellation.ts) only reaches a LIVE executor —
 * a run whose worker has genuinely wedged (not crashed, not merely slow)
 * never rereads it. The stuck-run janitor (worker-agents/maintenance.ts)
 * closes an abandoned run automatically, but only once its agent_jobs row is
 * actually gone AND it has sat for two hours; a run whose row is still
 * 'processing' — a stale claim not yet reclaimed, or a reclaim that keeps
 * rehanging on the same bug — is invisible to it on purpose, so the janitor
 * never races a worker that is still alive. Restarting the container that
 * held the wedged process doesn't help either: the row only becomes
 * claimable once its lease goes stale, and a fresh worker will just rehang
 * on the same bug if the janitor's own reclaim would have.
 *
 * This is the deliberate exception to "run-status transitions belong to the
 * ENGINE alone" (run-cancellation.ts, approvals.ts): an operator override
 * for exactly the case that invariant can't reach, gated on ROLE_OPERATOR
 * by its only caller and always recorded as an admin action in the run's
 * error text — never silently indistinguishable from a normal cancel.
 *
 * It also clears the run's agent_jobs row, live or dead-lettered, so a
 * stale-claim reclaim or a later dead-letter requeue can never resume or
 * double-process a run this already closed out from under it. And it closes
 * out any 'running' agent_run_steps row exactly like finalizeRun's own
 * cleanup does (engine.ts) — otherwise the timeline would show the run as
 * Canceled while its last attempt sits forever as "Running". It marks the
 * row canceled rather than deleting it: force-halt exists BECAUSE that
 * attempt looked stuck, so its started_at and which step it was on are the
 * evidence worth keeping, not erasing. A 'waiting' row (parked behind an
 * approval or a question) is left alone on purpose: it already carries a
 * complete summary, and the engine's own graceful-cancel path for a
 * waiting run leaves it untouched too.
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { recordAgentRunOutcome } from '@renkei/agents/runs';

export type ForceHaltRunResult =
  { outcome: 'halted' } | { outcome: 'already-final'; status: string } | { outcome: 'not-found' };

const FORCE_HALT_ERROR = 'Force-halted by an admin — the run was stuck and not making progress.';

export async function forceHaltRun(
  db: Kysely<DB>,
  input: {
    tenantId: string;
    agentId: string;
    runId: string;
    /** Who clicked it — recorded the same way a graceful cancel would be. */
    haltedBySubject: string;
  }
): Promise<ForceHaltRunResult> {
  const run = await db
    .selectFrom('agent_runs')
    .select(['id', 'status', 'owner_subject'])
    .where('id', '=', input.runId)
    .where('tenant_id', '=', input.tenantId)
    .where('agent_id', '=', input.agentId)
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

  const claimed = await db
    .updateTable('agent_runs')
    .set({
      status: 'canceled',
      error_kind: 'force_halted',
      error: FORCE_HALT_ERROR,
      finished_at: sql`NOW()`,
      updated_at: sql`NOW()`,
      cancel_requested_at: sql`COALESCE(cancel_requested_at, NOW())`,
      cancel_requested_by: sql`COALESCE(cancel_requested_by, ${input.haltedBySubject})`,
    })
    .where('id', '=', input.runId)
    .where('status', 'in', ['queued', 'running', 'waiting'])
    .executeTakeFirst();
  if (Number(claimed.numUpdatedRows ?? 0) === 0) {
    // Reached a terminal status in the gap above — nothing left to force.
    return { outcome: 'already-final', status: run.status };
  }

  // Close out the in-progress attempt row so it does not linger as
  // "Running" under a run that is already Canceled — see the header for why
  // this updates rather than deletes it.
  await db
    .updateTable('agent_run_steps')
    .set({ status: 'canceled', finished_at: sql`NOW()`, updated_at: sql`NOW()` })
    .where('run_id', '=', input.runId)
    .where('status', '=', 'running')
    .execute();

  // Bypass the janitor's live-job check on purpose — that safety check is
  // exactly what makes this override necessary in the first place. A row
  // still 'processing' is treated the same as a 'pending' one this call
  // just never lets get claimed.
  await db
    .updateTable('agent_jobs')
    .set({ status: 'skipped', locked_at: null, updated_at: sql`NOW()` })
    .where('status', 'in', ['pending', 'processing'])
    .where(sql<string>`payload->>'runId'`, '=', input.runId)
    .execute();
  await db
    .deleteFrom('agent_jobs_dead_letters')
    .where(sql<string>`payload->>'runId'`, '=', input.runId)
    .execute();

  // Best-effort, same posture as the janitor: the status flip above is what
  // matters, the usage/history ledger is secondary.
  await recordAgentRunOutcome(db, {
    tenantId: input.tenantId,
    agentId: input.agentId,
    runId: input.runId,
    ownerSubject: run.owner_subject,
    status: 'canceled',
    errorKind: 'force_halted',
    error: FORCE_HALT_ERROR,
  });

  return { outcome: 'halted' };
}
