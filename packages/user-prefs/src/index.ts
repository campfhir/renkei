/**
 * @renkei/user-prefs — per-person settings, the scope this app was missing.
 *
 * Deliberately the shape of `@renkei/settings` one scope down: a key/value
 * table with JSON values, projected into a typed interface with explicit
 * defaults and a short cache. Adding a preference is a field and a default,
 * never DDL, and nobody has to learn a second way to do it.
 *
 * A package rather than a module in `apps/web` because BOTH sides need it:
 * the preferences page writes it, and the agents worker reads it to decide
 * whether a notification is worth writing at all. The worker cannot import
 * from `apps/web`.
 *
 * The shape and the rules live in `prefs.ts`, which touches no database.
 */

import { getDatabase } from '@renkei/db';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import {
  CONNECTORS_KEY,
  DEFAULT_CONNECTOR_PREFS,
  DEFAULT_NOTIFICATION_PREFS,
  DEFAULT_THEME_PREFS,
  NOTIFICATIONS_KEY,
  THEME_KEY,
  DEFAULT_VOICE_PREFS,
  VOICE_KEY,
  COACH_MARKS_KEY,
  DEFAULT_COACH_MARK_PREFS,
  DEFAULT_IMAGE_PREFS,
  IMAGE_KEY,
  parseImagePrefs,
  type ImagePrefs,
  CHAT_ARCHIVE_KEY,
  DEFAULT_CHAT_ARCHIVE_PREFS,
  parseChatArchivePrefs,
  type ChatArchivePrefs,
  parseCoachMarkPrefs,
  type CoachMarkPrefs,
  parseConnectorPrefs,
  parseNotificationPrefs,
  parseThemePrefs,
  parseVoicePrefs,
  type ConnectorPrefs,
  type NotificationPrefs,
  type ThemePrefs,
  type VoicePrefs,
} from './prefs';

export * from './prefs';

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  value: NotificationPrefs;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

const cacheKey = (subject: string) => `${subject}`;

/**
 * One person's notification preferences, defaults filled in.
 *
 * Cached briefly, for the caller that reads this on a hot path: the worker,
 * once per run. `fresh` skips the cache, and any surface a person can SAVE
 * from must pass it. The setter does invalidate, but Next renders server
 * components and route handlers from separate module graphs, so a page can
 * hold a cache the route that just wrote never touched — and "save, reload,
 * your change is gone for a minute" is how a settings page teaches people
 * to distrust it.
 *
 * Never fails loudly: a database problem yields the defaults, because the
 * alternative — refusing to write a notification because a preference row
 * could not be read — loses the notification for good.
 */
export async function getNotificationPrefs(
  subject: string,
  options: { fresh?: boolean } = {}
): Promise<NotificationPrefs> {
  const key = cacheKey(subject);
  const cached = cache.get(key);
  if (!options.fresh && cached && cached.expiresAt > Date.now()) return cached.value;

  const dbResult = getDatabase();
  if (!dbResult.ok) return DEFAULT_NOTIFICATION_PREFS;

  const rowResult = await wrapAsync(
    () =>
      dbResult.val
        .selectFrom('user_preferences')
        .select('value')
        .where('subject', '=', subject)
        .where('key', '=', NOTIFICATIONS_KEY)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!rowResult.ok) return DEFAULT_NOTIFICATION_PREFS;

  const value = parseNotificationPrefs(rowResult.val?.value);
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Replace this person's notification preferences wholesale. */
export async function setNotificationPrefs(
  subject: string,
  prefs: NotificationPrefs
): Promise<Result<void, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const now = new Date().toISOString();
  const value = JSON.stringify(prefs);
  const written = await wrapAsync(
    () =>
      dbResult.val
        .insertInto('user_preferences')
        .values({ subject, key: NOTIFICATIONS_KEY, value, updated_at: now })
        .onConflict((oc) =>
          oc.columns(['subject', 'key']).doUpdateSet({ value, updated_at: now })
        )
        .execute(),
    'DB_ERROR' as const
  );
  if (!written.ok) return written;

  cache.delete(cacheKey(subject));
  return ok();
}

