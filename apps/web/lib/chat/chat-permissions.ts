/**
 * What the owner decided about a tool for ONE chat: Allow (an act tool
 * runs without asking, for the rest of this chat), Block (never offered
 * here again, refused if called from memory) and Ask (a tool that only
 * reads, made to ask before it runs here). From the permission card
 * ("Allow in this chat", "Block in this chat") or the chat's Tools dialog,
 * which can also take any of them back. Stored on the chat
 * (`chats.tool_permissions`, migration 197), so it goes with the chat and
 * never reaches the person's other chats. A turn reads it at its start
 * (start-turn.ts, via tool-decision.ts); the routes write it the moment
 * the person answers.
 *
 * The organization's locked high-risk tools ask whatever is allowed here:
 * the card does not offer to allow one and tool-decision.ts asks anyway.
 * A chat project keeps the same kind of lists for its chats
 * (project-permissions.ts), with Allow and Ask only.
 */

import { getDataStore } from '@renkei/db';
import { isRecord } from '@renkei/guards';
import { TOOL_NAME } from './permission-rules';

export interface ChatToolAnswers {
  /** Tools that run unasked in this chat; sorted, unique. */
  allow: string[];
  /** Tools this chat never offers; sorted, unique. */
  deny: string[];
  /** Tools that ask before they run here (reading ones made to ask); sorted, unique. */
  ask: string[];
}

export const NO_CHAT_TOOL_ANSWERS: ChatToolAnswers = { allow: [], deny: [], ask: [] };

function names(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw.filter((entry): entry is string => typeof entry === 'string' && TOOL_NAME.test(entry))
    ),
  ].sort();
}

/**
 * Whatever jsonb hands back. A name on more than one list keeps the
 * stricter answer: blocked over asking over allowed.
 */
export function parseChatToolAnswers(stored: unknown): ChatToolAnswers {
  if (!isRecord(stored)) return NO_CHAT_TOOL_ANSWERS;
  const deny = names(stored.deny);
  const ask = names(stored.ask).filter((name) => !deny.includes(name));
  const allow = names(stored.allow).filter((name) => !deny.includes(name) && !ask.includes(name));
  return { allow, deny, ask };
}

/** What can be decided for a tool in one chat; 'clear' takes a decision back. */
export type ChatToolRule = 'allow' | 'deny' | 'ask' | 'clear';

export function isChatToolRule(value: unknown): value is ChatToolRule {
  return value === 'allow' || value === 'deny' || value === 'ask' || value === 'clear';
}

/** The answers with one tool moved onto `rule`'s list (and off the others); 'clear' takes it off all. */
export function withChatToolAnswer(
  answers: ChatToolAnswers,
  name: string,
  rule: ChatToolRule
): ChatToolAnswers {
  const off = (list: string[]) => list.filter((entry) => entry !== name);
  const next = { allow: off(answers.allow), deny: off(answers.deny), ask: off(answers.ask) };
  if (rule !== 'clear') next[rule].push(name);
  return { allow: next.allow.sort(), deny: next.deny.sort(), ask: next.ask.sort() };
}

/**
 * Put one answer on a chat: read fresh, change, write back. False when the
 * name is not a tool name or the chat is gone. Two answers in the same
 * instant can race; the card asks one call at a time, so they do not.
 */
export async function rememberChatToolAnswer(
  chatId: string,
  name: string,
  rule: ChatToolRule
): Promise<ChatToolAnswers | null> {
  if (!TOOL_NAME.test(name)) return null;
  const chat = await getDataStore().chats.get(chatId);
  if (!chat) return null;
  const next = withChatToolAnswer(parseChatToolAnswers(chat.toolPermissions), name, rule);
  const empty = next.allow.length === 0 && next.deny.length === 0 && next.ask.length === 0;
  await getDataStore().chats.setToolPermissions(chatId, empty ? null : next);
  return next;
}

/** A chat's answers as stored; none when the chat is gone. */
export async function readChatToolAnswers(chatId: string): Promise<ChatToolAnswers> {
  const chat = await getDataStore().chats.get(chatId);
  return chat ? parseChatToolAnswers(chat.toolPermissions) : NO_CHAT_TOOL_ANSWERS;
}
