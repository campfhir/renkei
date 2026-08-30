/**
 * Starting a run — the one path every trigger kind goes through.
 *
 * Schedules, connector events, API calls, agent chains, and the owner's
 * "Run now" button all end here: guards, then an `agent_runs` row with the
 * steps SNAPSHOT frozen in, then a bare `{ runId }` message onto the
 * agent_jobs queue under ordering key `agent:{agentId}` (one agent's runs
 * strictly serial; different agents parallel).
 *
 * The guards live here and not in the callers because a guard with N call
 * sites is a guard with N-1 chances to be forgotten:
 *   - cycle: the triggering chain (`lineage`) may not already contain this
 *     agent — A→B→A stops at the second A.
 *   - depth: chains stop at the org's agentMaxChainDepth.
 *   - daily cap: runs created in the last 24h stop at agentMaxRunsPerDay —
 *     the brake on a runaway trigger, priced per org.
 *
 * A refused run returns a typed reason so the caller can put it where its
 * kind surfaces failures (a trigger's last_error, an API 429, a parent
 * run's record).
 */

import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { QueueProducer, QueuePurger } from '@renkei/queue';
import { getOrgSettings } from '@renkei/settings';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { AgentStepsDoc } from './steps';

export interface CreateAgentRunInput {
  tenantId: string;
  agentId: string;
  ownerSubject: string;
  steps: AgentStepsDoc;
  /** Resolved model recorded for history; null = org default at claim time. */
  llmModelId: string | null;
  triggerId: string | null;
  triggerKind: 'event' | 'schedule' | 'agent' | 'api' | 'manual';
  triggeredBySubject?: string;
  /** Identifiers + small content; callers cap size before handing it over. */
  initialState?: Record<string, unknown>;
  parentRunId?: string;
  /** Ancestor agent ids of the triggering chain (parent's lineage + parent). */
  lineage?: string[];
}

export type CreateAgentRunError =
  'AGENT_CYCLE' | 'CHAIN_TOO_DEEP' | 'DAILY_RUN_CAP' | 'DB_ERROR' | 'QUEUE_ERROR';

export interface LiveRun {
  id: string;
  status: string;
}

/**
 * The run of this agent still holding the `agent:{agentId}` ordering key,
 * if any — the run a NEW one would queue behind rather than run alongside.
 * `queued` counts the same as `running`: both already claim the key (see
 * this file's module doc), so both are "in progress" for a caller deciding
 * whether to warn a person before adding another.
 *
 * Not itself a guard — nothing here refuses to create a run. A machine
 * trigger (schedule, event, chain, API key) queues behind a live run
 * silently, same as always; this exists for the ONE caller with someone
 * present to ask first, the manual "Run now" button, to check before it
 * calls `createAgentRun`.
 */
export async function liveRunFor(
  db: Kysely<DB>,
  tenantId: string,
  agentId: string
): Promise<LiveRun | null> {
  const row = await db
    .selectFrom('agent_runs')
    .select(['id', 'status'])
    .where('tenant_id', '=', tenantId)
    .where('agent_id', '=', agentId)
    .where('status', 'in', ['queued', 'running'])
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  return row ? { id: row.id, status: row.status } : null;
}

