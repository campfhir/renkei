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
import type { QueueProducer } from '@renkei/queue';
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

/**
 * Whether this agent already has a run in flight — queued or actively
 * running. The single source of truth for the "Run now" button's and the
 * agent_run_now MCP tool's own concurrency guard: both ask a person before
 * piling a manual run on top of one already going, rather than silently
 * queuing a second. Automatic triggers (schedule, event, api key, an agent
 * chain) never call this — they already run concurrently by design,
 * serialized only by the queue's ordering key (see `orderingKey` above).
 */
export async function findInProgressRun(
  db: Kysely<DB>,
  tenantId: string,
  agentId: string
): Promise<{ id: string; status: string } | null> {
  const row = await db
    .selectFrom('agent_runs')
    .select(['id', 'status'])
    .where('tenant_id', '=', tenantId)
    .where('agent_id', '=', agentId)
    .where('status', 'in', ['queued', 'running'])
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  return row ?? null;
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

/**
 * The token-side tally (migration 072), bumped by the worker engine every
 * time an attempt's token spend is finalized — one call per
 * `agent_run_steps` row that records non-zero usage, same as that row's own
 * `input_tokens`/`output_tokens` columns (071). Lands on TODAY, not the
 * attempt's start day, matching recordAgentRunFailure. A no-op call (both
 * zero) still round-trips to the database; callers skip it themselves when
 * there is nothing to add. Best effort: a finished attempt must not fail
 * over its bookkeeping.
 */
export async function recordAgentRunTokenUsage(
  db: Kysely<DB>,
  tenantId: string,
  agentId: string,
  inputTokens: number,
  outputTokens: number
): Promise<Result<void, 'DB_ERROR'>> {
  const result = await wrapAsync(
    () =>
      sql`
        INSERT INTO agent_run_counters (tenant_id, agent_id, day, runs, input_tokens, output_tokens)
        VALUES (${tenantId}, ${agentId}, CURRENT_DATE, 0, ${inputTokens}, ${outputTokens})
        ON CONFLICT (tenant_id, agent_id, day)
        DO UPDATE SET
          input_tokens = agent_run_counters.input_tokens + excluded.input_tokens,
          output_tokens = agent_run_counters.output_tokens + excluded.output_tokens
      `.execute(db),
    'DB_ERROR' as const
  );
  if (!result.ok) return err('DB_ERROR' as const, { cause: result.err });
  return ok(undefined);
}

export interface CaptureAgentRunFailureInput {
  tenantId: string;
  agentId: string;
  runId: string;
  ownerSubject: string;
  /** Where execution was when it stopped, and that step's display name. */
  stepId: string | null;
  stepName: string | null;
  errorKind: string | null;
  error: string | null;
}

/**
 * The per-failure record (migration 079) — what the counters' `failures`
 * column cannot say: WHICH step, WHAT kind of error, and what the run had
 * cost by then. Written once per run that finalizes as 'failed', beside
 * recordAgentRunFailure and with the same best-effort posture.
 *
 * The cost figures and the attempt's outcome code are read back out of
 * `agent_run_steps` here rather than threaded through the engine: the
 * engine has already written every attempt row by the time it finalizes,
 * and one aggregate query is cheaper to keep right than a running total
 * carried across every code path that can end a run.
 */
export async function captureAgentRunFailure(
  db: Kysely<DB>,
  input: CaptureAgentRunFailureInput
): Promise<Result<void, 'DB_ERROR'>> {
  const result = await wrapAsync(async () => {
    const [run, agent, spend, lastFailed] = await Promise.all([
      db
        .selectFrom('agent_runs')
        .select('trigger_kind')
        .where('id', '=', input.runId)
        .executeTakeFirst(),
      db
        .selectFrom('agents')
        .select('steps_version')
        .where('tenant_id', '=', input.tenantId)
        .where('id', '=', input.agentId)
        .executeTakeFirst(),
      db
        .selectFrom('agent_run_steps')
        .select(({ fn }) => [
          fn.sum<string>('input_tokens').as('input_tokens'),
          fn.sum<string>('output_tokens').as('output_tokens'),
          fn.sum<string>('tool_call_count').as('tool_calls'),
          fn.countAll<string>().as('attempts'),
        ])
        .where('run_id', '=', input.runId)
        .executeTakeFirst(),
      db
        .selectFrom('agent_run_steps')
        .select('outcome_code')
        .where('run_id', '=', input.runId)
        .where('status', '=', 'failed')
        .orderBy('step_index', 'desc')
        .orderBy('iteration', 'desc')
        .orderBy('attempt', 'desc')
        .executeTakeFirst(),
    ]);

    await db
      .insertInto('agent_run_failures')
      .values({
        tenant_id: input.tenantId,
        agent_id: input.agentId,
        run_id: input.runId,
        owner_subject: input.ownerSubject,
        trigger_kind: run?.trigger_kind ?? 'manual',
        step_id: input.stepId,
        step_name: input.stepName ? input.stepName.slice(0, 200) : null,
        error_kind: input.errorKind ? input.errorKind.slice(0, 32) : null,
        outcome_code: lastFailed?.outcome_code ? lastFailed.outcome_code.slice(0, 64) : null,
        error: input.error ? input.error.slice(0, 2000) : null,
        input_tokens: Number(spend?.input_tokens ?? 0),
        output_tokens: Number(spend?.output_tokens ?? 0),
        tool_calls: Number(spend?.tool_calls ?? 0),
        attempts: Number(spend?.attempts ?? 0),
        steps_version: agent?.steps_version ?? null,
      })
      .execute();
  }, 'DB_ERROR' as const);
  if (!result.ok) return err('DB_ERROR' as const, { cause: result.err });
  return ok(undefined);
}
