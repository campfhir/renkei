/**
 * chat_recall_chats — the model's way to reach chats beyond this one:
 * search their titles and content for a query, or list the most recent
 * ones, then read one back in full by id. Which chats those are is the
 * turn's own affair, never the model's:
 *
 * - Outside a project, the person's *other* chats — everything they own
 *   but this conversation.
 * - In a project, the project's other chats — every member's, the way the
 *   project's page lists them (a member may read any chat in a project
 *   they belong to, access.ts) — and nothing outside it: not the person's
 *   own chats elsewhere, not another project's. In a code project that is
 *   how the active chat reaches what its history chats found and decided
 *   (lib/code/active-chat.ts).
 *
 * The project comes from the tool's context (LocalToolContext.projectId),
 * not from an input, so the model has no way to name another project; a
 * chat id from outside the project — or outside the person's own chats,
 * outside one — reads as "no such chat", the same word as for an id that
 * does not exist. So a project's isolation from the rest of a person's
 * history holds for recall exactly as it does for memory.
 *
 * Titles are plaintext and free to scan; message content is sealed, so a
 * content search decrypts a bounded, most-recently-active slice of the
 * reachable chats rather than the whole history — the same small-catalog
 * tradeoff find_tools makes for tool discovery.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import {
  getChatForOwner,
  getChatRow,
  listOwnedChats,
  listProjectChats,
  type ChatRow,
} from './store';
import { listMessages } from './messages';
import { errorResult, textResult, type LocalTool, type LocalToolContext } from './local-tools';

const LIST_LIMIT_DEFAULT = 8;
const LIST_LIMIT_MAX = 20;
/** How many of the person's other chats a content search will decrypt and scan. */
const SCAN_LIMIT = 25;
const SNIPPET_CHARS = 160;
const TITLE_MATCH_WEIGHT = 3;
/** Cap on what reading one chat in full returns. */
const READ_MAX_CHARS = 6_000;

function titleOf(chat: ChatRow): string {
  return chat.title ?? '(untitled chat)';
}

function scoreOf(haystack: string, terms: string[]): number {
  let score = 0;
  for (const term of terms) {
    if (term.length > 0 && haystack.includes(term)) score += 1;
  }
  return score;
}

async function transcriptOf(
  db: Kysely<DB>,
  tenantId: string,
  chat: ChatRow,
  maxChars: number
): Promise<string> {
  const rows = await listMessages(db, tenantId, chat.id);
  const lines: string[] = [];
  let spent = 0;
  for (const row of rows) {
    const text = row.blocks
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join(' ')
      .trim();
    if (!text) continue;
    const line = `${row.role === 'assistant' ? 'Assistant' : 'Person'}: ${text}`;
    if (spent + line.length + 1 > maxChars) break;
    lines.push(line);
    spent += line.length + 1;
  }
  return lines.join('\n');
}

function snippetAround(transcript: string, terms: string[]): string {
  const lower = transcript.toLowerCase();
  const at = terms.map((term) => lower.indexOf(term)).find((index) => index >= 0);
  if (at === undefined) return transcript.slice(0, SNIPPET_CHARS);
  const start = Math.max(0, at - SNIPPET_CHARS / 2);
  const end = Math.min(transcript.length, start + SNIPPET_CHARS);
  return `${start > 0 ? '…' : ''}${transcript.slice(start, end).trim()}${end < transcript.length ? '…' : ''}`;
}

function dateOf(chat: ChatRow): string {
  return (chat.lastMessageAt ?? chat.updatedAt).toISOString().slice(0, 10);
}

/** "other chats" / "other chats in this project", for the tool's answers. */
function scopeWord(context: LocalToolContext): string {
  return context.projectId ? 'other chats in this project' : 'other chats';
}

/**
 * The chats the tool may see, most recently active first: the project's
 * (every member's, started ones only — an empty chat has nothing to
 * recall) or the person's own, this conversation left out either way.
 */
async function listOthers(context: LocalToolContext): Promise<ChatRow[]> {
  if (context.projectId) {
    const inProject = await listProjectChats(
      context.db,
      context.tenantId,
      [context.projectId],
      null
    );
    return inProject.filter((chat) => chat.id !== context.chatId && chat.lastMessageAt !== null);
  }
  const owned = await listOwnedChats(context.db, context.tenantId, context.subject);
  return owned.filter((chat) => chat.id !== context.chatId);
}

