/**
 * One turn of the chat: the model answers, calls tools, answers again,
 * until it stops calling tools or a limit says enough.
 *
 * Everything the loop touches is behind an interface — the model (any
 * LlmProvider, via streamOrComplete), the tools (an McpClient and the
 * local set), the rows (TurnStore), the live channel — so the loop is
 * tested against fakes and the same code runs for real. The loop itself
 * is deliberately plain:
 *
 *   stream the reply into the current assistant row, mirroring every
 *   event to the channel and flushing the row on a timer;
 *   if the reply ended with tool calls, run them one by one, store the
 *   results as a user-role `tool_results` row, open a fresh assistant
 *   row, and go again;
 *   otherwise finish.
 *
 * Cancel is checked between chunks (the channel aborts the in-flight
 * request) and between tool calls (the heartbeat reads the row, so a
 * cancel clicked on another replica lands within a flush interval).
 * A crash leaves the rows `streaming`/`running` for the janitor.
 */

import {
  streamOrComplete,
  type LlmContentBlock,
  type LlmErrorKind,
  type LlmMessage,
  type LlmStreamEvent,
  type LlmToolDef,
  type LlmUsage,
  type ResolvedLlm,
} from '@renkei/agent-llm';
import type { McpClient, McpToolResult } from '@renkei/mcp-client';
import type { LocalToolContext, LocalToolSet } from './local-tools';
import type { ChatStreamEvent } from './stream-events';
import type { TurnChannel } from './turn-events';
import type { AttachmentView } from './views';
import { toChatBlock } from './views';
import type { MessageStatus, TurnStatus } from './views';

export interface TurnStore {
  /** Appends a row at the chat's next seq; returns its id, seq and time. */
  appendMessage(input: {
    role: 'user' | 'assistant';
    kind: 'assistant' | 'tool_results';
    status: MessageStatus;
    blocks: LlmContentBlock[];
  }): Promise<{ id: string; seq: number; createdAt: Date }>;
  flushAssistant(
    id: string,
    blocks: LlmContentBlock[],
    patch: {
      status?: MessageStatus;
      stopReason?: string | null;
      usage?: LlmUsage | null;
      error?: string | null;
    }
  ): Promise<void>;
  /** Refreshes the turn's liveness; true when a cancel was requested. */
  heartbeat(iterations: number): Promise<boolean>;
  finishTurn(outcome: TurnOutcome): Promise<void>;
  recordUsage(usage: LlmUsage): Promise<void>;
  /**
   * Keeps the files a tool round handed back, hung off the results row;
   * returns what was kept (an unconfigured store keeps nothing).
   */
  storeArtifacts(messageId: string, files: ArtifactFile[]): Promise<AttachmentView[]>;
}

/** A file a tool produced, as it came back in `_meta.renkeiDocuments`. */
export interface ArtifactFile {
  filename: string;
  mediaType: string;
  dataBase64: string;
}

export interface TurnOutcome {
  status: Exclude<TurnStatus, 'running'>;
  error: string | null;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
}

export interface TurnLimits {
  wallClockMs: number;
  maxIterations: number;
  flushMs: number;
  toolTimeoutMs: number;
  /** Tool results longer than this are clipped before they reach the model. */
  toolResultMaxChars: number;
  attachmentMaxBlocks: number;
  attachmentMaxBase64Chars: number;
}

export const DEFAULT_TURN_LIMITS: TurnLimits = {
  wallClockMs: 10 * 60_000,
  maxIterations: 25,
  flushMs: 250,
  toolTimeoutMs: 120_000,
  toolResultMaxChars: 60_000,
  attachmentMaxBlocks: 2,
  attachmentMaxBase64Chars: 6_000_000,
};

export interface TurnRunnerDeps {
  llm: ResolvedLlm;
  tools: LlmToolDef[];
  mcp: McpClient | null;
  localTools: LocalToolSet;
  localContext: LocalToolContext;
  channel: TurnChannel;
  store: TurnStore;
  now?: () => number;
  limits?: Partial<TurnLimits>;
  log?: (message: string, fields: Record<string, unknown>) => void;
}