export async function createAgentRun(
  db: Kysely<DB>,
  producer: QueueProducer,
  input: CreateAgentRunInput
): Promise<Result<{ runId: string }, CreateAgentRunError>> {
  const lineage = input.lineage ?? [];

  if (lineage.includes(input.agentId)) {
    return err('AGENT_CYCLE' as const, {
      message: 'This agent already ran earlier in this chain.',
    });
  }

  const settingsResult = await getOrgSettings(input.tenantId);
  if (!settingsResult.ok) return err('DB_ERROR' as const);
  const settings = settingsResult.val;

  if (lineage.length >= settings.agentMaxChainDepth) {
    return err('CHAIN_TOO_DEEP' as const, {
      message: `Agent chains stop after ${settings.agentMaxChainDepth} agents.`,
    });
  }

  const countResult = await wrapAsync(
    () =>
      db
        .selectFrom('agent_runs')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .where('tenant_id', '=', input.tenantId)
        .where('created_at', '>', sql<Date>`NOW() - INTERVAL '24 hours'`)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!countResult.ok) return countResult;
  if (Number(countResult.val?.count ?? 0) >= settings.agentMaxRunsPerDay) {
    return err('DAILY_RUN_CAP' as const, {
      message: `This organization has reached its ${settings.agentMaxRunsPerDay} runs per day.`,
    });
  }

  const runId = randomUUID();
  const insertResult = await wrapAsync(
    () =>
      db
        .insertInto('agent_runs')
        .values({
          id: runId,
          tenant_id: input.tenantId,
          agent_id: input.agentId,
          owner_subject: input.ownerSubject,
          trigger_id: input.triggerId,
          trigger_kind: input.triggerKind,
          triggered_by_subject: input.triggeredBySubject ?? null,
          parent_run_id: input.parentRunId ?? null,
          lineage: JSON.stringify(lineage),
          depth: lineage.length,
          steps_snapshot: JSON.stringify(input.steps),
          llm_model_id: input.llmModelId,
          initial_state: input.initialState ? JSON.stringify(input.initialState) : null,
          status: 'queued',
        })
        .execute(),
    'DB_ERROR' as const
  );
  if (!insertResult.ok) return insertResult;

  const enqueueResult = await producer.enqueue({
    tenantId: input.tenantId,
    // The agent id is a fairness LANE on the source (like `knowledge:jira`
    // on the embedding queue): the ordering key below serializes THIS
    // agent's runs, and the lane keeps its backlog from delaying claims for
    // every other agent.
    source: `agents:${input.agentId}`,
    type: 'run',
    payload: { runId },
    orderingKey: `agent:${input.agentId}`,
  });
  if (!enqueueResult.ok) {
    // A queued row with no message would sit as 'queued' forever; better no
    // trace than a phantom. Best effort — the janitor also sweeps orphans.
    await wrapAsync(
      () => db.deleteFrom('agent_runs').where('id', '=', runId).execute(),
      'DB_ERROR' as const
    );
    return err('QUEUE_ERROR' as const);
  }

  // The durable tally the overview's quarterly/yearly/all-time numbers read
  // (migration 049): run ROWS are pruned by retention, counters are not.
  // Best effort — a run that started must not fail over its bookkeeping.
  await wrapAsync(
    () =>
      sql`
        INSERT INTO agent_run_counters (tenant_id, agent_id, day, runs)
        VALUES (${input.tenantId}, ${input.agentId}, CURRENT_DATE, 1)
        ON CONFLICT (tenant_id, agent_id, day)
        DO UPDATE SET runs = agent_run_counters.runs + 1
      `.execute(db),
    'DB_ERROR' as const
  );

  return ok({ runId });
}

export type CancelRunOutcome =
  /** Was `queued` or `waiting`; the row is `canceled` now, immediately. */
  | { outcome: 'canceled' }
  /** Was `running` (or got claimed the instant this ran); the engine's own
   *  per-step checkpoint will notice and finalize it as `canceled` shortly. */
  | { outcome: 'cancel-requested' }
  | { outcome: 'already-final'; status: string }
  | { outcome: 'not-found' };

/**
 * Stop a run that hasn't finished — the counterpart to `createAgentRun`,
 * and like it, the ONE path a REST route and an MCP tool both call so the
 * two never drift.
 *
 * `queued` and `waiting` aren't doing anything an UPDATE can't just undo:
 * neither holds a claim on the queue's ordering key at the moment of the
 * request (a queued run's message may still be pending; a waiting run has
 * none at all until an approval decision or the timeout sweep re-enqueues
 * one — see decideApproval). So both go straight to `canceled`, and for
 * `queued` the pending message is best-effort discarded too — if a claim
 * beat this update, handleRun's own idempotent-redelivery check (a
 * `canceled` row is simply acknowledged) covers it either way.
 *
 * `running` is different: the engine owns the row while it's mid-loop, so
 * this can only ASK — `cancel_requested_at` — and the engine's per-step
 * checkpoint stops at the next boundary rather than mid-tool-call. The
 * same flag is the fallback for a `queued`/`waiting` run that got claimed
 * in the gap between the read above and the write just after it: the
 * immediate UPDATE's WHERE guard simply matches zero rows, and this one
 * catches it instead.
 */