const connectorCache = new Map<string, { value: ConnectorPrefs; expiresAt: number }>();

/**
 * The connectors a person added to their own connectors page.
 *
 * Same cache and `fresh` discipline as the notification preferences: the
 * connectors page renders from a server component and saves through a route
 * handler, two module graphs, so the page must read fresh or a just-added
 * card would vanish on reload for up to a minute. Never fails loudly — a
 * database problem shows the person nothing added, which the page then
 * fills from what they have actually connected.
 */
export async function getConnectorPrefs(
  subject: string,
  options: { fresh?: boolean } = {}
): Promise<ConnectorPrefs> {
  const key = cacheKey(subject);
  const cached = connectorCache.get(key);
  if (!options.fresh && cached && cached.expiresAt > Date.now()) return cached.value;

  const dbResult = getDatabase();
  if (!dbResult.ok) return DEFAULT_CONNECTOR_PREFS;

  const rowResult = await wrapAsync(
    () =>
      dbResult.val
        .selectFrom('user_preferences')
        .select('value')
        .where('subject', '=', subject)
        .where('key', '=', CONNECTORS_KEY)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!rowResult.ok) return DEFAULT_CONNECTOR_PREFS;

  const value = parseConnectorPrefs(rowResult.val?.value);
  connectorCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Replace this person's connector selections wholesale. */
export async function setConnectorPrefs(
  subject: string,
  prefs: ConnectorPrefs
): Promise<Result<void, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const now = new Date().toISOString();
  const value = JSON.stringify(prefs);
  const written = await wrapAsync(
    () =>
      dbResult.val
        .insertInto('user_preferences')
        .values({ subject, key: CONNECTORS_KEY, value, updated_at: now })
        .onConflict((oc) =>
          oc.columns(['subject', 'key']).doUpdateSet({ value, updated_at: now })
        )
        .execute(),
    'DB_ERROR' as const
  );
  if (!written.ok) return written;

  connectorCache.delete(cacheKey(subject));
  return ok();
}

const themeCache = new Map<string, { value: ThemePrefs; expiresAt: number }>();

/**
 * Which look this person's UI renders in.
 *
 * Same cache and `fresh` discipline as the other two: the preferences page
 * must read fresh (a change some other tab just saved should show up here
 * immediately) while the theme script that runs on every page load is fine
 * with up to a minute's staleness. Never fails loudly — a database problem
 * falls back to 'auto', which is what an unset preference means anyway.
 */
export async function getThemePrefs(
  subject: string,
  options: { fresh?: boolean } = {}
): Promise<ThemePrefs> {
  const key = cacheKey(subject);
  const cached = themeCache.get(key);
  if (!options.fresh && cached && cached.expiresAt > Date.now()) return cached.value;

  const dbResult = getDatabase();
  if (!dbResult.ok) return DEFAULT_THEME_PREFS;

  const rowResult = await wrapAsync(
    () =>
      dbResult.val
        .selectFrom('user_preferences')
        .select('value')
        .where('subject', '=', subject)
        .where('key', '=', THEME_KEY)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!rowResult.ok) return DEFAULT_THEME_PREFS;

  const value = parseThemePrefs(rowResult.val?.value);
  themeCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Replace this person's theme preference wholesale. */
export async function setThemePrefs(
  subject: string,
  prefs: ThemePrefs
): Promise<Result<void, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const now = new Date().toISOString();
  const value = JSON.stringify(prefs);
  const written = await wrapAsync(
    () =>
      dbResult.val
        .insertInto('user_preferences')
        .values({ subject, key: THEME_KEY, value, updated_at: now })
        .onConflict((oc) =>
          oc.columns(['subject', 'key']).doUpdateSet({ value, updated_at: now })
        )
        .execute(),
    'DB_ERROR' as const
  );
  if (!written.ok) return written;

  themeCache.delete(cacheKey(subject));
  return ok();
}

