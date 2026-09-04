/**
 * chat_messages: read with the envelope opened, written sealed. `seq` is
 * allocated under the chat's row lock by the caller's transaction so two
 * writers cannot collide (the unique constraint would catch them anyway).
 */

import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '@renkei/db';
import type { LlmContentBlock, LlmUsage } from '@renkei/agent-llm';
import { isUuid } from '@/lib/uuid';
import { openBlocks, sealBlocks } from './content-crypto';
import type { MessageKind, MessageRole, MessageStatus, ChatMessageView } from './views';
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
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const MESSAGE_COLUMNS = [
  'id',
  'chat_id',
  'turn_id',
  'seq',
  'role',
  'kind',
  'status',
  'content',
  'llm_model_id',
  'provider',
  'model',
  'stop_reason',
  'usage',
  'error',
  'created_at',
  'updated_at',
] as const;

function roleOf(value: string): MessageRole {
  return value === 'assistant' ? 'assistant' : 'user';
}

function kindOf(value: string): MessageKind {
  return value === 'assistant' || value === 'tool_results' ? value : 'prompt';
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

function rowOf(raw: {
  id: string;
  chat_id: string;
  turn_id: string | null;
  seq: number;
  role: string;
  kind: string;
  status: string;
  content: string;
  llm_model_id: string | null;
  provider: string | null;
  model: string | null;
  stop_reason: string | null;
  usage: unknown;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}): StoredMessage {
  return {
    id: raw.id,
    chatId: raw.chat_id,
    turnId: raw.turn_id,
    seq: raw.seq,
    role: roleOf(raw.role),
    kind: kindOf(raw.kind),
    status: statusOf(raw.status),
    blocks: openBlocks(raw.content),
    llmModelId: raw.llm_model_id,
    provider: raw.provider,
    model: raw.model,
    stopReason: raw.stop_reason,
    usage: usageOf(raw.usage),
    error: raw.error,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export async function listMessages(
  db: Kysely<DB>,
  tenantId: string,
  chatId: string
): Promise<StoredMessage[]> {
  if (!isUuid(chatId)) return [];
  const rows = await db
    .selectFrom('chat_messages')
    .select(MESSAGE_COLUMNS)
    .where('tenant_id', '=', tenantId)
    .where('chat_id', '=', chatId)
    .orderBy('seq', 'asc')
    .execute();
  return rows.map(rowOf);
}

export async function listTurnMessages(
  db: Kysely<DB>,
  tenantId: string,
  turnId: string
): Promise<StoredMessage[]> {
  if (!isUuid(turnId)) return [];
  const rows = await db
    .selectFrom('chat_messages')
    .select(MESSAGE_COLUMNS)
    .where('tenant_id', '=', tenantId)
    .where('turn_id', '=', turnId)
    .orderBy('seq', 'asc')
    .execute();
  return rows.map(rowOf);
}

export interface NewMessage {
  tenantId: string;
  chatId: string;
  turnId: string | null;
  role: MessageRole;
  kind: MessageKind;
  status: MessageStatus;
  blocks: LlmContentBlock[];
  llmModelId?: string | null;
  provider?: string | null;
  model?: string | null;
}

export interface InsertedMessage {
  id: string;
  seq: number;
  createdAt: Date;
}

/**
 * Appends at the next seq. Run inside a transaction that has locked the
 * chat row (`FOR UPDATE`) when two writers could race; the turn runner is
 * the only writer while a turn runs, so it appends without one.
 */
export async function insertMessage(
  db: Kysely<DB> | Transaction<DB>,
  input: NewMessage
): Promise<InsertedMessage | null> {
  const sealed = sealBlocks(input.blocks);
  if (!sealed.ok) return null;
  const inserted = await db
    .insertInto('chat_messages')
    .values({
      tenant_id: input.tenantId,
      chat_id: input.chatId,
      turn_id: input.turnId,
      seq: sql<number>`(SELECT COALESCE(MAX(seq), 0) + 1 FROM chat_messages WHERE chat_id = ${input.chatId})`,
      role: input.role,
      kind: input.kind,
      status: input.status,
      content: sealed.val,
      llm_model_id: input.llmModelId ?? null,
      provider: input.provider ?? null,
      model: input.model ?? null,
    })
    .returning(['id', 'seq', 'created_at'])
    .executeTakeFirstOrThrow();
  return { id: inserted.id, seq: inserted.seq, createdAt: inserted.created_at };
}

export interface AssistantPatch {
  status?: MessageStatus;
  stopReason?: string | null;
  usage?: LlmUsage | null;
  error?: string | null;
}

export async function updateMessageContent(
  db: Kysely<DB>,
  messageId: string,
  blocks: LlmContentBlock[],
  patch: AssistantPatch = {}
): Promise<boolean> {
  const sealed = sealBlocks(blocks);
  if (!sealed.ok) return false;
  await db
    .updateTable('chat_messages')
    .set({
      content: sealed.val,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.stopReason !== undefined ? { stop_reason: patch.stopReason } : {}),
      ...(patch.usage !== undefined ? { usage: patch.usage ? usageJson(patch.usage) : null } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      updated_at: sql<Date>`NOW()`,
    })
    .where('id', '=', messageId)
    .execute();
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
    error: message.error,
    createdAt: message.createdAt.toISOString(),
    attachments: [],
  };
}
