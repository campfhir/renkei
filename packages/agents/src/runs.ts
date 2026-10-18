/**
 * Starting a run — the one path every trigger kind goes through.
 *
 * Schedules, connector events, API calls, agent chains, and the owner's
 * "Run now" button all end here: guards, then an `agent_runs` row with the
 * definition SNAPSHOT (instructions + tools) frozen in, then a bare `{ runId }` message onto the
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
import type { AgentDefinition } from './definition';

export interface CreateAgentRunInput {
  agentId: string;
  ownerSubject: string;
  definition: AgentDefinition;
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

  const settingsResult = await getOrgSettings();
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
          agent_id: input.agentId,
          owner_subject: input.ownerSubject,
          trigger_id: input.triggerId,
          trigger_kind: input.triggerKind,
          triggered_by_subject: input.triggeredBySubject ?? null,
          parent_run_id: input.parentRunId ?? null,
          lineage: JSON.stringify(lineage),
          depth: lineage.length,
          definition_snapshot: JSON.stringify(input.definition),
          llm_model_id: input.llmModelId,
          initial_state: input.initialState ? JSON.stringify(input.initialState) : null,
          status: 'queued',
        })
        .execute(),
    'DB_ERROR' as const
  );
  if (!insertResult.ok) return insertResult;

  const enqueueResult = await producer.enqueue({
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
  agentId: string
): Promise<{ id: string; status: string } | null> {
  const row = await db
    .selectFrom('agent_runs')
    .select(['id', 'status'])
    .where('agent_id', '=', agentId)
    .where('status', 'in', ['queued', 'running'])
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  return row ?? null;
}

/** The longest note an owner may attach to a resume. */
export const RESUME_GUIDANCE_MAX_CHARS = 2_000;

export interface ResumeAgentRunInput {
  agentId: string;
  runId: string;
  /** The run's owner_subject — whose grants it keeps acting under. */
  ownerSubject: string;
  /** Who asked — the owner, or a grantee troubleshooting for them. */
  resumedBySubject: string;
  /** What to do differently; trimmed, capped, optional. */
  guidance?: string;
}

export type ResumeAgentRunError =
  | 'NOT_FOUND'
  /** The run is not in 'failed' — only a failed run can be picked back up. */
  | 'NOT_FAILED'
  | 'DB_ERROR'
  | 'QUEUE_ERROR';

export interface ResumedAgentRun {
  runId: string;
}

