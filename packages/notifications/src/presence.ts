/**
 * "Is somebody already looking at this page, right now" — server-side, for
 * the notifications that would otherwise fire regardless of whether the
 * reply that prompted them was already watched live (see
 * apps/web/lib/chat/reply-notification.ts). See migration 117 for the
 * table and the reasoning behind its shape.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';

/**
 * Record the browser's own claim that it is showing `path` right now.
 * Idempotent and cheap to call often: a repeat ping from the same page
 * just moves `updated_at` forward, never piles up rows.
 */
export async function pingPresence(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  path: string
): Promise<void> {
  const updatedAt = new Date();
  await db
    .insertInto('presence_pings')
    .values({ tenant_id: tenantId, subject, path, updated_at: updatedAt })
    .onConflict((oc) =>
      oc.columns(['tenant_id', 'subject', 'path']).doUpdateSet({ updated_at: updatedAt })
    )
    .execute();
}

/**
 * Whether `subject` pinged `path` within the last `windowSeconds` — the
 * gate a caller gets to decide is even worth checking. `windowSeconds <= 0`
 * short-circuits without a query: the org setting's "0 = off" convention
 * (see @renkei/settings' `chatReplyPresenceWindowSeconds`), and a window of
 * zero can never be satisfied by a real ping anyway.
 */
export async function wasRecentlyPresent(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  path: string,
  windowSeconds: number
): Promise<boolean> {
  if (windowSeconds <= 0) return false;
  const cutoff = new Date(Date.now() - windowSeconds * 1000);
  const row = await db
    .selectFrom('presence_pings')
    .select('path')
    .where('tenant_id', '=', tenantId)
    .where('subject', '=', subject)
    .where('path', '=', path)
    .where('updated_at', '>', cutoff)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Delete pings older than `olderThanMs` — hygiene, not policy: nothing
 * reads a ping once it is too stale to satisfy any org's
 * `chatReplyPresenceWindowSeconds`, however that is tuned, so this is a
 * fixed maintenance cutoff rather than a per-tenant setting (see
 * apps/worker-agents/src/maintenance.ts's `createPresencePingSweep`).
 */
export async function deleteStalePresencePings(db: Kysely<DB>, olderThanMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const deleted = await db
    .deleteFrom('presence_pings')
    .where('updated_at', '<', cutoff)
    .executeTakeFirst();
  return Number(deleted.numDeletedRows ?? 0);
}
