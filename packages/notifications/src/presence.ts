/**
 * "Is somebody actually watching this chat's turn stream, right now" —
 * server-side, for the notifications that would otherwise fire regardless
 * of whether the reply that prompted them was already watched live (see
 * apps/web/lib/chat/reply-notification.ts). See migration 117 for the
 * table and the reasoning behind its shape.
 *
 * Written by the turn stream route itself (chats/[chatId]/turns/[turnId]/
 * stream/route.ts) — on connection open, on its existing keep-alive
 * heartbeat, and again the instant it sends `turn_end` — never by a
 * generic client-side ping. That stream connection already only exists
 * while a browser is watching this exact chat's turn, which is a more
 * precise "were they watching" signal than a page-location poll and needs
 * no new client code at all.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';

/**
 * Record that `subject` is watching `chatId`'s turn stream right now.
 * Idempotent and cheap to call often: a repeat heartbeat from the same
 * connection just moves `updated_at` forward, never piles up rows.
 */
export async function pingChatPresence(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  chatId: string
): Promise<void> {
  const updatedAt = new Date();
  await db
    .insertInto('chat_presence')
    .values({ tenant_id: tenantId, subject, chat_id: chatId, updated_at: updatedAt })
    .onConflict((oc) =>
      oc.columns(['tenant_id', 'subject', 'chat_id']).doUpdateSet({ updated_at: updatedAt })
    )
    .execute();
}

/**
 * Whether `subject` had a live stream connection to `chatId` within the
 * last `windowSeconds`. `windowSeconds <= 0` short-circuits without a
 * query: the org setting's "0 = off" convention (see @renkei/settings'
 * `chatReplyPresenceWindowSeconds`), and a window of zero can never be
 * satisfied by a real heartbeat anyway.
 */
export async function wasRecentlyWatchingChat(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  chatId: string,
  windowSeconds: number
): Promise<boolean> {
  if (windowSeconds <= 0) return false;
  const cutoff = new Date(Date.now() - windowSeconds * 1000);
  const row = await db
    .selectFrom('chat_presence')
    .select('chat_id')
    .where('tenant_id', '=', tenantId)
    .where('subject', '=', subject)
    .where('chat_id', '=', chatId)
    .where('updated_at', '>', cutoff)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Delete presence rows older than `olderThanMs` — hygiene, not policy:
 * nothing reads a row once it is too stale to satisfy any org's
 * `chatReplyPresenceWindowSeconds`, however that is tuned, so this is a
 * fixed maintenance cutoff rather than a per-tenant setting (see
 * apps/worker-agents/src/maintenance.ts's `createChatPresenceSweep`).
 */
export async function deleteStaleChatPresence(
  db: Kysely<DB>,
  olderThanMs: number
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const deleted = await db
    .deleteFrom('chat_presence')
    .where('updated_at', '<', cutoff)
    .executeTakeFirst();
  return Number(deleted.numDeletedRows ?? 0);
}