/**
 * Pick a failed run back up where it stopped — the same run row, the same
 * snapshot, the same conversation, with a fresh budget and, when the owner
 * adds one, a note on what to do differently.
 *
 * Why this needs no new machinery: the engine's only memory is the turn
 * rows — every re-entry (a crash, a wake after a staged batch or a
 * question) rebuilds the conversation from them. A failed run is a run
 * whose conversation simply stopped. So a resume puts the row back to
 * 'queued' with the failure cleared and the resume recorded
 * (`resumed_at`, `resume_count`, `resume_guidance`), and enqueues the same
 * bare `{ runId }` message every other start uses. The engine sees
 * `resumed_at` later than its last turn, tells the agent the run stopped,
 * passes on the guidance, and the budget it counts starts from the resume
 * (turns before `resumed_at` are history, not spend).
 *
 * Contrast with "run again" (the rerun route): that starts a NEW run of
 * the agent AS IT STANDS NOW on the old input, for when the instructions
 * were wrong. This keeps the run, for when they were fine and the run
 * needs another go — a transient tool error, a value the owner can
 * correct in a sentence.
 *
 * Cancel-request flags are cleared: a resume is the owner asking for the
 * opposite of a cancel, and a stale flag would stop the run at its first
 * checkpoint. `active_ms` is cleared for a fresh time budget.
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
        .select(['id', 'status', 'error', 'error_kind'])
        .where('id', '=', input.runId)
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

  const guidance = (input.guidance ?? '').trim().slice(0, RESUME_GUIDANCE_MAX_CHARS) || null;

  const flipped = await wrapAsync(
    () =>
      db
        .updateTable('agent_runs')
        .set({
          status: 'queued',
          error: null,
          error_kind: null,
          started_at: null,
          finished_at: null,
          waiting_until: null,
          active_ms: 0,
          cancel_requested_at: null,
          cancel_requested_by: null,
          resumed_at: sql`NOW()`,
          resumed_by: input.resumedBySubject,
          resume_count: sql`resume_count + 1`,
          resume_guidance: guidance,
          // Recorded for the failure story; the engine re-opens nothing by it.
          resume_failure: run.error,
          updated_at: sql`NOW()`,
        })
        .where('id', '=', input.runId)
        // Optimistic on the status: a second click, or a janitor racing
        // this, finds the row no longer 'failed' and changes nothing.
        .where('status', '=', 'failed')
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!flipped.ok) return flipped;
  if (Number(flipped.val.numUpdatedRows ?? 0) === 0) {
    return err('NOT_FAILED' as const, { message: 'This run was already resumed.' });
  }

  const enqueueResult = await producer.enqueue({
    source: `agents:${input.agentId}`,
    type: 'run',
    payload: { runId: input.runId },
    orderingKey: `agent:${input.agentId}`,
  });
  if (!enqueueResult.ok) {
    // A 'queued' row with no message would sit until the stuck-run
    // janitor failed it hours later, with the original error gone. Put
    // the failure back the way it was.
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

  return ok({ runId: input.runId });
}

/**
 * The ledger columns that carry a step id are typed uuid (a holdover from
 * the step model); a run's turns are not steps, so anything that is not a
 * uuid is recorded as no step at all rather than costing the whole row.
 */
function uuidOrNull(value: string | null | undefined): string | null {
  return value && /^[0-9a-fA-F-]{36}$/.test(value) ? value : null;
}

export interface RecordAgentRunOutcomeInput {
  agentId: string;
  runId: string;
  ownerSubject: string;
  status: 'succeeded' | 'failed' | 'stopped' | 'canceled';
  errorKind?: string | null;
  error?: string | null;
}

/**
 * Finalize a run's row in the durable run log (migration 083): its
 * outcome, and — when it failed — the kind, the code and the clipped
 * message; for every status, what the run cost. Written beside
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
    const [run, spend, lastFailed] = await Promise.all([
      db
        .selectFrom('agent_runs')
        .select(['trigger_kind', 'created_at'])
        .where('id', '=', input.runId)
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

    // The log's step columns belong to the step model; a run has no
    // steps, so they stay empty (the kind, code and message say why).
    const stepId = null;
    const stepName = null;
    const errorKind = failed && input.errorKind ? input.errorKind.slice(0, 32) : null;
    const outcomeCode = lastFailed?.outcome_code ? lastFailed.outcome_code.slice(0, 64) : null;
    const error = failed && input.error ? input.error.slice(0, 2000) : null;
    const inputTokens = Number(spend?.input_tokens ?? 0);
    const outputTokens = Number(spend?.output_tokens ?? 0);
    const toolCalls = Number(spend?.tool_calls ?? 0);
    const attempts = Number(spend?.attempts ?? 0);
    const stepsVersion = null;

    await sql`
      INSERT INTO agent_run_log (
        run_id, agent_id, owner_subject, trigger_kind, status, created_at, finished_at,
        step_id, step_name, error_kind, outcome_code, error,
        input_tokens, output_tokens, tool_calls, attempts, steps_version
      ) VALUES (
        ${input.runId}, ${input.agentId}, ${input.ownerSubject},
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
  /**
   * Wall time of the call(s) this row counts (migration 125): one call for
   * a chat's or a sub-agent's row, one model turn for a run's.
   * Omitted = not measured.
   */
  durationMs?: number | null;
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
          duration_ms:
            typeof input.durationMs === 'number' ? Math.max(0, Math.round(input.durationMs)) : null,
        })
        .execute(),
    'DB_ERROR' as const
  );
  if (!result.ok) return err('DB_ERROR' as const, { cause: result.err });
  return ok(undefined);
}
