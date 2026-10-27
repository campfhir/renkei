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

import { getDataStore } from '@renkei/db';

/**
 * Record that `subject` is watching `chatId`'s turn stream right now.
 * Idempotent and cheap to call often: a repeat heartbeat from the same
 * connection just moves `updated_at` forward, never piles up rows.
 */
export async function pingChatPresence(subject: string, chatId: string): Promise<void> {
  await getDataStore().notifications.pingChatPresence(subject, chatId, new Date());
}

/**
 * Whether `subject` had a live stream connection to `chatId` within the
 * last `windowSeconds`. `windowSeconds <= 0` short-circuits without a
 * query: the org setting's "0 = off" convention (see @renkei/settings'
 * `chatReplyPresenceWindowSeconds`), and a window of zero can never be
 * satisfied by a real heartbeat anyway.
 */
export async function wasRecentlyWatchingChat(
  subject: string,
  chatId: string,
  windowSeconds: number
): Promise<boolean> {
  if (windowSeconds <= 0) return false;
  const cutoff = new Date(Date.now() - windowSeconds * 1000);
  return getDataStore().notifications.wasWatchingChat(subject, chatId, cutoff);
}

/**
 * Delete presence rows older than `olderThanMs` — hygiene, not policy:
 * nothing reads a row once it is too stale to satisfy any org's
 * `chatReplyPresenceWindowSeconds`, however that is tuned, so this is a
 * fixed maintenance cutoff rather than a per-tenant setting (see
 * apps/worker-agents/src/maintenance.ts's `createChatPresenceSweep`).
 */
export async function deleteStaleChatPresence(olderThanMs: number): Promise<number> {
  return getDataStore().notifications.deleteChatPresenceBefore(new Date(Date.now() - olderThanMs));
}