export interface TurnInput {
  turnId: string;
  assistantMessage: { id: string; seq: number; createdAt: Date };
  system: string;
  history: LlmMessage[];
  thinkingBudget: number | null;
}

const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const EXTENSION_BY_MEDIA_TYPE: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'text/tab-separated-values': '.tsv',
  'text/markdown': '.md',
  'text/html': '.html',
  'application/json': '.json',
  'application/xml': '.xml',
  'application/yaml': '.yaml',
};

/**
 * Every file a tool handed back in `_meta.renkeiDocuments`, for keeping —
 * unlike `attachmentBlocksOfMeta`, which picks what the model gets to see
 * under the turn's budget. A file without a title is named after the tool.
 */
export function artifactsOfMeta(
  meta: Record<string, unknown>,
  toolName: string,
  ordinal: number
): ArtifactFile[] {
  const raw = meta.renkeiDocuments;
  if (!Array.isArray(raw)) return [];
  const out: ArtifactFile[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record: { mediaType?: unknown; dataBase64?: unknown; title?: unknown } = entry;
    if (typeof record.mediaType !== 'string' || typeof record.dataBase64 !== 'string') continue;
    if (!record.dataBase64) continue;
    const title = typeof record.title === 'string' && record.title.trim() ? record.title : null;
    const extension = EXTENSION_BY_MEDIA_TYPE[record.mediaType] ?? '';
    out.push({
      filename: title ?? `${toolName}-${ordinal}-${out.length + 1}${extension}`,
      mediaType: record.mediaType,
      dataBase64: record.dataBase64,
    });
  }
  return out;
}

/**
 * Document/image blocks a tool handed back in `_meta.renkeiDocuments` —
 * the agents engine's rule, under the chat's smaller budget.
 */
export function attachmentBlocksOfMeta(
  meta: Record<string, unknown>,
  budget: { blocks: number; base64Chars: number },
  limits: TurnLimits
): LlmContentBlock[] {
  const raw = meta.renkeiDocuments;
  if (!Array.isArray(raw)) return [];
  const out: LlmContentBlock[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record: { mediaType?: unknown; dataBase64?: unknown; title?: unknown } = entry;
    if (typeof record.mediaType !== 'string' || typeof record.dataBase64 !== 'string') continue;
    if (!record.dataBase64) continue;
    if (budget.blocks >= limits.attachmentMaxBlocks) break;
    if (budget.base64Chars + record.dataBase64.length > limits.attachmentMaxBase64Chars) continue;
    const title = typeof record.title === 'string' && record.title ? record.title : undefined;
    if (record.mediaType === 'application/pdf') {
      out.push({
        type: 'document',
        mediaType: record.mediaType,
        dataBase64: record.dataBase64,
        ...(title ? { title } : {}),
      });
    } else if (IMAGE_MEDIA_TYPES.has(record.mediaType)) {
      out.push({ type: 'image', mediaType: record.mediaType, dataBase64: record.dataBase64 });
    } else {
      continue;
    }
    budget.blocks += 1;
    budget.base64Chars += record.dataBase64.length;
  }
  return out;
}

export function textOfResult(result: McpToolResult): string {
  return result.content
    .flatMap((block) => (typeof block.text === 'string' ? [block.text] : []))
    .join('\n');
}

export function friendlyLlmError(kind: LlmErrorKind): string {
  switch (kind) {
    case 'auth':
      return "The organization's model key was rejected. An administrator can check it under Agent models.";
    case 'rate_limit':
      return 'The model provider is rate-limiting requests. Try again in a moment.';
    case 'overloaded':
      return 'The model provider is overloaded right now. Try again in a moment.';
    case 'invalid_request':
      return 'The model rejected the request. If this keeps happening with one model, try another.';
    case 'timeout':
      return 'The model took too long to answer.';
    case 'network':
      return 'The model provider could not be reached.';
    case 'aborted':
      return 'Stopped.';
    default:
      return 'The model provider returned an error.';
  }
}

