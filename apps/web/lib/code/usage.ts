/**
 * Token spend for a code project: the project's total and each of its
 * chats' own, read from `chat_turns` (092) — the same per-turn tallies
 * `lib/usage/org-usage.ts` already reads for the chat/project split,
 * since `llm_calls` (085) carries no chat id of its own. One row per
 * chat, summed across every turn including archived chats' and chats
 * past the project page's own list limit, so the total is the project's
 * real spend, not just what the visible chat list adds up to.
 */

import { getDataStore } from '@renkei/db';

export interface ChatTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CodeProjectUsage {
  total: ChatTokenUsage;
  byChat: Record<string, ChatTokenUsage>;
}

const EMPTY_USAGE: CodeProjectUsage = { total: { inputTokens: 0, outputTokens: 0 }, byChat: {} };

export async function loadCodeProjectUsage(projectId: string): Promise<CodeProjectUsage> {
  const rows = await getDataStore().codeProjects.usageByChat(projectId);
  if (rows.length === 0) return EMPTY_USAGE;

  const byChat: Record<string, ChatTokenUsage> = {};
  const total: ChatTokenUsage = { inputTokens: 0, outputTokens: 0 };
  for (const row of rows) {
    const usage = { inputTokens: row.inputTokens, outputTokens: row.outputTokens };
    byChat[row.chatId] = usage;
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
  }
  return { total, byChat };
}
