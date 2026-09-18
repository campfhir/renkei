/**
 * The tools a person has told the chat it may always call without asking.
 *
 * A tool call that changes something — anything the catalog does not vouch
 * for as read-only — stops the turn and asks, inline, before it runs: allow
 * once, always allow, or deny. "Always" lands here, keyed by tool name, so
 * the next call to that tool in any of the person's chats runs unasked.
 * Stored in `user_preferences` under its own key next to 'chatTools' (see
 * tool-prefs.ts for why it lives in apps/web rather than @renkei/user-prefs:
 * only the chat ever reads it). The preferences page lists the names and
 * lets the person take one back.
 *
 * Same cache and `fresh` discipline as tool-prefs.ts: a turn reads it once
 * at its start (fresh — a person who just clicked Always in one chat expects
 * their next Send anywhere to honour it), and a route that saves must read
 * fresh too.
 */

import { getDatabase } from '@renkei/db';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

export const CHAT_TOOL_PERMISSIONS_PREF_KEY = 'chatToolPermissions';

/** Names are tool names as the model calls them: `jira_create_issue`, `chat_write_file`. */
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,200}$/;

export interface ChatToolPermissionPrefs {
  /** Tool names that run without asking, sorted, unique. */
  alwaysAllow: string[];
}

export const DEFAULT_CHAT_TOOL_PERMISSION_PREFS: ChatToolPermissionPrefs = { alwaysAllow: [] };

/** Survives whatever jsonb hands back; anything unrecognisable is "ask every time". */
export function parseChatToolPermissionPrefs(stored: unknown): ChatToolPermissionPrefs {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    return DEFAULT_CHAT_TOOL_PERMISSION_PREFS;
  }
  const raw: Record<string, unknown> = { ...stored };
  if (!Array.isArray(raw.alwaysAllow)) return DEFAULT_CHAT_TOOL_PERMISSION_PREFS;
  const names = raw.alwaysAllow.filter(
    (entry): entry is string => typeof entry === 'string' && TOOL_NAME.test(entry)
  );
  return { alwaysAllow: [...new Set(names)].sort() };
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { value: ChatToolPermissionPrefs; expiresAt: number }>();
const cacheKey = (tenantId: string, subject: string) => `${tenantId} ${subject}`;

/**
 * Never fails loudly: a database problem reads as "nothing always allowed",
 * which only means the chat asks — the safe side of this preference.
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

/** Replace this person's always-allowed list wholesale. */
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
 * even if the turn that asked dies before it runs the call.
 */
export async function allowChatToolAlways(
  tenantId: string,
  subject: string,
  toolName: string
): Promise<Result<ChatToolPermissionPrefs, 'DB_ERROR' | 'INVALID_NAME'>> {
  if (!TOOL_NAME.test(toolName)) return err('INVALID_NAME' as const);
  const current = await getChatToolPermissionPrefs(tenantId, subject, { fresh: true });
  if (current.alwaysAllow.includes(toolName)) return ok(current);
  const next = parseChatToolPermissionPrefs({
    alwaysAllow: [...current.alwaysAllow, toolName],
  });
  const written = await setChatToolPermissionPrefs(tenantId, subject, next);
  if (!written.ok) return err('DB_ERROR' as const);
  return ok(next);
}