function clip(text: string, max: number): string {
  return text.length > max
    ? `${text.slice(0, max)}\n…[${text.length - max} more characters clipped]`
    : text;
}

function argsOf(input: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    for (const [key, value] of Object.entries(input)) out[key] = value;
  }
  return out;
}

export async function runChatTurn(deps: TurnRunnerDeps, input: TurnInput): Promise<TurnOutcome> {
  const limits: TurnLimits = { ...DEFAULT_TURN_LIMITS, ...deps.limits };
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  const deadline = now() + limits.wallClockMs;
  const { channel, store, llm } = deps;

  const messages: LlmMessage[] = [...input.history];
  let assistant = input.assistantMessage;
  let blocks: LlmContentBlock[] = [];
  let dirty = false;
  let iterations = 0;
  const totals = { inputTokens: 0, outputTokens: 0 };
  const attachmentBudget = { blocks: 0, base64Chars: 0 };
  let cancelRequested = false;

  const emit = (event: ChatStreamEvent) => channel.emit(event);

  const flush = async (patch: Parameters<TurnStore['flushAssistant']>[2] = {}) => {
    dirty = false;
    await store.flushAssistant(assistant.id, blocks, patch);
  };

  // The heartbeat doubles as the flush timer: liveness and durability on
  // the same cadence, and a cancel from another replica read on the way.
  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    if (dirty) void flush();
    if (tick % 8 === 0) {
      void store.heartbeat(iterations).then((requested) => {
        if (requested) {
          cancelRequested = true;
          channel.requestCancel();
        }
      });
    }
  }, limits.flushMs);
  channel.onCancel(() => {
    cancelRequested = true;
  });

  const finalize = async (
    status: TurnOutcome['status'],
    error: string | null,
    assistantStatus: MessageStatus
  ): Promise<TurnOutcome> => {
    clearInterval(timer);
    await flush({ status: assistantStatus, error });
    emit({
      type: 'message_end',
      messageId: assistant.id,
      status: assistantStatus,
      stopReason: null,
      usage: null,
      error,
    });
    const outcome: TurnOutcome = { status, error, iterations, ...totals };
    await store.finishTurn(outcome);
    emit({ type: 'turn_end', turnId: input.turnId, status, error });
    channel.close();
    return outcome;
  };

  const announceAssistant = () =>
    emit({
      type: 'message_start',
      messageId: assistant.id,
      turnId: input.turnId,
      seq: assistant.seq,
      role: 'assistant',
      kind: 'assistant',
      llmModelId: llm.modelConfigId,
      provider: llm.providerName,
      model: llm.model,
      createdAt: assistant.createdAt.toISOString(),
    });

  announceAssistant();

  try {
    for (;;) {
      if (cancelRequested || channel.cancelRequested)
        return await finalize('canceled', null, 'canceled');
      if (now() > deadline) {
        return await finalize(
          'interrupted',
          'The reply exceeded its time budget and was stopped.',
          'interrupted'
        );
      }
      if (iterations >= limits.maxIterations) {
        return await finalize(
          'failed',
          'The reply made too many tool calls in one turn.',
          'failed'
        );
      }
      iterations += 1;

      const controller = new AbortController();
      channel.onCancel(() => controller.abort());
      // A block's final form (tool input parsed) is what the accumulator
      // holds; mirror it to the view on block_stop.
      const mirror = (event: LlmStreamEvent) => {
        switch (event.type) {
          case 'block_start':
            blocks[event.index] = { ...event.block };
            emit({
              type: 'block_start',
              messageId: assistant.id,
              index: event.index,
              block: toChatBlock(event.block),
            });
            break;
          case 'text_delta': {
            const block = blocks[event.index];
            if (block?.type === 'text')
              blocks[event.index] = { type: 'text', text: block.text + event.text };
            emit({
              type: 'text_delta',
              messageId: assistant.id,
              index: event.index,
              text: event.text,
            });
            break;
          }
          case 'thinking_delta': {
            const block = blocks[event.index];
            if (block?.type === 'thinking') {
              blocks[event.index] = { ...block, thinking: block.thinking + event.thinking };
            }
            emit({
              type: 'thinking_delta',
              messageId: assistant.id,
              index: event.index,
              thinking: event.thinking,
            });
            break;
          }
          case 'signature_delta': {
            const block = blocks[event.index];
            if (block?.type === 'thinking') {
              blocks[event.index] = {
                ...block,
                signature: (block.signature ?? '') + event.signature,
              };
            }
            break;
          }
          case 'input_json_delta':
            emit({
              type: 'input_json_delta',
              messageId: assistant.id,
              index: event.index,
              partialJson: event.partialJson,
            });
            break;
          case 'block_stop':
            // The parsed input arrives with the assembled response below;
            // the view learns it there.
            break;
          default:
            break;
        }
        dirty = true;
      };

      const result = await streamOrComplete(
        llm.provider,
        {
          system: input.system,
          messages,
          tools: deps.tools,
          ...(deps.tools.length > 0 ? { toolChoice: 'auto' as const } : {}),
          maxTokens: llm.maxOutputTokens,
          ...(llm.temperature !== undefined ? { temperature: llm.temperature } : {}),
          ...(input.thinkingBudget ? { thinking: { budgetTokens: input.thinkingBudget } } : {}),
          promptCache: true,
          timeoutMs: 300_000,
        },
        { onEvent: mirror, signal: controller.signal }
      );

      if (!result.ok) {
        if (result.err.type === 'aborted' || cancelRequested) {
          return await finalize('canceled', null, 'canceled');
        }
        log('chat turn model error: {kind} {message}', {
          kind: result.err.type,
          message: result.err.message ?? '',
        });
        return await finalize('failed', friendlyLlmError(result.err.type), 'failed');
      }

      const reply = result.val;
      totals.inputTokens += reply.usage.inputTokens;
      totals.outputTokens += reply.usage.outputTokens;
      await store.recordUsage(reply.usage);
      // The assembled response is canonical: tool input parsed, nothing
      // the mirror might have missed.
      blocks = reply.content;
      reply.content.forEach((block, index) => {
        if (block.type === 'tool_use') {
          emit({ type: 'block_stop', messageId: assistant.id, index, block: toChatBlock(block) });
        } else {
          emit({ type: 'block_stop', messageId: assistant.id, index });
        }
      });
      await flush({
        status: 'complete',
        stopReason: reply.stopReason,
        usage: reply.usage,
        error: null,
      });
      emit({
        type: 'message_end',
        messageId: assistant.id,
        status: 'complete',
        stopReason: reply.stopReason,
        usage: reply.usage,
        error: null,
      });
      messages.push({ role: 'assistant', content: reply.content });

      const toolUses = reply.content.filter(
        (block): block is Extract<LlmContentBlock, { type: 'tool_use' }> =>
          block.type === 'tool_use'
      );
      if (reply.stopReason !== 'tool_use' || toolUses.length === 0) {
        clearInterval(timer);
        const outcome: TurnOutcome = { status: 'completed', error: null, iterations, ...totals };
        await store.finishTurn(outcome);
        emit({ type: 'turn_end', turnId: input.turnId, status: 'completed', error: null });
        channel.close();
        return outcome;
      }

      // Tool round: sequential, like the engine — a tool's effect may be
      // what the next one reads.
      const results: LlmContentBlock[] = [];
      const attachments: LlmContentBlock[] = [];
      const produced: ArtifactFile[] = [];
      for (const use of toolUses) {
        if (cancelRequested || channel.cancelRequested) break;
        emit({
          type: 'tool_call_start',
          messageId: assistant.id,
          toolUseId: use.id,
          name: use.name,
        });
        let outcome: McpToolResult;
        try {
          if (deps.localTools.has(use.name)) {
            outcome = await deps.localTools.run(use.name, use.input, deps.localContext);
          } else if (deps.mcp) {
            outcome = await deps.mcp.callTool(use.name, argsOf(use.input), limits.toolTimeoutMs);
          } else {
            outcome = {
              content: [
                { type: 'text', text: `The tool ${use.name} is not available in this chat.` },
              ],
              isError: true,
              meta: {},
            };
          }
        } catch (error) {
          log('chat tool call failed: {tool} {message}', {
            tool: use.name,
            message: error instanceof Error ? error.message : String(error),
          });
          outcome = {
            content: [{ type: 'text', text: 'The tool could not be reached.' }],
            isError: true,
            meta: {},
          };
        }
        const text = textOfResult(outcome);
        results.push({
          type: 'tool_result',
          toolUseId: use.id,
          content: clip(
            text || (outcome.isError ? 'The tool failed.' : '(no output)'),
            limits.toolResultMaxChars
          ),
          ...(outcome.isError ? { isError: true } : {}),
        });
        attachments.push(...attachmentBlocksOfMeta(outcome.meta, attachmentBudget, limits));
        produced.push(...artifactsOfMeta(outcome.meta, use.name, iterations));
      }
      if (cancelRequested || channel.cancelRequested) {
        // Whatever ran, ran; the transcript keeps the calls without answers
        // and the history builder drops the dangling tool_use next time.
        clearInterval(timer);
        const outcome: TurnOutcome = { status: 'canceled', error: null, iterations, ...totals };
        await store.finishTurn(outcome);
        emit({ type: 'turn_end', turnId: input.turnId, status: 'canceled', error: null });
        channel.close();
        return outcome;
      }
      // Every tool_use must be answered; a break above cannot leave one
      // unanswered because we returned.
      const resultBlocks: LlmContentBlock[] = [...results, ...attachments];
      const resultsRow = await store.appendMessage({
        role: 'user',
        kind: 'tool_results',
        status: 'complete',
        blocks: resultBlocks,
      });
      emit({
        type: 'message_start',
        messageId: resultsRow.id,
        turnId: input.turnId,
        seq: resultsRow.seq,
        role: 'user',
        kind: 'tool_results',
        llmModelId: null,
        provider: null,
        model: null,
        createdAt: resultsRow.createdAt.toISOString(),
      });
      resultBlocks.forEach((block, index) => {
        emit({ type: 'block_start', messageId: resultsRow.id, index, block: toChatBlock(block) });
        emit({ type: 'block_stop', messageId: resultsRow.id, index });
      });
      emit({
        type: 'message_end',
        messageId: resultsRow.id,
        status: 'complete',
        stopReason: null,
        usage: null,
        error: null,
      });
      messages.push({ role: 'user', content: resultBlocks });
      if (produced.length > 0) {
        try {
          for (const artifact of await store.storeArtifacts(resultsRow.id, produced)) {
            emit({ type: 'artifact', messageId: resultsRow.id, attachment: artifact });
          }
        } catch (error) {
          // A file that could not be kept is not a reason to stop answering.
          log('chat artifact not stored: {message}', {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const nextRow = await store.appendMessage({
        role: 'assistant',
        kind: 'assistant',
        status: 'streaming',
        blocks: [],
      });
      assistant = nextRow;
      blocks = [];
      dirty = false;
      announceAssistant();
    }
  } catch (error) {
    log('chat turn crashed: {message}', {
      message: error instanceof Error ? error.message : String(error),
    });
    try {
      return await finalize('failed', 'Something went wrong while answering.', 'failed');
    } catch {
      clearInterval(timer);
      channel.close();
      return {
        status: 'failed',
        error: 'Something went wrong while answering.',
        iterations,
        ...totals,
      };
    }
  }
}