const voiceCache = new Map<string, { value: VoicePrefs; expiresAt: number }>();

/**
 * How the chat sounds to this person: voice, pace, whether replies are
 * read aloud unasked. Same cache and `fresh` discipline as the theme —
 * the preferences page and the chat's own voice menu both save it, and
 * the chat page must see that save on its next load. Never fails loudly:
 * a database problem reads as the defaults, which is silence.
 */
export async function getVoicePrefs(
  subject: string,
  options: { fresh?: boolean } = {}
): Promise<VoicePrefs> {
  const key = cacheKey(subject);
  const cached = voiceCache.get(key);
  if (!options.fresh && cached && cached.expiresAt > Date.now()) return cached.value;

  const dbResult = getDatabase();
  if (!dbResult.ok) return DEFAULT_VOICE_PREFS;

  const rowResult = await wrapAsync(
    () =>
      dbResult.val
        .selectFrom('user_preferences')
        .select('value')
        .where('subject', '=', subject)
        .where('key', '=', VOICE_KEY)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!rowResult.ok) return DEFAULT_VOICE_PREFS;

  const value = parseVoicePrefs(rowResult.val?.value);
  voiceCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Replace this person's voice preferences wholesale. */
export async function setVoicePrefs(
  subject: string,
  prefs: VoicePrefs
): Promise<Result<void, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const now = new Date().toISOString();
  const value = JSON.stringify(prefs);
  const written = await wrapAsync(
    () =>
      dbResult.val
        .insertInto('user_preferences')
        .values({ subject, key: VOICE_KEY, value, updated_at: now })
        .onConflict((oc) =>
          oc.columns(['subject', 'key']).doUpdateSet({ value, updated_at: now })
        )
        .execute(),
    'DB_ERROR' as const
  );
  if (!written.ok) return written;

  voiceCache.delete(cacheKey(subject));
  return ok();
}

const imageCache = new Map<string, { value: ImagePrefs; expiresAt: number }>();

/**
 * Which image model this person's chats draw with. Same cache and `fresh`
 * discipline as the voice preferences: the chat reads it per turn and can
 * live with a minute's staleness, the preferences page that saves it must
 * pass `fresh`. Never fails loudly: a database problem reads as "no
 * preference", which is the org's first image model.
 */
export async function getImagePrefs(
  subject: string,
  options: { fresh?: boolean } = {}
): Promise<ImagePrefs> {
  const key = cacheKey(subject);
  const cached = imageCache.get(key);
  if (!options.fresh && cached && cached.expiresAt > Date.now()) return cached.value;

  const dbResult = getDatabase();
  if (!dbResult.ok) return DEFAULT_IMAGE_PREFS;

  const rowResult = await wrapAsync(
    () =>
      dbResult.val
        .selectFrom('user_preferences')
        .select('value')
        .where('subject', '=', subject)
        .where('key', '=', IMAGE_KEY)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!rowResult.ok) return DEFAULT_IMAGE_PREFS;

  const value = parseImagePrefs(rowResult.val?.value);
  imageCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Replace this person's image preferences wholesale. */
export async function setImagePrefs(
  subject: string,
  prefs: ImagePrefs
): Promise<Result<void, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const now = new Date().toISOString();
  const value = JSON.stringify(prefs);
  const written = await wrapAsync(
    () =>
      dbResult.val
        .insertInto('user_preferences')
        .values({ subject, key: IMAGE_KEY, value, updated_at: now })
        .onConflict((oc) =>
          oc.columns(['subject', 'key']).doUpdateSet({ value, updated_at: now })
        )
        .execute(),
    'DB_ERROR' as const
  );
  if (!written.ok) return written;

  imageCache.delete(cacheKey(subject));
  return ok();
}

