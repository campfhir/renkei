/**
 * What a code chat's sub-agents did — `chat_subagent_runs` (migration 112).
 *
 * `code_delegate` (lib/code/delegate.ts) runs a model loop of its own
 * and hands the orchestrating chat one report; only that report enters
 * the chat's transcript and, from then on, its context. The sub-agent's
 * own transcript — every model reply, every tool call and result — is
 * kept HERE instead, sealed like a chat's messages, keyed by the
 * tool_use id of the delegating call: a person opens the call in the
 * thread and sees the steps; a run still going is followed by its
 * counters. Nothing here is ever read back into a model's context.
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { LlmContentBlock, LlmMessage, LlmUsage } from '@renkei/agent-llm';
import type { LlmCallModel } from '@renkei/agents/runs';
import { isUuid } from '@/lib/uuid';
import { openText, parseBlock, sealText } from './content-crypto';
import { toChatBlocks, type ChatBlock } from './views';

export type SubagentRunStatus = 'running' | 'completed' | 'failed' | 'interrupted';

/** How a run reads in the browser: the sealed columns opened, the transcript as chat blocks. */
export interface SubagentRunView {
  id: string;
  toolUseId: string;
  turnId: string;
  status: SubagentRunStatus;
  task: string;
  instructions: string | null;
  readOnly: boolean;
  /**
   * The model the sub-agent ran on (migration 118): the provider and
   * model name as resolved at the time, and the config's label as it is
   * now — null when the config has since been removed. Null altogether
   * on a run recorded before models were, which ran on its turn's.
   */
  model: { provider: string; model: string; label: string | null } | null;
  steps: number;
  maxSteps: number;
  toolCalls: number;
  lastTool: string | null;
  /**
   * The sub-agent's own conversation, in order: the model's rows and the
   * results fed back. An assistant row carries how long its model call
   * took (delegate.ts stamps it on the message it keeps); a tool result's
   * own duration rides on the block, as in a chat.
   */
  transcript: { role: 'user' | 'assistant'; blocks: ChatBlock[]; durationMs?: number }[];
  report: string | null;
  error: string | null;
  usage: { inputTokens: number; outputTokens: number };
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

/**
 * What the delegate loop tells while it runs, and the turn store wires
 * to the table and the stream (start-turn.ts). Absent from a context,
 * the loop simply does not record — a test against fakes, say.
 */
export interface SubagentRecorder {
  /** The run row for this delegation; null when it could not be written (the loop goes on). */
  start(input: {
    toolUseId: string;
    task: string;
    instructions: string | null;
    readOnly: boolean;
    maxSteps: number;
    /** What the sub-agent runs on — the turn's own model, or the one the orchestrator picked. */
    model: LlmCallModel | null;
  }): Promise<string | null>;
  /** After each model call: how far it is and what it last reached for. */
  progress(
    runId: string,
    state: { steps: number; toolCalls: number; lastTool: string | null; usage: LlmUsage }
  ): Promise<void>;
  /** The end: the whole transcript, the report the chat gets, and how it ended. */
  finish(
    runId: string,
    outcome: {
      status: Exclude<SubagentRunStatus, 'running'>;
      transcript: LlmMessage[];
      report: string | null;
      error: string | null;
      steps: number;
      toolCalls: number;
    }
  ): Promise<void>;
}

function statusOf(value: string): SubagentRunStatus {
  return value === 'completed' || value === 'failed' || value === 'interrupted' ? value : 'running';
}

/** A transcript as stored: role and blocks per message, sealed as one JSON text. */
function sealTranscript(messages: LlmMessage[]): string | null {
  const sealed = sealText(JSON.stringify(messages));
  return sealed.ok ? sealed.val : null;
}

/** The stored transcript, opened and parsed block by block; anything unreadable is dropped. */
export function parseTranscript(json: string): SubagentRunView['transcript'] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: SubagentRunView['transcript'] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record: { role?: unknown; content?: unknown; durationMs?: unknown } = entry;
    if (record.role !== 'user' && record.role !== 'assistant') continue;
    if (!Array.isArray(record.content)) continue;
    const blocks = record.content
      .map(parseBlock)
      .filter((block): block is LlmContentBlock => block !== null);
    out.push({
      role: record.role,
      blocks: toChatBlocks(blocks),
      ...(typeof record.durationMs === 'number' ? { durationMs: record.durationMs } : {}),
    });
  }
  return out;
}

