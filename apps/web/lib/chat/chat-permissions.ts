/**
 * What the owner decided about a tool for ONE chat, from its permission
 * card: "Allow in this chat" (the tool runs unasked for the rest of this
 * chat) and "Block in this chat" (never offered here again, refused if
 * called from memory). Stored on the chat (`chats.tool_permissions`,
 * migration 197), so it goes with the chat and never reaches the person's
 * other chats — their own lists under Preferences › Tool permissions
 * decide those. A turn reads it at its start (start-turn.ts); the decision
 * route writes it the moment the person answers.
 *
 * The organization's locked high-risk tools are never allowed this way:
 * the card does not offer it and the route refuses it.
 *
 * Either answer can be taken back from the chat's Tools dialog ("Decided
 * in this chat"), which puts the tool back to asking.
 */

import { getDataStore } from '@renkei/db';
import { isRecord } from '@renkei/guards';
import { TOOL_NAME } from './permission-rules';

export interface ChatToolAnswers {
  /** Tools that run unasked in this chat; sorted, unique. */
  allow: string[];
  /** Tools this chat never offers; sorted, unique, never also in allow. */
  deny: string[];
}

export const NO_CHAT_TOOL_ANSWERS: ChatToolAnswers = { allow: [], deny: [] };

function names(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw.filter((entry): entry is string => typeof entry === 'string' && TOOL_NAME.test(entry))
    ),
  ].sort();
}

/** Whatever jsonb hands back; a name on both lists is blocked (the stricter answer wins). */
export function parseChatToolAnswers(stored: unknown): ChatToolAnswers {
  if (!isRecord(stored)) return NO_CHAT_TOOL_ANSWERS;
  const deny = names(stored.deny);
  const denied = new Set(deny);
  return { allow: names(stored.allow).filter((name) => !denied.has(name)), deny };
}

/** What can be decided for a tool in one chat; 'ask' takes a decision back. */
export type ChatToolRule = 'allow' | 'deny' | 'ask';

/** The answers with one tool moved onto `rule`'s list (and off the other); 'ask' takes it off both. */
export function withChatToolAnswer(
  answers: ChatToolAnswers,
  name: string,
  rule: ChatToolRule
): ChatToolAnswers {
  const allow = answers.allow.filter((entry) => entry !== name);
  const deny = answers.deny.filter((entry) => entry !== name);
  if (rule === 'allow') allow.push(name);
  if (rule === 'deny') deny.push(name);
  return { allow: allow.sort(), deny: deny.sort() };
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
  const empty = next.allow.length === 0 && next.deny.length === 0;
  await getDataStore().chats.setToolPermissions(chatId, empty ? null : next);
  return next;
}

/** A chat's answers as stored; none when the chat is gone. */
export async function readChatToolAnswers(chatId: string): Promise<ChatToolAnswers> {
  const chat = await getDataStore().chats.get(chatId);
  return chat ? parseChatToolAnswers(chat.toolPermissions) : NO_CHAT_TOOL_ANSWERS;
}
