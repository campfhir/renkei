/**
 * Token spend for a code project: the project's total and each of its
 * chats' own, read from `chat_turns` (092) — the same per-turn tallies
 * `lib/usage/org-usage.ts` already reads for the chat/project split,
 * since `llm_calls` (085) carries no chat id of its own. One row per
 * chat, summed across every turn including archived chats' and chats
 * past the project page's own list limit, so the total is the project's
 * real spend, not just what the visible chat list adds up to.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';

export interface ChatTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CodeProjectUsage {
  total: ChatTokenUsage;
  byChat: Record<string, ChatTokenUsage>;
}

const EMPTY_USAGE: CodeProjectUsage = { total: { inputTokens: 0, outputTokens: 0 }, byChat: {} };

export async function loadCodeProjectUsage(
  db: Kysely<DB>,
  tenantId: string,
  projectId: string
): Promise<CodeProjectUsage> {
  const rows = await db
    .selectFrom('chat_turns')
    .innerJoin('chats', 'chats.id', 'chat_turns.chat_id')
    .select(({ fn }) => [
      'chat_turns.chat_id as chat_id',
      fn.sum<string>('chat_turns.input_tokens').as('input_tokens'),
      fn.sum<string>('chat_turns.output_tokens').as('output_tokens'),
    ])
    .where('chat_turns.tenant_id', '=', tenantId)
    .where('chats.project_id', '=', projectId)
    .groupBy('chat_turns.chat_id')
    .execute();
  if (rows.length === 0) return EMPTY_USAGE;

  const byChat: Record<string, ChatTokenUsage> = {};
  const total: ChatTokenUsage = { inputTokens: 0, outputTokens: 0 };
  for (const row of rows) {
    const usage = {
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
    };
    byChat[row.chat_id] = usage;
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
  }
  return { total, byChat };
}
