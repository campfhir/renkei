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

import { getDataStore } from '@renkei/db';
import { recordAgentRunOutcome } from '@renkei/agents/runs';
import { discardRunJobs } from './run-jobs';

export type ForceHaltRunResult =
  { outcome: 'halted' } | { outcome: 'already-final'; status: string } | { outcome: 'not-found' };

const FORCE_HALT_ERROR = 'Force-halted by an admin — the run was stuck and not making progress.';

export async function forceHaltRun(input: {
  agentId: string;
  runId: string;
  /** Who clicked it — recorded the same way a graceful cancel would be. */
  haltedBySubject: string;
}): Promise<ForceHaltRunResult> {
  const runs = getDataStore().agentRuns;
  const run = await runs.findStatus({ agentId: input.agentId, runId: input.runId });
  if (!run) return { outcome: 'not-found' };
  if (
    run.status === 'succeeded' ||
    run.status === 'failed' ||
    run.status === 'stopped' ||
    run.status === 'canceled'
  ) {
    return { outcome: 'already-final', status: run.status };
  }

  // The claim, and closing out the in-progress attempt row so it does not
  // linger as "Running" under a run that is already Canceled — see the
  // header for why that updates rather than deletes it.
  const claimed = await runs.forceCancel(input.runId, {
    bySubject: input.haltedBySubject,
    errorKind: 'force_halted',
    error: FORCE_HALT_ERROR,
  });
  if (!claimed) {
    // Reached a terminal status in the gap above — nothing left to force.
    return { outcome: 'already-final', status: run.status };
  }

  await discardRunJobs(input.runId);

  // Best-effort, same posture as the janitor: the status flip above is what
  // matters, the usage/history ledger is secondary.
  await recordAgentRunOutcome({
    agentId: input.agentId,
    runId: input.runId,
    ownerSubject: run.ownerSubject,
    status: 'canceled',
    errorKind: 'force_halted',
    error: FORCE_HALT_ERROR,
  });

  return { outcome: 'halted' };
}