const coachMarkCache = new Map<string, { value: CoachMarkPrefs; expiresAt: number }>();

/**
 * Whether tours may start unasked for this person. Same cache and `fresh`
 * discipline as the theme: the tenant layout reads it on every page and
 * can live with a minute's staleness, while the Tutorials page — where it
 * is switched — must read fresh. Never fails loudly: a database problem
 * reads as the default, which is on.
 */
export async function getCoachMarkPrefs(
  subject: string,
  options: { fresh?: boolean } = {}
): Promise<CoachMarkPrefs> {
  const key = cacheKey(subject);
  const cached = coachMarkCache.get(key);
  if (!options.fresh && cached && cached.expiresAt > Date.now()) return cached.value;

  const dbResult = getDatabase();
  if (!dbResult.ok) return DEFAULT_COACH_MARK_PREFS;

  const rowResult = await wrapAsync(
    () =>
      dbResult.val
        .selectFrom('user_preferences')
        .select('value')
        .where('subject', '=', subject)
        .where('key', '=', COACH_MARKS_KEY)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!rowResult.ok) return DEFAULT_COACH_MARK_PREFS;

  const value = parseCoachMarkPrefs(rowResult.val?.value);
  coachMarkCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Replace this person's coach-mark preference wholesale. */
export async function setCoachMarkPrefs(
  subject: string,
  prefs: CoachMarkPrefs
): Promise<Result<void, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const now = new Date().toISOString();
  const value = JSON.stringify(prefs);
  const written = await wrapAsync(
    () =>
      dbResult.val
        .insertInto('user_preferences')
        .values({ subject, key: COACH_MARKS_KEY, value, updated_at: now })
        .onConflict((oc) =>
          oc.columns(['subject', 'key']).doUpdateSet({ value, updated_at: now })
        )
        .execute(),
    'DB_ERROR' as const
  );
  if (!written.ok) return written;

  coachMarkCache.delete(cacheKey(subject));
  return ok();
}

const chatArchiveCache = new Map<string, { value: ChatArchivePrefs; expiresAt: number }>();

/**
 * How long this person's chats may sit untouched before they are archived.
 * Same cache and `fresh` discipline as the image preference: the preferences
 * page that saves it passes `fresh`. Never fails loudly: a database problem
 * reads as "never archive", which is the default.
 */
export async function getChatArchivePrefs(
  subject: string,
  options: { fresh?: boolean } = {}
): Promise<ChatArchivePrefs> {
  const key = cacheKey(subject);
  const cached = chatArchiveCache.get(key);
  if (!options.fresh && cached && cached.expiresAt > Date.now()) return cached.value;

  const dbResult = getDatabase();
  if (!dbResult.ok) return DEFAULT_CHAT_ARCHIVE_PREFS;

  const rowResult = await wrapAsync(
    () =>
      dbResult.val
        .selectFrom('user_preferences')
        .select('value')
        .where('subject', '=', subject)
        .where('key', '=', CHAT_ARCHIVE_KEY)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!rowResult.ok) return DEFAULT_CHAT_ARCHIVE_PREFS;

  const value = parseChatArchivePrefs(rowResult.val?.value);
  chatArchiveCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Replace this person's chat archive preference wholesale. */
export async function setChatArchivePrefs(
  subject: string,
  prefs: ChatArchivePrefs
): Promise<Result<void, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const now = new Date().toISOString();
  const value = JSON.stringify(prefs);
  const written = await wrapAsync(
    () =>
      dbResult.val
        .insertInto('user_preferences')
        .values({ subject, key: CHAT_ARCHIVE_KEY, value, updated_at: now })
        .onConflict((oc) =>
          oc.columns(['subject', 'key']).doUpdateSet({ value, updated_at: now })
        )
        .execute(),
    'DB_ERROR' as const
  );
  if (!written.ok) return written;

  chatArchiveCache.delete(cacheKey(subject));
  return ok();
}