export async function createSubagentRun(
  db: Kysely<DB>,
  input: {
    tenantId: string;
    chatId: string;
    turnId: string;
    toolUseId: string;
    task: string;
    instructions: string | null;
    readOnly: boolean;
    maxSteps: number;
    model: LlmCallModel | null;
  }
): Promise<string | null> {
  const task = sealText(input.task);
  if (!task.ok) return null;
  const instructions = input.instructions ? sealText(input.instructions) : null;
  if (instructions && !instructions.ok) return null;
  const inserted = await db
    .insertInto('chat_subagent_runs')
    .values({
      tenant_id: input.tenantId,
      chat_id: input.chatId,
      turn_id: input.turnId,
      tool_use_id: input.toolUseId,
      task: task.val,
      instructions: instructions ? instructions.val : null,
      read_only: input.readOnly,
      max_steps: input.maxSteps,
      llm_model_id: input.model?.llmModelId ?? null,
      provider: input.model?.provider ?? null,
      model: input.model?.model ?? null,
    })
    // A tool_use id is unique per chat; a retry of the same call replaces its row.
    .onConflict((oc) =>
      oc.columns(['chat_id', 'tool_use_id']).doUpdateSet({
        turn_id: input.turnId,
        status: 'running',
        task: task.val,
        instructions: instructions ? instructions.val : null,
        read_only: input.readOnly,
        max_steps: input.maxSteps,
        llm_model_id: input.model?.llmModelId ?? null,
        provider: input.model?.provider ?? null,
        model: input.model?.model ?? null,
        steps: 0,
        tool_calls: 0,
        last_tool: null,
        transcript: null,
        report: null,
        error: null,
        input_tokens: 0,
        output_tokens: 0,
        started_at: sql<Date>`NOW()`,
        updated_at: sql<Date>`NOW()`,
        finished_at: null,
      })
    )
    .returning('id')
    .executeTakeFirst();
  return inserted?.id ?? null;
}

export async function progressSubagentRun(
  db: Kysely<DB>,
  runId: string,
  state: { steps: number; toolCalls: number; lastTool: string | null; usage: LlmUsage }
): Promise<void> {
  await db
    .updateTable('chat_subagent_runs')
    .set({
      steps: state.steps,
      tool_calls: state.toolCalls,
      last_tool: state.lastTool,
      input_tokens: sql<number>`input_tokens + ${state.usage.inputTokens}`,
      output_tokens: sql<number>`output_tokens + ${state.usage.outputTokens}`,
      updated_at: sql<Date>`NOW()`,
    })
    .where('id', '=', runId)
    .where('status', '=', 'running')
    .execute();
}

export async function finishSubagentRun(
  db: Kysely<DB>,
  runId: string,
  outcome: {
    status: Exclude<SubagentRunStatus, 'running'>;
    transcript: LlmMessage[];
    report: string | null;
    error: string | null;
    steps: number;
    toolCalls: number;
  }
): Promise<void> {
  const report = outcome.report ? sealText(outcome.report) : null;
  await db
    .updateTable('chat_subagent_runs')
    .set({
      status: outcome.status,
      steps: outcome.steps,
      tool_calls: outcome.toolCalls,
      transcript: sealTranscript(outcome.transcript),
      report: report && report.ok ? report.val : null,
      error: outcome.error,
      updated_at: sql<Date>`NOW()`,
      finished_at: sql<Date>`NOW()`,
    })
    .where('id', '=', runId)
    .execute();
}

