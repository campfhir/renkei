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

import { getDatabase } from '@renkei/db';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import {
  DEFAULT_CHAT_TOOL_PERMISSION_PREFS,
  TOOL_NAME,
  parseChatToolPermissionPrefs,
  withRule,
  type ChatToolPermissionPrefs,
} from './permission-rules';

export const CHAT_TOOL_PERMISSIONS_PREF_KEY = 'chatToolPermissions';

export {
  DEFAULT_CHAT_TOOL_PERMISSION_PREFS,
  parseChatToolPermissionPrefs,
  ruleFor,
  withRule,
  type ChatToolPermissionPrefs,
  type ToolPermissionRule,
} from './permission-rules';

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { value: ChatToolPermissionPrefs; expiresAt: number }>();
const cacheKey = (tenantId: string, subject: string) => `${tenantId} ${subject}`;

/**
 * Never fails loudly: a database problem reads as "nothing decided", which
 * only means the chat asks — the safe side of this preference.
 */
export async function getChatToolPermissionPrefs(
  tenantId: string,
  subject: string,
  options: { fresh?: boolean } = {}
): Promise<ChatToolPermissionPrefs> {
  const key = cacheKey(tenantId, subject);
  const cached = cache.get(key);
  if (!options.fresh && cached && cached.expiresAt > Date.now()) return cached.value;

  const dbResult = getDatabase();
  if (!dbResult.ok) return DEFAULT_CHAT_TOOL_PERMISSION_PREFS;

  const rowResult = await wrapAsync(
    () =>
      dbResult.val
        .selectFrom('user_preferences')
        .select('value')
        .where('tenant_id', '=', tenantId)
        .where('subject', '=', subject)
        .where('key', '=', CHAT_TOOL_PERMISSIONS_PREF_KEY)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!rowResult.ok) return DEFAULT_CHAT_TOOL_PERMISSION_PREFS;

  const value = parseChatToolPermissionPrefs(rowResult.val?.value);
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Replace this person's lists wholesale. */
export async function setChatToolPermissionPrefs(
  tenantId: string,
  subject: string,
  prefs: ChatToolPermissionPrefs
): Promise<Result<void, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);
  const db = dbResult.val;

  const value = JSON.stringify(parseChatToolPermissionPrefs(prefs));
  const now = new Date().toISOString();
  const written = await wrapAsync(
    () =>
      db
        .insertInto('user_preferences')
        .values({
          tenant_id: tenantId,
          subject,
          key: CHAT_TOOL_PERMISSIONS_PREF_KEY,
          value,
          updated_at: now,
        })
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'subject', 'key']).doUpdateSet({ value, updated_at: now })
        )
        .execute(),
    'DB_ERROR' as const
  );
  if (!written.ok) return written;

  cache.delete(cacheKey(tenantId, subject));
  return ok();
}

/**
 * "Always allow" for one tool: read fresh, add, write back. The decision
 * route calls this the moment the person clicks, so the choice is durable
 * even if the turn that asked dies before it runs the call. A blocked
 * tool never reaches the card, so there is no both-lists case to resolve.
 */
export async function allowChatToolAlways(
  tenantId: string,
  subject: string,
  toolName: string
): Promise<Result<ChatToolPermissionPrefs, 'DB_ERROR' | 'INVALID_NAME'>> {
  if (!TOOL_NAME.test(toolName)) return err('INVALID_NAME' as const);
  const current = await getChatToolPermissionPrefs(tenantId, subject, { fresh: true });
  if (current.alwaysAllow.includes(toolName)) return ok(current);
  const next = withRule(current, toolName, 'allow');
  const written = await setChatToolPermissionPrefs(tenantId, subject, next);
  if (!written.ok) return err('DB_ERROR' as const);
  return ok(next);
}
