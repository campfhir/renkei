/**
 * What a person has decided, ahead of time, about the tools a chat may
 * call — the act tools, the ones that change something.
 *
 * Three answers per tool: ask (the default: the turn parks and the card
 * asks), always allow (runs unasked), or block (never offered to the
 * model at all, and refused if it calls the name from memory). "Always"
 * lands here from the card's Always allow, and both lists are edited in
 * full on the Preferences page, where every act tool the person can reach
 * is listed by connector — so a tool can be allowed or blocked before it
 * has ever been called. Stored in `user_preferences` under its own key
 * next to 'chatTools' (see tool-prefs.ts for why it lives in apps/web
 * rather than @renkei/user-prefs: only the chat ever reads it).
 *
 * Same cache and `fresh` discipline as tool-prefs.ts: a turn reads it once
 * at its start (fresh — a person who just clicked Always in one chat expects
 * their next Send anywhere to honour it), and a route that saves must read
 * fresh too.
 */

import { getDataStore } from '@renkei/db';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import {
  DEFAULT_CHAT_TOOL_PERMISSION_PREFS,
  TOOL_NAME,
  parseChatToolPermissionDoc,
  parseChatToolPermissionPrefs,
  withRule,
  type ChatSessionKind,
  type ChatToolPermissionDoc,
  type ChatToolPermissionPrefs,
} from './permission-rules';

export const CHAT_TOOL_PERMISSIONS_PREF_KEY = 'chatToolPermissions';

export {
  DEFAULT_CHAT_TOOL_PERMISSION_PREFS,
  parseChatToolPermissionPrefs,
  ruleFor,
  withRule,
  type ChatSessionKind,
  type ChatToolPermissionPrefs,
  type ToolPermissionRule,
} from './permission-rules';

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { value: ChatToolPermissionDoc; expiresAt: number }>();
const cacheKey = (subject: string) => subject;

/** The whole document, every kind's lists. */
async function readDoc(subject: string, fresh: boolean): Promise<ChatToolPermissionDoc | null> {
  const key = cacheKey(subject);
  const cached = cache.get(key);
  if (!fresh && cached && cached.expiresAt > Date.now()) return cached.value;
  const rowResult = await wrapAsync(
    () => getDataStore().userPreferences.get(subject, CHAT_TOOL_PERMISSIONS_PREF_KEY),
    'DB_ERROR' as const
  );
  if (!rowResult.ok) return null;
  const value = parseChatToolPermissionDoc(rowResult.val);
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/**
 * This person's lists for one kind of chat session (an ordinary chat by
 * default). Never fails loudly: a database problem reads as "nothing
 * decided", which only means the chat asks — the safe side of this
 * preference.
 */
export async function getChatToolPermissionPrefs(
  subject: string,
  options: { fresh?: boolean; kind?: ChatSessionKind } = {}
): Promise<ChatToolPermissionPrefs> {
  const doc = await readDoc(subject, options.fresh ?? false);
  return doc ? doc[options.kind ?? 'chat'] : DEFAULT_CHAT_TOOL_PERMISSION_PREFS;
}

/** Replace this person's lists for one kind wholesale; the other kinds keep theirs. */
export async function setChatToolPermissionPrefs(
  subject: string,
  prefs: ChatToolPermissionPrefs,
  kind: ChatSessionKind = 'chat'
): Promise<Result<void, 'DB_ERROR'>> {
  const current = await readDoc(subject, true);
  if (!current) return err('DB_ERROR' as const);
  const next: ChatToolPermissionDoc = { ...current, [kind]: parseChatToolPermissionPrefs(prefs) };
  const written = await wrapAsync(
    () => getDataStore().userPreferences.set(subject, CHAT_TOOL_PERMISSIONS_PREF_KEY, { ...next }),
    'DB_ERROR' as const
  );
  if (!written.ok) return written;

  cache.delete(cacheKey(subject));
  return ok();
}

/**
 * "Always allow" for one tool, for one kind of chat session: read fresh,
 * add, write back. The decision route calls this the moment the person
 * clicks, so the choice is durable even if the turn that asked dies before
 * it runs the call. A blocked tool never reaches the card, so there is no
 * both-lists case to resolve.
 */
export async function allowChatToolAlways(
  subject: string,
  toolName: string,
  kind: ChatSessionKind = 'chat'
): Promise<Result<ChatToolPermissionPrefs, 'DB_ERROR' | 'INVALID_NAME'>> {
  return rememberChatTool(subject, toolName, 'allow', kind);
}

/** "Block always" from the card: the same, onto the blocked list (which wins over allowed). */
export async function blockChatToolAlways(
  subject: string,
  toolName: string,
  kind: ChatSessionKind = 'chat'
): Promise<Result<ChatToolPermissionPrefs, 'DB_ERROR' | 'INVALID_NAME'>> {
  return rememberChatTool(subject, toolName, 'deny', kind);
}

async function rememberChatTool(
  subject: string,
  toolName: string,
  rule: 'allow' | 'deny',
  kind: ChatSessionKind
): Promise<Result<ChatToolPermissionPrefs, 'DB_ERROR' | 'INVALID_NAME'>> {
  if (!TOOL_NAME.test(toolName)) return err('INVALID_NAME' as const);
  const current = await getChatToolPermissionPrefs(subject, { fresh: true, kind });
  if ((rule === 'allow' ? current.alwaysAllow : current.alwaysDeny).includes(toolName)) {
    return ok(current);
  }
  const next = withRule(current, toolName, rule);
  const written = await setChatToolPermissionPrefs(subject, next, kind);
  if (!written.ok) return err('DB_ERROR' as const);
  return ok(next);
}
