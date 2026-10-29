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

import { getDataStore } from '@renkei/db';
import type { LlmContentBlock, LlmMessage, LlmUsage } from '@renkei/agent-llm';
import type { LlmCallModel } from '@renkei/agents/runs';
import { isUuid } from '@/lib/uuid';
import { openText, parseBlock, sealText, type ContentCipher } from './content-crypto';
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
function sealTranscript(messages: LlmMessage[], cipher: ContentCipher): string | null {
  const sealed = sealText(JSON.stringify(messages), cipher);
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

export async function createSubagentRun(input: {
  chatId: string;
  turnId: string;
  toolUseId: string;
  task: string;
  instructions: string | null;
  readOnly: boolean;
  maxSteps: number;
  model: LlmCallModel | null;
  /** The chat's cipher: a run's rows are sealed like the chat's own. */
  cipher: ContentCipher;
}): Promise<string | null> {
  const task = sealText(input.task, input.cipher);
  if (!task.ok) return null;
  const instructions = input.instructions ? sealText(input.instructions, input.cipher) : null;
  if (instructions && !instructions.ok) return null;
  // A tool_use id is unique per chat; a retry of the same call replaces its row.
  return getDataStore().chatThreads.startSubagentRun({
    chatId: input.chatId,
    turnId: input.turnId,
    toolUseId: input.toolUseId,
    task: task.val,
    instructions: instructions ? instructions.val : null,
    readOnly: input.readOnly,
    maxSteps: input.maxSteps,
    llmModelId: input.model?.llmModelId ?? null,
    provider: input.model?.provider ?? null,
    model: input.model?.model ?? null,
  });
}

export async function progressSubagentRun(
  runId: string,
  state: { steps: number; toolCalls: number; lastTool: string | null; usage: LlmUsage }
): Promise<void> {
  await getDataStore().chatThreads.progressSubagentRun(runId, {
    steps: state.steps,
    toolCalls: state.toolCalls,
    lastTool: state.lastTool,
    inputTokens: state.usage.inputTokens,
    outputTokens: state.usage.outputTokens,
  });
}

export async function finishSubagentRun(
  runId: string,
  outcome: {
    status: Exclude<SubagentRunStatus, 'running'>;
    transcript: LlmMessage[];
    report: string | null;
    error: string | null;
    steps: number;
    toolCalls: number;
  },
  cipher: ContentCipher
): Promise<void> {
  const report = outcome.report ? sealText(outcome.report, cipher) : null;
  await getDataStore().chatThreads.finishSubagentRun(runId, {
    status: outcome.status,
    steps: outcome.steps,
    toolCalls: outcome.toolCalls,
    transcript: sealTranscript(outcome.transcript, cipher),
    report: report && report.ok ? report.val : null,
    error: outcome.error,
  });
}

/** A turn that ends takes any run of its still marked running with it: nothing is coming back. */
export async function interruptSubagentRunsOfTurn(turnId: string): Promise<void> {
  await getDataStore().chatThreads.interruptSubagentRuns(
    turnId,
    'The turn ended before the sub-agent reported.'
  );
}

/** One run by the call that made it, as the browser sees it; null when there is none. */
export async function getSubagentRunByCall(
  chatId: string,
  toolUseId: string,
  cipher: ContentCipher
): Promise<SubagentRunView | null> {
  if (!isUuid(chatId) || !toolUseId) return null;
  const row = await getDataStore().chatThreads.getSubagentRunByCall(chatId, toolUseId);
  if (!row) return null;
  return {
    id: row.id,
    toolUseId: row.toolUseId,
    turnId: row.turnId,
    status: statusOf(row.status),
    task: openText(row.task, cipher),
    instructions: row.instructions ? openText(row.instructions, cipher) : null,
    readOnly: row.readOnly,
    model:
      row.provider && row.model
        ? { provider: row.provider, model: row.model, label: row.modelLabel }
        : null,
    steps: row.steps,
    maxSteps: row.maxSteps,
    toolCalls: row.toolCalls,
    lastTool: row.lastTool,
    transcript: row.transcript ? parseTranscript(openText(row.transcript, cipher)) : [],
    report: row.report ? openText(row.report, cipher) : null,
    error: row.error,
    usage: { inputTokens: row.inputTokens, outputTokens: row.outputTokens },
    startedAt: row.startedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}

/** The recorder over the real table and the turn's stream (start-turn.ts wires it). */
export function createSubagentRecorder(
  scope: { chatId: string; turnId: string; cipher: ContentCipher },
  emit: (event: {
    toolUseId: string;
    status: SubagentRunStatus;
    steps: number;
    maxSteps: number;
    toolCalls: number;
    lastTool: string | null;
    startedAt: number;
    finishedAt: number | null;
  }) => void,
  log: (message: string, fields: Record<string, unknown>) => void = () => {}
): SubagentRecorder {
  // What each run id was started with, for the stream's events.
  const known = new Map<string, { toolUseId: string; maxSteps: number; startedAt: number }>();
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
        id = await createSubagentRun({ ...scope, ...input });
      });
      const startedAt = Date.now();
      if (id) known.set(id, { toolUseId: input.toolUseId, maxSteps: input.maxSteps, startedAt });
      emit({
        toolUseId: input.toolUseId,
        status: 'running',
        steps: 0,
        maxSteps: input.maxSteps,
        toolCalls: 0,
        lastTool: null,
        startedAt,
        finishedAt: null,
      });
      return id;
    },
    async progress(runId, state) {
      await quietly('progress', () => progressSubagentRun(runId, state));
      const run = known.get(runId);
      if (run) {
        emit({
          toolUseId: run.toolUseId,
          status: 'running',
          steps: state.steps,
          maxSteps: run.maxSteps,
          toolCalls: state.toolCalls,
          lastTool: state.lastTool,
          startedAt: run.startedAt,
          finishedAt: null,
        });
      }
    },
    async finish(runId, outcome) {
      await quietly('finish', () => finishSubagentRun(runId, outcome, scope.cipher));
      const run = known.get(runId);
      if (run) {
        emit({
          toolUseId: run.toolUseId,
          status: outcome.status,
          steps: outcome.steps,
          maxSteps: run.maxSteps,
          toolCalls: outcome.toolCalls,
          lastTool: null,
          startedAt: run.startedAt,
          finishedAt: Date.now(),
        });
      }
    },
  };
}
