/**
 * Chat compaction — keeps a long chat's history EXPRESSIBLE within a
 * model's context, the same problem agent memory solves (@renkei/agents,
 * apps/worker-agents/src/memory-compaction.ts) applied to chat_messages
 * instead of agent_memories.
 *
 * A pass folds the oldest messages that sit outside the always-verbatim
 * recent window into one new chat_summaries row, merging in the previous
 * summary's text (if any) so the chain never needs replaying — only the
 * newest summary is ever read back (latestChatSummary). The folded
 * messages are attributed to the summary that read them (summary_id) and
 * never sent again: buildHistory (request-builder.ts) excludes any message
 * with a summary_id set.
 *
 * Three ways a pass starts, all going through compactChat:
 *  - auto: start-turn.ts checks needsCompaction before every turn's
 *    buildHistory and compacts first when the unfolded history has grown
 *    past the threshold — the guarantee that a turn's own request stays
 *    bounded, not a background sweep.
 *  - tool: the model calls the chat_compact local tool (compaction-tools.ts)
 *    when it judges the conversation is getting long — effective from the
 *    NEXT turn on, since the turn already in flight built its history
 *    before the call.
 *  - user: a person forces it directly (the compact API route).
 *
 * Failure posture matches memory-compaction.ts: a failed or unavailable
 * model leaves every message as it was, for the next check to retry —
 * never a reason to fail the turn that triggered the check.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { LlmContentBlock, ResolvedLlm } from '@renkei/agent-llm';
import { attributeMessagesToSummary, listMessages, type StoredMessage } from './messages';

/** A chat is compacted once its unfolded history passes this many characters. */
export const CHAT_COMPACT_CHAR_THRESHOLD = 320_000;
/** Messages always sent verbatim, whatever else is folded. */
export const CHAT_COMPACT_KEEP_RECENT = 20;
/** Below this many foldable messages, a pass is not worth the model call. */
export const CHAT_COMPACT_MIN_FOLD = 6;
/** Folded per pass — bounds the summarization call; a backlog drains over several passes. */
const CHAT_COMPACT_MAX_FOLD_MESSAGES = 200;
/** The ceiling on what one pass's prompt carries, whatever the fold set's raw size. */
const CHAT_COMPACT_MAX_TRANSCRIPT_CHARS = 180_000;
/** Per message, inside that transcript — one giant tool result should not crowd out the rest. */
const CHAT_COMPACT_PER_MESSAGE_MAX_CHARS = 4_000;
/** The rolling summary's ceiling, enforced at compaction time. */
export const CHAT_SUMMARY_MAX_CHARS = 12_000;

export type ChatSummaryCreator = 'auto' | 'tool' | 'user';

export interface ChatSummaryRow {
  id: string;
  content: string;
  throughSeq: number;
  foldedCount: number;
  createdBy: ChatSummaryCreator;
  createdAt: Date;
}

function creatorOf(value: string): ChatSummaryCreator {
  return value === 'tool' || value === 'user' ? value : 'auto';
}