/**
 * One chat by id, within the tool's scope — the project's or the
 * person's own — or null. The scope is checked here, behind the tool,
 * whatever id the model hands in.
 */
async function readable(context: LocalToolContext, chatId: string): Promise<ChatRow | null> {
  if (context.projectId) {
    const chat = await getChatRow(context.db, context.tenantId, chatId);
    return chat && chat.projectId === context.projectId ? chat : null;
  }
  return getChatForOwner(context.db, context.tenantId, context.subject, chatId);
}

async function readOne(context: LocalToolContext, chatId: string) {
  const chat = await readable(context, chatId);
  if (!chat) return errorResult('No such chat.');
  const transcript = await transcriptOf(context.db, context.tenantId, chat, READ_MAX_CHARS);
  if (!transcript) return textResult(`${titleOf(chat)} (${dateOf(chat)}) has no text to show.`);
  return textResult(
    `${titleOf(chat)} (last active ${dateOf(chat)}), chat id ${chat.id}:\n\n${transcript}`
  );
}

async function search(context: LocalToolContext, query: string, limit: number) {
  const others = await listOthers(context);
  if (others.length === 0) return textResult(`There are no ${scopeWord(context)} yet.`);

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const candidates = others.slice(0, SCAN_LIMIT);
  const scored = await Promise.all(
    candidates.map(async (chat) => {
      const transcript = await transcriptOf(context.db, context.tenantId, chat, 4_000);
      const titleScore = scoreOf(titleOf(chat).toLowerCase(), terms) * TITLE_MATCH_WEIGHT;
      const bodyScore = scoreOf(transcript.toLowerCase(), terms);
      return { chat, transcript, score: titleScore + bodyScore };
    })
  );
  const matches = scored
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || b.chat.updatedAt.getTime() - a.chat.updatedAt.getTime())
    .slice(0, limit);
  if (matches.length === 0) {
    return errorResult(
      `No ${context.projectId ? 'other chat in this project' : 'other chat'} matched "${query}" among the ${candidates.length} most recently active.`
    );
  }
  return textResult(
    `Found ${matches.length} matching chat(s) — call chat_recall_chats again with chatId to read one in full:\n` +
      matches
        .map(
          (row) =>
            `- ${row.chat.id} [${dateOf(row.chat)}] ${titleOf(row.chat)}\n  "${snippetAround(row.transcript, terms)}"`
        )
        .join('\n')
  );
}

async function listRecent(context: LocalToolContext, limit: number) {
  const others = await listOthers(context);
  if (others.length === 0) return textResult(`There are no ${scopeWord(context)} yet.`);
  const recent = others.slice(0, limit);
  return textResult(
    `The ${recent.length} most recently active ${scopeWord(context)} — call chat_recall_chats again with chatId to read one in full:\n` +
      recent.map((chat) => `- ${chat.id} [${dateOf(chat)}] ${titleOf(chat)}`).join('\n')
  );
}

export function recallTools(): LocalTool[] {
  return [
    {
      readOnly: true,
      def: {
        name: 'chat_recall_chats',
        description:
          "Search or list the other chats this conversation may see — in a project, the project's own other chats (every member's) and nothing outside it; otherwise this person's other chats — by title and content, then read one back in full. Use it when something from an earlier, different chat is referred to that this conversation does not already contain: in a code project, what a previous chat found, tried or decided. Give `query` to search; omit it to list the most recently active; give `chatId` (from an earlier result) to read that chat's messages in full.",
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                'Keywords to search for in chat titles and messages. Omit to list recent chats instead.',
            },
            chatId: {
              type: 'string',
              description:
                "A chat id from an earlier result, to read that chat's messages in full.",
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: LIST_LIMIT_MAX,
              description: `Max chats to return when searching or listing (default ${LIST_LIMIT_DEFAULT}).`,
            },
          },
        },
      },
      async execute(input, context) {
        const chatId = typeof input.chatId === 'string' ? input.chatId.trim() : '';
        if (chatId) return readOne(context, chatId);

        const limit =
          typeof input.limit === 'number' && input.limit > 0
            ? Math.min(LIST_LIMIT_MAX, Math.floor(input.limit))
            : LIST_LIMIT_DEFAULT;
        const query = typeof input.query === 'string' ? input.query.trim() : '';
        return query ? search(context, query, limit) : listRecent(context, limit);
      },
    },
  ];
}