export async function requestRunCancel(
  db: Kysely<DB>,
  purger: QueuePurger,
  tenantId: string,
  agentId: string,
  runId: string
): Promise<CancelRunOutcome> {
  const run = await db
    .selectFrom('agent_runs')
    .select(['status'])
    .where('tenant_id', '=', tenantId)
    .where('agent_id', '=', agentId)
    .where('id', '=', runId)
    .executeTakeFirst();
  if (!run) return { outcome: 'not-found' };
  if (
    run.status === 'succeeded' ||
    run.status === 'failed' ||
    run.status === 'canceled' ||
    run.status === 'stopped'
  ) {
    return { outcome: 'already-final', status: run.status };
  }

  if (run.status === 'queued') {
    const updated = await db
      .updateTable('agent_runs')
      .set({ status: 'canceled', finished_at: sql`NOW()`, updated_at: sql`NOW()` })
      .where('id', '=', runId)
      .where('status', '=', 'queued')
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows ?? 0) > 0) {
      await purger.discardPending(tenantId, 'run', [{ path: ['runId'], value: runId }]);
      return { outcome: 'canceled' };
    }
  } else if (run.status === 'waiting') {
    const updated = await db
      .updateTable('agent_runs')
      .set({
        status: 'canceled',
        waiting_until: null,
        finished_at: sql`NOW()`,
        updated_at: sql`NOW()`,
      })
      .where('id', '=', runId)
      .where('status', '=', 'waiting')
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows ?? 0) > 0) {
      // Mirrors the disabled-agent auto-cancel path (engine.ts): a card
      // left `suggested` on a run that will never resume is a decision
      // nobody can make.
      await db
        .updateTable('actionable_items')
        .set({
          status: 'expired',
          decided_at: sql`NOW()`,
          archived_at: sql`NOW()`,
          result: JSON.stringify({ reason: 'run-ended' }),
          updated_at: sql`NOW()`,
        })
        .where('run_id', '=', runId)
        .where('status', '=', 'suggested')
        .execute();
      return { outcome: 'canceled' };
    }
  }

  const flagged = await db
    .updateTable('agent_runs')
    .set({ cancel_requested_at: sql`NOW()`, updated_at: sql`NOW()` })
    .where('id', '=', runId)
    .where('status', 'in', ['queued', 'running', 'waiting'])
    .executeTakeFirst();
  if (Number(flagged.numUpdatedRows ?? 0) > 0) return { outcome: 'cancel-requested' };

  const final = await db
    .selectFrom('agent_runs')
    .select(['status'])
    .where('id', '=', runId)
    .executeTakeFirst();
  return { outcome: 'already-final', status: final?.status ?? 'unknown' };
}

/**
 * The failure-side tally (migration 050), bumped when a run finalizes as
 * 'failed'. Lands on TODAY — the day the run became a failure — which may
 * be the day after its start was tallied; the columns are independent
 * counts, not a ratio of the same rows. Best effort like the run tally: a
 * finished run must not fail over its bookkeeping.
 */
export async function recordAgentRunFailure(
  db: Kysely<DB>,
  tenantId: string,
  agentId: string
): Promise<Result<void, 'DB_ERROR'>> {
  const result = await wrapAsync(
    () =>
      sql`
        INSERT INTO agent_run_counters (tenant_id, agent_id, day, runs, failures)
        VALUES (${tenantId}, ${agentId}, CURRENT_DATE, 0, 1)
        ON CONFLICT (tenant_id, agent_id, day)
        DO UPDATE SET failures = agent_run_counters.failures + 1
      `.execute(db),
    'DB_ERROR' as const
  );
  if (!result.ok) return err('DB_ERROR' as const, { cause: result.err });
  return ok(undefined);
}