/** The newest summary — the only one a prompt ever reads (see file header). */
export async function latestChatSummary(
  db: Kysely<DB>,
  tenantId: string,
  chatId: string
): Promise<ChatSummaryRow | null> {
  const row = await db
    .selectFrom('chat_summaries')
    .select(['id', 'content', 'through_seq', 'folded_count', 'created_by', 'created_at'])
    .where('tenant_id', '=', tenantId)
    .where('chat_id', '=', chatId)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
    content: row.content,
    throughSeq: row.through_seq,
    foldedCount: row.folded_count,
    createdBy: creatorOf(row.created_by),
    createdAt: row.created_at,
  };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[clipped]` : text;
}

function blockChars(block: LlmContentBlock): number {
  switch (block.type) {
    case 'text':
      return block.text.length;
    case 'thinking':
      return block.thinking.length;
    case 'redacted_thinking':
      return block.data.length;
    case 'tool_use':
      return block.name.length + JSON.stringify(block.input ?? {}).length;
    case 'tool_result':
      return block.content.length;
    // Bytes ride as base64 but are not text the model reads as context in
    // the same sense; excluded so a legitimate image or PDF attachment
    // never trips the threshold on its own.
    case 'document':
    case 'image':
      return 0;
  }
}

function messageChars(message: StoredMessage): number {
  return message.blocks.reduce((sum, block) => sum + blockChars(block), 0);
}

/** Unfolded, ordered — what a prompt would still send in full right now. */
function unfoldedOf(messages: StoredMessage[]): StoredMessage[] {
  return messages
    .filter((message) => message.summaryId === null && message.status !== 'failed')
    .sort((a, b) => a.seq - b.seq);
}

/** The oldest messages outside the keep-recent window — this pass's fold set. */
function foldCandidates(unfolded: StoredMessage[]): StoredMessage[] {
  const foldable = unfolded.length - CHAT_COMPACT_KEEP_RECENT;
  if (foldable < CHAT_COMPACT_MIN_FOLD) return [];
  return unfolded.slice(0, Math.min(foldable, CHAT_COMPACT_MAX_FOLD_MESSAGES));
}

/** Whether a turn about to build its history should compact first. */
export function needsCompaction(messages: StoredMessage[]): boolean {
  const unfolded = unfoldedOf(messages);
  if (foldCandidates(unfolded).length < CHAT_COMPACT_MIN_FOLD) return false;
  const chars = unfolded.reduce((sum, message) => sum + messageChars(message), 0);
  return chars > CHAT_COMPACT_CHAR_THRESHOLD;
}

function renderMessage(message: StoredMessage): string {
  const who =
    message.role === 'assistant'
      ? 'Assistant'
      : message.kind === 'tool_results'
        ? 'Tool results'
        : 'Person';
  const parts = message.blocks.flatMap((block): string[] => {
    switch (block.type) {
      case 'text':
        return block.text.trim() ? [block.text] : [];
      case 'tool_use':
        return [`called ${block.name}(${clip(JSON.stringify(block.input ?? {}), 1_000)})`];
      case 'tool_result':
        return [
          `${block.isError ? 'error result' : 'result'}: ${clip(block.content, CHAT_COMPACT_PER_MESSAGE_MAX_CHARS)}`,
        ];
      case 'document':
        return [`[attached document: ${block.title ?? block.mediaType}]`];
      case 'image':
        return ['[attached image]'];
      case 'thinking':
      case 'redacted_thinking':
        return [];
    }
  });
  if (parts.length === 0) return '';
  return `${who}: ${clip(parts.join('\n'), CHAT_COMPACT_PER_MESSAGE_MAX_CHARS)}`;
}

function renderTranscript(messages: StoredMessage[]): string {
  const text = messages
    .map(renderMessage)
    .filter((line) => line.length > 0)
    .join('\n\n');
  return clip(text, CHAT_COMPACT_MAX_TRANSCRIPT_CHARS);
}

const COMPACTION_SYSTEM_PROMPT =
  'You are compacting the earlier part of a long chat so it can continue without resending it in full. Merge the ' +
  'earlier summary (if any) and the conversation that follows into ONE updated summary a continuation of this chat ' +
  'can rely on in place of the original messages. Preserve, exactly: file paths created, edited or read; commands ' +
  'run and their outcomes, including errors and how they were fixed; decisions made and why; the current state of ' +
  'any task or plan, including what is still open; identifiers a later turn would need (ids, URLs, branch names, ' +
  'ticket keys, variable or function names). Collapse exploratory back-and-forth and anything with no future value. ' +
  'Write plain compact prose or short bullet lines, oldest first. ' +
  `Stay under ${CHAT_SUMMARY_MAX_CHARS} characters. Reply with the summary text only.`;

export interface CompactChatInput {
  tenantId: string;
  chatId: string;
  llm: ResolvedLlm;
  createdBy: ChatSummaryCreator;
  /** Already-fetched rows, when the caller has them (start-turn.ts does). */
  messages?: StoredMessage[];
}

export interface CompactChatResult {
  summaryId: string;
  foldedCount: number;
  throughSeq: number;
}

/**
 * Runs one compaction pass, or returns null when there is nothing worth
 * folding (fewer than CHAT_COMPACT_MIN_FOLD messages outside the keep-recent
 * window) — distinct from a failure, which throws.
 */
export async function compactChat(
  db: Kysely<DB>,
  input: CompactChatInput
): Promise<CompactChatResult | null> {
  const messages = input.messages ?? (await listMessages(db, input.tenantId, input.chatId));
  const candidates = foldCandidates(unfoldedOf(messages));
  if (candidates.length < CHAT_COMPACT_MIN_FOLD) return null;

  const previous = await latestChatSummary(db, input.tenantId, input.chatId);
  const prompt =
    (previous ? `Earlier summary:\n${previous.content}\n\n` : 'Earlier summary: (none yet)\n\n') +
    `Conversation to fold in, oldest first:\n${renderTranscript(candidates)}`;

  const llm = input.llm;
  const completion = await llm.provider.complete({
    system: COMPACTION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    tools: [],
    maxTokens: llm.maxOutputTokens,
    ...(llm.temperature !== undefined ? { temperature: llm.temperature } : {}),
  });
  if (!completion.ok) {
    throw new Error(completion.err.message ?? `model failed (${completion.err.type})`);
  }
  const summary = completion.val.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim();
  if (!summary) throw new Error('the model returned an empty summary');

  const throughSeq = candidates[candidates.length - 1].seq;
  const inserted = await db
    .insertInto('chat_summaries')
    .values({
      tenant_id: input.tenantId,
      chat_id: input.chatId,
      content: clip(summary, CHAT_SUMMARY_MAX_CHARS),
      through_seq: throughSeq,
      folded_count: candidates.length,
      created_by: input.createdBy,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();
  // Summary first, then the attribution: a crash between the two leaves the
  // folded messages present AND summarized — sent again once, harmlessly —
  // never dropped from the conversation.
  await attributeMessagesToSummary(
    db,
    input.tenantId,
    candidates.map((message) => message.id),
    inserted.id
  );

  return { summaryId: inserted.id, foldedCount: candidates.length, throughSeq };
}
