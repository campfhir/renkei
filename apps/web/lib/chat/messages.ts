/**
 * chat_messages: read with the envelope opened, written sealed — under
 * the chat's own cipher (content-crypto.ts, chat-keys.ts), which every
 * caller passes: there is no default, so a row cannot be written under
 * the wrong key by omission. `seq` is allocated by the store at the
 * chat's next place (the unique constraint catches two writers that
 * collide); rows go through `getDataStore().chatThreads`.
 */

import { getDataStore, type ChatMessageInsert, type ChatMessageRecord } from '@renkei/db';
import type { LlmContentBlock, LlmUsage } from '@renkei/agent-llm';
import { isUuid } from '@/lib/uuid';
import { openBlocks, sealBlocks, type ContentCipher } from './content-crypto';
import type {
  MessageKind,
  MessageRole,
  MessageStatus,
  MessageTiming,
  ChatMessageView,
} from './views';
import { toChatBlocks } from './views';

export interface StoredMessage {
  id: string;
  chatId: string;
  turnId: string | null;
  seq: number;
  role: MessageRole;
  kind: MessageKind;
  status: MessageStatus;
  blocks: LlmContentBlock[];
  llmModelId: string | null;
  provider: string | null;
  model: string | null;
  stopReason: string | null;
  usage: LlmUsage | null;
  timing: MessageTiming | null;
  error: string | null;
  /** The compaction pass that folded this message, if any (compaction.ts). */
  summaryId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function roleOf(value: string): MessageRole {
  return value === 'assistant' ? 'assistant' : 'user';
}

function kindOf(value: string): MessageKind {
  return value === 'assistant' || value === 'tool_results' || value === 'nudge' || value === 'note'
    ? value
    : 'prompt';
}

function statusOf(value: string): MessageStatus {
  return value === 'streaming' ||
    value === 'canceled' ||
    value === 'interrupted' ||
    value === 'failed'
    ? value
    : 'complete';
}

function usageOf(value: unknown): LlmUsage | null {
  let parsed: unknown = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record: {
    inputTokens?: unknown;
    outputTokens?: unknown;
    cacheReadInputTokens?: unknown;
    cacheWriteInputTokens?: unknown;
  } = parsed;
  if (typeof record.inputTokens !== 'number' || typeof record.outputTokens !== 'number') {
    return null;
  }
  return {
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    ...(typeof record.cacheReadInputTokens === 'number'
      ? { cacheReadInputTokens: record.cacheReadInputTokens }
      : {}),
    ...(typeof record.cacheWriteInputTokens === 'number'
      ? { cacheWriteInputTokens: record.cacheWriteInputTokens }
      : {}),
  };
}

function timingOf(value: unknown): MessageTiming | null {
  let parsed: unknown = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record: { durationMs?: unknown; firstTokenMs?: unknown } = parsed;
  if (typeof record.durationMs !== 'number') return null;
  return {
    durationMs: record.durationMs,
    firstTokenMs: typeof record.firstTokenMs === 'number' ? record.firstTokenMs : null,
  };
}

function usageJson(usage: LlmUsage): {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
} {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadInputTokens !== undefined
      ? { cacheReadInputTokens: usage.cacheReadInputTokens }
      : {}),
    ...(usage.cacheWriteInputTokens !== undefined
      ? { cacheWriteInputTokens: usage.cacheWriteInputTokens }
      : {}),
  };
}

