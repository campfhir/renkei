/**
 * A person's own default chat toolset — the connectors a brand new chat (or
 * a project-less chat whose project has none either) starts with, before
 * anyone has picked a toolset for that specific chat.
 *
 * Stored in @renkei/user-prefs's key/value table (`user_preferences`) under
 * its own key, the same way every other preference is added — no migration,
 * just a key and a parser. Kept here rather than in that package because
 * only apps/web ever needs it: a chat's toolset is a web/chat concept the
 * agents worker has no reason to read, unlike notification prefs.
 *
 * Same shape and cache discipline as packages/user-prefs/src/index.ts: a
 * short in-memory cache for the hot path (resolved on every turn), `fresh`
 * for a caller that must see its own just-written value, and only a
 * successful read is ever cached.
 */

import { getDatabase } from '@renkei/db';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { parseToolConfig, toolConfigJson, type ChatToolConfig } from './tool-config';

/** The one preference key so far, next to 'notifications' in the same table. */
export const CHAT_TOOLS_PREF_KEY = 'chatTools';

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  value: ChatToolConfig | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

const cacheKey = (tenantId: string, subject: string) => `${tenantId} ${subject}`;

/**
 * This person's saved default toolset, or null when they have never set one
 * (a new chat then falls through to the project's toolset, then the core
 * set — see effectiveToolConfig).
 *
 * Never fails loudly: a database problem yields null, the same as "no
 * preference saved", because refusing to start a turn over an unreadable
 * preference would be a worse failure than starting it with the core set.
 */
export async function getDefaultChatTools(
  tenantId: string,
  subject: string,
  options: { fresh?: boolean } = {}
): Promise<ChatToolConfig | null> {
  const key = cacheKey(tenantId, subject);
  const cached = cache.get(key);
  if (!options.fresh && cached && cached.expiresAt > Date.now()) return cached.value;

  const dbResult = getDatabase();
  if (!dbResult.ok) return null;

  const rowResult = await wrapAsync(
    () =>
      dbResult.val
        .selectFrom('user_preferences')
        .select('value')
        .where('tenant_id', '=', tenantId)
        .where('subject', '=', subject)
        .where('key', '=', CHAT_TOOLS_PREF_KEY)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!rowResult.ok) return null;

  const value = rowResult.val ? parseToolConfig(rowResult.val.value) : null;
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Save, or clear (pass null) this person's default chat toolset. */
export async function setDefaultChatTools(
  tenantId: string,
  subject: string,
  config: ChatToolConfig | null
): Promise<Result<void, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);
  const db = dbResult.val;

  const written = await wrapAsync(async () => {
    if (config === null) {
      await db
        .deleteFrom('user_preferences')
        .where('tenant_id', '=', tenantId)
        .where('subject', '=', subject)
        .where('key', '=', CHAT_TOOLS_PREF_KEY)
        .execute();
      return;
    }
    const value = JSON.stringify(toolConfigJson(config));
    const now = new Date().toISOString();
    await db
      .insertInto('user_preferences')
      .values({ tenant_id: tenantId, subject, key: CHAT_TOOLS_PREF_KEY, value, updated_at: now })
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'subject', 'key']).doUpdateSet({ value, updated_at: now })
      )
      .execute();
  }, 'DB_ERROR' as const);
  if (!written.ok) return written;

  cache.delete(cacheKey(tenantId, subject));
  return ok();
}
