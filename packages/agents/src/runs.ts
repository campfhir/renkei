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
import { findNodeById, isAgentStepsDoc, type AgentStepsDoc } from './steps';

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

  // The durable run log (migration 083): one timestamped row per run, the
  // ledger the usage page counts in the viewer's own day. Same best-effort
  // posture; finalization upserts, so a missed insert still leaves a row.
  await wrapAsync(
    () =>
      db
        .insertInto('agent_run_log')
        .values({
          run_id: runId,
          tenant_id: input.tenantId,
          agent_id: input.agentId,
          owner_subject: input.ownerSubject,
          trigger_kind: input.triggerKind,
          status: 'queued',
        })
        .execute(),
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

/** The longest note an owner may attach to a resume. */
export const RESUME_GUIDANCE_MAX_CHARS = 2_000;

export interface ResumeAgentRunInput {
  tenantId: string;
  agentId: string;
  runId: string;
  /** The run's owner_subject — whose grants it keeps acting under. */
  ownerSubject: string;
  /** Who asked — the owner, or a grantee troubleshooting for them. */
  resumedBySubject: string;
  /** What to do differently at the resumed step; trimmed, capped, optional. */
  guidance?: string;
}

export type ResumeAgentRunError =
  | 'NOT_FOUND'
  /** The run is not in 'failed' — only a failed run has a step to pick back up at. */
  | 'NOT_FAILED'
  /** The run ended on a terminal failure node: that is the plan's own verdict, not a fault to retry. */
  | 'NOT_RESUMABLE'
  | 'DB_ERROR'
  | 'QUEUE_ERROR';

export interface ResumedAgentRun {
  runId: string;
  /** The step the run picks back up at; null when it failed before reaching one. */
  stepId: string | null;
  stepName: string | null;
  /** The attempts of that step (on the iteration that failed) set aside for the retry. */
  retiredAttempts: number;
}

/**
 * Pick a failed run back up at the step it failed on — the same run row,
 * the same snapshot, the same saved variables, with the failed step given
 * a fresh attempt budget and, when the owner adds one, a note on what to
 * do differently.
 *
 * Why this is possible without new machinery: the engine persists no
 * cursor beyond `current_step_id` and no variable bag at all — every
 * re-entry (a crash, an approval wake) rebuilds position and bindings
 * from the `agent_run_steps` rows and fast-forwards through the ones that
 * succeeded. A failed run is just a run whose last row failed. So a
 * resume is: set the failed step's spent attempts aside (status
 * 'retired' — kept for the timeline, ignored by the budget count), put
 * the row back to 'queued' with the failure cleared, and enqueue the same
 * bare `{ runId }` message every other start uses. The engine does the
 * rest exactly as it does after a crash.
 *
 * Contrast with "run again" (the rerun route): that starts a NEW run of
 * the agent AS IT STANDS NOW on the old input, for when the plan itself
 * was wrong. This keeps the run and its snapshot, for when the plan was
 * fine and one step needs another go — a transient tool error, a bad
 * value the owner can correct in a sentence, an approval that filed
 * something the target refused.
 *
 * Cancel-request flags are cleared: a resume is the owner asking for the
 * opposite of a cancel, and a stale flag would stop the run at its first
 * checkpoint. `started_at` is cleared so the engine hands the resumed
 * run a fresh deadline budget (the pause was the owner's time).
 */
export async function resumeAgentRun(
  db: Kysely<DB>,
  producer: QueueProducer,
  input: ResumeAgentRunInput
): Promise<Result<ResumedAgentRun, ResumeAgentRunError>> {
  const runResult = await wrapAsync(
    () =>
      db
        .selectFrom('agent_runs')
        .select(['id', 'status', 'current_step_id', 'steps_snapshot', 'error', 'error_kind'])
        .where('id', '=', input.runId)
        .where('tenant_id', '=', input.tenantId)
        .where('agent_id', '=', input.agentId)
        .where('owner_subject', '=', input.ownerSubject)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!runResult.ok) return runResult;
  const run = runResult.val;
  if (!run) return err('NOT_FOUND' as const);
  if (run.status !== 'failed') {
    return err('NOT_FAILED' as const, {
      message: `This run ${run.status === 'canceled' ? 'was canceled' : `is ${run.status}`} — only a failed run can be resumed.`,
    });
  }

  // Where it stopped. A run that failed before its first step (a model
  // configuration problem, a snapshot the engine refused) has no step to
  // point at: resuming it starts from the top, which is still a resume of
  // THIS run — its id, its history — not a new one.
  const stepId = run.current_step_id;
  let stepName: string | null = null;
  if (stepId && isAgentStepsDoc(run.steps_snapshot)) {
    const found = findNodeById(run.steps_snapshot.steps, stepId);
    if (found?.node.kind === 'terminal') {
      return err('NOT_RESUMABLE' as const, {
        message:
          'This run ended on a failure marker the automation reached by design — there is ' +
          'no failed step to retry. Fix the steps and run it again instead.',
      });
    }
    stepName = found?.node.name ?? null;
  }

  const guidance = (input.guidance ?? '').trim().slice(0, RESUME_GUIDANCE_MAX_CHARS) || null;

  const flipped = await wrapAsync(
    () =>
      db.transaction().execute(async (trx) => {
        // The failed step's spent attempts, on the round that failed: set
        // aside, not deleted. The engine numbers new attempts past them
        // (the unique (run, step, iteration, attempt) constraint needs
        // that) and counts only live ones against the budget; the
        // timeline keeps them so the failure story stays readable.
        let retiredAttempts = 0;
        if (stepId) {
          const last = await trx
            .selectFrom('agent_run_steps')
            .select(({ fn }) => fn.max<number | null>('iteration').as('iteration'))
            .where('run_id', '=', input.runId)
            .where('step_id', '=', stepId)
            .executeTakeFirst();
          if (last?.iteration !== null && last?.iteration !== undefined) {
            const retired = await trx
              .updateTable('agent_run_steps')
              .set({ status: 'retired', updated_at: sql`NOW()` })
              .where('run_id', '=', input.runId)
              .where('step_id', '=', stepId)
              .where('iteration', '=', Number(last.iteration))
              .where('status', 'in', ['failed', 'canceled'])
              .executeTakeFirst();
            retiredAttempts = Number(retired.numUpdatedRows ?? 0);
          }
        }

        // Optimistic on the status: a second click, or a janitor racing
        // this, finds the row no longer 'failed' and changes nothing.
        const updated = await trx
          .updateTable('agent_runs')
          .set({
            status: 'queued',
            error: null,
            error_kind: null,
            started_at: null,
            finished_at: null,
            waiting_until: null,
            cancel_requested_at: null,
            cancel_requested_by: null,
            resumed_at: sql`NOW()`,
            resumed_by: input.resumedBySubject,
            resume_count: sql`resume_count + 1`,
            resume_step_id: stepId,
            resume_guidance: guidance,
            updated_at: sql`NOW()`,
          })
          .where('id', '=', input.runId)
          .where('status', '=', 'failed')
          .executeTakeFirst();
        if (Number(updated.numUpdatedRows ?? 0) === 0) {
          throw new Error('run is no longer failed');
        }
        return retiredAttempts;
      }),
    'DB_ERROR' as const
  );
  if (!flipped.ok) {
    const cause = flipped.err.cause;
    if (cause instanceof Error && cause.message === 'run is no longer failed') {
      return err('NOT_FAILED' as const, { message: 'This run was already resumed.' });
    }
    return flipped;
  }
  const retiredAttempts = flipped.val;

  const enqueueResult = await producer.enqueue({
    tenantId: input.tenantId,
    source: `agents:${input.agentId}`,
    type: 'run',
    payload: { runId: input.runId },
    orderingKey: `agent:${input.agentId}`,
  });
  if (!enqueueResult.ok) {
    // A 'queued' row with no message would sit until the stuck-run
    // janitor failed it hours later, with the original error gone. Put
    // the failure back the way it was; the retired rows stay retired —
    // the next resume attempt retires nothing new and the budget reads
    // the same either way.
    await wrapAsync(
      () =>
        db
          .updateTable('agent_runs')
          .set({
            status: 'failed',
            error: run.error,
            error_kind: run.error_kind,
            finished_at: sql`NOW()`,
            updated_at: sql`NOW()`,
          })
          .where('id', '=', input.runId)
          .where('status', '=', 'queued')
          .execute(),
      'DB_ERROR' as const
    );
    return err('QUEUE_ERROR' as const);
  }

  // The durable log reads 'failed' for this run until the engine
  // finalizes it again; say it is back in flight so the usage page does
  // not count a run that is running as a failure meanwhile. Best effort,
  // like every write to the ledger.
  await wrapAsync(
    () =>
      db
        .updateTable('agent_run_log')
        .set({ status: 'queued', finished_at: null })
        .where('run_id', '=', input.runId)
        .execute(),
    'DB_ERROR' as const
  );

  return ok({ runId: input.runId, stepId, stepName, retiredAttempts });
}

/**
 * Step ids are uuids in every current steps document, but the columns
 * that carry them here are typed uuid and the source (`current_step_id`,
 * `agent_run_steps.step_id`) is text — a malformed id must cost the
 * step attribution, never the whole row.
 */
function uuidOrNull(value: string | null | undefined): string | null {
  return value && /^[0-9a-fA-F-]{36}$/.test(value) ? value : null;
}

export interface RecordAgentRunOutcomeInput {
  tenantId: string;
  agentId: string;
  runId: string;
  ownerSubject: string;
  status: 'succeeded' | 'failed' | 'stopped' | 'canceled';
  /** Where execution was when it stopped, and that step's display name. Failed runs only. */
  stepId?: string | null;
  stepName?: string | null;
  errorKind?: string | null;
  error?: string | null;
}

/**
 * Finalize a run's row in the durable run log (migration 083): its
 * outcome, and — when it failed — the step, the kind, the code and the
 * clipped message; for every status, what the run cost. Written beside
 * the counter tallies with the same best-effort posture.
 *
 * An upsert rather than an update: the log row is normally inserted at
 * run creation, but that insert is itself best-effort, and a run that
 * finished must still leave a record.
 *
 * The cost figures and the attempt's outcome code are read back out of
 * `agent_run_steps` here rather than threaded through the engine: the
 * engine has already written every attempt row by the time it finalizes,
 * and one aggregate query is cheaper to keep right than a running total
 * carried across every code path that can end a run.
 */
export async function recordAgentRunOutcome(
  db: Kysely<DB>,
  input: RecordAgentRunOutcomeInput
): Promise<Result<void, 'DB_ERROR'>> {
  const failed = input.status === 'failed';
  const result = await wrapAsync(async () => {
    const [run, agent, spend, lastFailed] = await Promise.all([
      db
        .selectFrom('agent_runs')
        .select(['trigger_kind', 'created_at'])
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
      failed
        ? db
            .selectFrom('agent_run_steps')
            .select('outcome_code')
            .where('run_id', '=', input.runId)
            .where('status', '=', 'failed')
            .orderBy('step_index', 'desc')
            .orderBy('iteration', 'desc')
            .orderBy('attempt', 'desc')
            .executeTakeFirst()
        : Promise.resolve(undefined),
    ]);

    const stepId = failed ? uuidOrNull(input.stepId) : null;
    const stepName = failed && input.stepName ? input.stepName.slice(0, 200) : null;
    const errorKind = failed && input.errorKind ? input.errorKind.slice(0, 32) : null;
    const outcomeCode = lastFailed?.outcome_code ? lastFailed.outcome_code.slice(0, 64) : null;
    const error = failed && input.error ? input.error.slice(0, 2000) : null;
    const inputTokens = Number(spend?.input_tokens ?? 0);
    const outputTokens = Number(spend?.output_tokens ?? 0);
    const toolCalls = Number(spend?.tool_calls ?? 0);
    const attempts = Number(spend?.attempts ?? 0);
    const stepsVersion = agent?.steps_version ?? null;

    await sql`
      INSERT INTO agent_run_log (
        run_id, tenant_id, agent_id, owner_subject, trigger_kind, status, created_at, finished_at,
        step_id, step_name, error_kind, outcome_code, error,
        input_tokens, output_tokens, tool_calls, attempts, steps_version
      ) VALUES (
        ${input.runId}, ${input.tenantId}, ${input.agentId}, ${input.ownerSubject},
        ${run?.trigger_kind ?? 'manual'}, ${input.status}, ${run?.created_at ?? sql`NOW()`}, NOW(),
        ${stepId}, ${stepName}, ${errorKind}, ${outcomeCode}, ${error},
        ${inputTokens}, ${outputTokens}, ${toolCalls}, ${attempts}, ${stepsVersion}
      )
      ON CONFLICT (run_id) DO UPDATE SET
        status = excluded.status,
        finished_at = excluded.finished_at,
        step_id = excluded.step_id,
        step_name = excluded.step_name,
        error_kind = excluded.error_kind,
        outcome_code = excluded.outcome_code,
        error = excluded.error,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        tool_calls = excluded.tool_calls,
        attempts = excluded.attempts,
        steps_version = excluded.steps_version
    `.execute(db);
  }, 'DB_ERROR' as const);
  if (!result.ok) return err('DB_ERROR' as const, { cause: result.err });
  return ok(undefined);
}

export interface RecordLlmCallInput {
  tenantId: string;
  /** Whose spend it is: the run's owner, or the person the call served. */
  subject: string;
  agentId: string | null;
  runId?: string | null;
  stepId?: string | null;
  purpose: 'run' | 'optimize' | 'chat';
  /** Every prompt token the model read, cache-served or not. */
  inputTokens: number;
  outputTokens: number;
  /** The cached portions of inputTokens (migration 097); omitted = not reported. */
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  /**
   * What the tokens were spent on (migration 098): the provider and model
   * NAME as resolved for this call, plus the config row that answered.
   * The name is what costs are read against — a config row can be
   * re-pointed at another model later, the name on the row cannot.
   */
  model?: LlmCallModel | null;
}

export interface LlmCallModel {
  provider: string;
  model: string;
  /** The `llm_model_configs` row, as a soft reference. */
  llmModelId: string | null;
}

/**
 * One row in the token ledger (migration 085). Skipped when both counts
 * are zero, like the counter tally; best effort, like everything here.
 */
export async function recordLlmCall(
  db: Kysely<DB>,
  input: RecordLlmCallInput
): Promise<Result<void, 'DB_ERROR'>> {
  if (input.inputTokens === 0 && input.outputTokens === 0) return ok(undefined);
  const result = await wrapAsync(
    () =>
      db
        .insertInto('llm_calls')
        .values({
          tenant_id: input.tenantId,
          subject: input.subject,
          agent_id: input.agentId,
          run_id: input.runId ?? null,
          step_id: uuidOrNull(input.stepId),
          purpose: input.purpose,
          input_tokens: input.inputTokens,
          output_tokens: input.outputTokens,
          cache_read_input_tokens: input.cacheReadInputTokens ?? null,
          cache_write_input_tokens: input.cacheWriteInputTokens ?? null,
          llm_model_id: input.model?.llmModelId ?? null,
          provider: input.model?.provider ?? null,
          model: input.model?.model ?? null,
        })
        .execute(),
    'DB_ERROR' as const
  );
  if (!result.ok) return err('DB_ERROR' as const, { cause: result.err });
  return ok(undefined);
}