/** A turn that ends takes any run of its still marked running with it: nothing is coming back. */
export async function interruptSubagentRunsOfTurn(db: Kysely<DB>, turnId: string): Promise<void> {
  await db
    .updateTable('chat_subagent_runs')
    .set({
      status: 'interrupted',
      error: 'The turn ended before the sub-agent reported.',
      updated_at: sql<Date>`NOW()`,
      finished_at: sql<Date>`NOW()`,
    })
    .where('turn_id', '=', turnId)
    .where('status', '=', 'running')
    .execute();
}

/** One run by the call that made it, as the browser sees it; null when there is none. */
export async function getSubagentRunByCall(
  db: Kysely<DB>,
  tenantId: string,
  chatId: string,
  toolUseId: string
): Promise<SubagentRunView | null> {
  if (!isUuid(chatId) || !toolUseId) return null;
  const row = await db
    .selectFrom('chat_subagent_runs')
    // The config's label as it reads today; the name columns are the
    // record, and stand alone once the config is gone.
    .leftJoin('llm_model_configs', 'llm_model_configs.id', 'chat_subagent_runs.llm_model_id')
    .selectAll('chat_subagent_runs')
    .select('llm_model_configs.label as model_label')
    .where('chat_subagent_runs.tenant_id', '=', tenantId)
    .where('chat_subagent_runs.chat_id', '=', chatId)
    .where('chat_subagent_runs.tool_use_id', '=', toolUseId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
    toolUseId: row.tool_use_id,
    turnId: row.turn_id,
    status: statusOf(row.status),
    task: openText(row.task),
    instructions: row.instructions ? openText(row.instructions) : null,
    readOnly: row.read_only,
    model:
      row.provider && row.model
        ? { provider: row.provider, model: row.model, label: row.model_label ?? null }
        : null,
    steps: row.steps,
    maxSteps: row.max_steps,
    toolCalls: row.tool_calls,
    lastTool: row.last_tool,
    transcript: row.transcript ? parseTranscript(openText(row.transcript)) : [],
    report: row.report ? openText(row.report) : null,
    error: row.error,
    usage: { inputTokens: row.input_tokens, outputTokens: row.output_tokens },
    startedAt: row.started_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
  };
}

/** The recorder over the real table and the turn's stream (start-turn.ts wires it). */
export function createSubagentRecorder(
  db: Kysely<DB>,
  scope: { tenantId: string; chatId: string; turnId: string },
  emit: (event: {
    toolUseId: string;
    status: SubagentRunStatus;
    steps: number;
    maxSteps: number;
    toolCalls: number;
    lastTool: string | null;
  }) => void,
  log: (message: string, fields: Record<string, unknown>) => void = () => {}
): SubagentRecorder {
  // What each run id was started with, for the stream's events.
  const known = new Map<string, { toolUseId: string; maxSteps: number }>();
  const quietly = async (what: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      log(`chat sub-agent run not recorded (${what}): {message}`, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  return {
    async start(input) {
      let id: string | null = null;
      await quietly('start', async () => {
        id = await createSubagentRun(db, { ...scope, ...input });
      });
      if (id) known.set(id, { toolUseId: input.toolUseId, maxSteps: input.maxSteps });
      emit({
        toolUseId: input.toolUseId,
        status: 'running',
        steps: 0,
        maxSteps: input.maxSteps,
        toolCalls: 0,
        lastTool: null,
      });
      return id;
    },
    async progress(runId, state) {
      await quietly('progress', () => progressSubagentRun(db, runId, state));
      const run = known.get(runId);
      if (run) {
        emit({
          toolUseId: run.toolUseId,
          status: 'running',
          steps: state.steps,
          maxSteps: run.maxSteps,
          toolCalls: state.toolCalls,
          lastTool: state.lastTool,
        });
      }
    },
    async finish(runId, outcome) {
      await quietly('finish', () => finishSubagentRun(db, runId, outcome));
      const run = known.get(runId);
      if (run) {
        emit({
          toolUseId: run.toolUseId,
          status: outcome.status,
          steps: outcome.steps,
          maxSteps: run.maxSteps,
          toolCalls: outcome.toolCalls,
          lastTool: null,
        });
      }
    },
  };
}