function rowOf(raw: ChatMessageRecord, cipher: ContentCipher): StoredMessage {
  return {
    id: raw.id,
    chatId: raw.chatId,
    turnId: raw.turnId,
    seq: raw.seq,
    role: roleOf(raw.role),
    kind: kindOf(raw.kind),
    status: statusOf(raw.status),
    blocks: openBlocks(raw.content, cipher),
    llmModelId: raw.llmModelId,
    provider: raw.provider,
    model: raw.model,
    stopReason: raw.stopReason,
    usage: usageOf(raw.usage),
    timing: timingOf(raw.timing),
    error: raw.error,
    summaryId: raw.summaryId,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

export async function listMessages(
  chatId: string,
  cipher: ContentCipher
): Promise<StoredMessage[]> {
  if (!isUuid(chatId)) return [];
  const rows = await getDataStore().chatThreads.listMessages(chatId);
  return rows.map((row) => rowOf(row, cipher));
}

export async function listTurnMessages(
  turnId: string,
  cipher: ContentCipher
): Promise<StoredMessage[]> {
  if (!isUuid(turnId)) return [];
  const rows = await getDataStore().chatThreads.listTurnMessages(turnId);
  return rows.map((row) => rowOf(row, cipher));
}

export interface NewMessage {
  chatId: string;
  turnId: string | null;
  role: MessageRole;
  kind: MessageKind;
  status: MessageStatus;
  blocks: LlmContentBlock[];
  llmModelId?: string | null;
  provider?: string | null;
  model?: string | null;
  /** The chat's cipher (access.cipher, or chat-keys.ts for a process acting as the owner). */
  cipher: ContentCipher;
}

export interface InsertedMessage {
  id: string;
  seq: number;
  createdAt: Date;
}

/** The row as the store takes it, its blocks sealed; null when the chat's key is unavailable. */
export function sealedMessage(input: NewMessage): ChatMessageInsert | null {
  const sealed = sealBlocks(input.blocks, input.cipher);
  if (!sealed.ok) return null;
  return {
    chatId: input.chatId,
    turnId: input.turnId,
    role: input.role,
    kind: input.kind,
    status: input.status,
    content: sealed.val,
    llmModelId: input.llmModelId ?? null,
    provider: input.provider ?? null,
    model: input.model ?? null,
  };
}

/**
 * Appends at the next seq. The turn runner is the only writer while a
 * turn runs, so it appends without a lock; a writer that could race a
 * turn uses `insertMessageWhenIdle`.
 */
export async function insertMessage(input: NewMessage): Promise<InsertedMessage | null> {
  const message = sealedMessage(input);
  if (!message) return null;
  return getDataStore().chatThreads.insertMessage(message);
}

/**
 * Appends at the next seq only while no turn of the chat runs: the runner
 * is the only writer then, and a user-role row landing between a reply's
 * rows would sit where the provider expects a tool result. The store
 * locks the chat row for the check and the insert together, so a turn
 * starting in the same instant waits its turn.
 */
export async function insertMessageWhenIdle(
  input: NewMessage
): Promise<
  { ok: true; inserted: InsertedMessage } | { ok: false; reason: 'turn-running' | 'failed' }
> {
  const message = sealedMessage(input);
  if (!message) return { ok: false, reason: 'failed' };
  const inserted = await getDataStore().chatThreads.insertMessageWhenIdle(message);
  return inserted ? { ok: true, inserted } : { ok: false, reason: 'turn-running' };
}

export interface AssistantPatch {
  status?: MessageStatus;
  stopReason?: string | null;
  usage?: LlmUsage | null;
  timing?: MessageTiming | null;
  error?: string | null;
}

export async function updateMessageContent(
  messageId: string,
  blocks: LlmContentBlock[],
  cipher: ContentCipher,
  patch: AssistantPatch = {}
): Promise<boolean> {
  const sealed = sealBlocks(blocks, cipher);
  if (!sealed.ok) return false;
  await getDataStore().chatThreads.updateMessage(messageId, {
    content: sealed.val,
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.stopReason !== undefined ? { stopReason: patch.stopReason } : {}),
    ...(patch.usage !== undefined ? { usage: patch.usage ? usageJson(patch.usage) : null } : {}),
    ...(patch.timing !== undefined ? { timing: patch.timing ? { ...patch.timing } : null } : {}),
    ...(patch.error !== undefined ? { error: patch.error } : {}),
  });
  return true;
}

export function toMessageView(message: StoredMessage): ChatMessageView {
  return {
    id: message.id,
    turnId: message.turnId,
    seq: message.seq,
    role: message.role,
    kind: message.kind,
    status: message.status,
    blocks: toChatBlocks(message.blocks),
    llmModelId: message.llmModelId,
    provider: message.provider,
    model: message.model,
    stopReason: message.stopReason,
    usage: message.usage,
    timing: message.timing,
    error: message.error,
    createdAt: message.createdAt.toISOString(),
    attachments: [],
  };
}
