/**
 * Chat hygiene, five sweeps in one module.
 *
 * The janitor: a turn's runner heartbeats its row every few hundred
 * milliseconds while it works, so a `running` turn whose heartbeat is
 * minutes old belongs to a process that died. It is marked interrupted
 * — with its still-streaming reply — so the chat accepts a new turn (the
 * partial unique index only counts `running`) and the person sees what
 * happened instead of a spinner that never stops.
 *
 * Abandoned starts: "+ New" creates its chat before anything is said in
 * it, so one still empty a day later was opened and walked away from. It
 * goes only if there is nothing in it at all — no message, no attachment
 * — which is why this never touches a blob; an empty chat someone
 * uploaded into waits for the org's retention like any other.
 *
 * Temporary chats: one started as temporary (apps/web/lib/chat/temporary.ts)
 * is deleted — not archived — once it has sat untouched for a day, with
 * its attachments' bytes first, the way retention deletes. It runs ahead
 * of auto-archive, so a temporary chat is never archived instead. Skipped
 * while the chat has a reply running.
 *
 * Auto-archive: a person's chat_archive preference archives their chats
 * once they have sat untouched for that long. It runs ahead of retention
 * in the same sweep, and its window is capped at the org's retention, so
 * a chat is archived before it can be pruned, never after. Skipped while
 * the chat has a reply running.
 *
 * Retention: the org's chatRetentionDays (0 = keep). Bytes go before rows
 * — an attachment whose object could not be deleted keeps its row so a
 * later sweep can try again, and nothing in the store is ever orphaned
 * by a row that vanished first.
 *
 * Orphaned grants: resource_access_grants has no foreign key to the
 * polymorphic resource it names; the app deletes grants with their
 * resource, and this catches whatever a crash between the two left. The
 * same goes for a chat's encryption key (resource_keys, migration 133):
 * deleted with the chat, pruned here when that did not land.
 */

import { getDataStore } from '@renkei/db';
import { resolveTenantBlobStore, type BlobStore } from '@renkei/blob-store';
import { getOrgSettings } from '@renkei/settings';
import { delegateClient } from '@renkei/delegate-client';
import { CHAT_ARCHIVE_KEY, effectiveArchiveDays, parseChatArchivePrefs } from '@renkei/user-prefs';
import { logger } from './logger';

export const CHAT_JANITOR_INTERVAL_MS = 5 * 60_000;
export const CHAT_RETENTION_INTERVAL_MS = 15 * 60_000;

/** Well past the runner's heartbeat cadence; a healthy turn never trips this. */
const STALE_MINUTES = 15;
const RETENTION_BATCH = 500;
/** Long enough for anyone to come back to a chat they opened and left. */
const ABANDONED_CHAT_HOURS = 24;
/** apps/web/lib/chat/temporary.ts TEMPORARY_CHAT_IDLE_HOURS, which the chat says. */
const TEMPORARY_CHAT_HOURS = 24;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function createChatTurnJanitor() {
  return async function sweep(): Promise<void> {
    // staleSince/stage are the turn as it was before the store wrote over
    // it, so the log says how long it had actually been stuck, doing what.
    const stale = await getDataStore().chatThreads.interruptStaleTurns(
      new Date(Date.now() - STALE_MINUTES * MINUTE_MS),
      'The reply stopped unexpectedly and did not finish.'
    );
    for (const row of stale) {
      logger.warn('interrupted a chat turn whose runner went silent', {
        component: 'worker-agents/chat-janitor',
        turnId: row.id,
        chatId: row.chatId,
        stage: row.stage ?? '(between rounds)',
        staleSinceMinutes: Math.round((Date.now() - row.staleSince.getTime()) / MINUTE_MS),
      });
    }
  };
}

export function createChatRetentionSweep(store: () => Promise<BlobStore | null> = blobStore) {
  return async function sweep(): Promise<void> {
    await deleteAbandonedChats();
    // Before archiving: a temporary chat goes, it is never archived.
    await deleteTemporaryChats(store);
    const settings = await getOrgSettings();
    // Archiving runs ahead of pruning: a chat a person has set to archive
    // is archived before retention can delete it.
    await archiveIdleChats(settings.ok ? settings.val.chatRetentionDays : 0);
    if (settings.ok && settings.val.chatRetentionDays > 0) {
      const days = settings.val.chatRetentionDays;
      const chatIds = await getDataStore().chats.listIdsUpdatedBefore(
        new Date(Date.now() - days * DAY_MS),
        RETENTION_BATCH
      );
      const deletable =
        chatIds.length > 0 ? await deleteAttachmentBlobs(chatIds, await store()) : [];
      if (deletable.length > 0) {
        await getDataStore().chats.deleteMany(deletable);
        await getDataStore().resourceGrants.deleteForResources('chat', deletable);
        logger.info('chat retention removed {count} chat(s)', {
          component: 'worker-agents/chat-retention',
          count: deletable.length,
        });
      }
    }
    await pruneOrphanGrants();
  };
}

/** Empty chats past the grace period; their grants go with the orphan prune. */
async function deleteAbandonedChats(): Promise<void> {
  const deleted = await getDataStore().chats.deleteAbandoned(
    new Date(Date.now() - ABANDONED_CHAT_HOURS * HOUR_MS)
  );
  if (deleted.length === 0) return;
  logger.info('removed {count} abandoned empty chat(s)', {
    component: 'worker-agents/chat-retention',
    count: deleted.length,
  });
}

/** Temporary chats idle past their day, bytes before rows; their keys go with the orphan prune. */
async function deleteTemporaryChats(store: () => Promise<BlobStore | null>): Promise<void> {
  const chatIds = await getDataStore().chats.listTemporaryIdleIds(
    new Date(Date.now() - TEMPORARY_CHAT_HOURS * HOUR_MS),
    RETENTION_BATCH
  );
  if (chatIds.length === 0) return;
  const deletable = await deleteAttachmentBlobs(chatIds, await store());
  if (deletable.length === 0) return;
  await getDataStore().chats.deleteMany(deletable);
  await getDataStore().resourceGrants.deleteForResources('chat', deletable);
  logger.info('removed {count} idle temporary chat(s)', {
    component: 'worker-agents/chat-retention',
    count: deletable.length,
  });
}

/**
 * Archive each person's chats that have sat untouched past their own window
 * (capped at the org's retention). Same activity clock as retention —
 * `updated_at` — so the two never disagree about what "idle" means. A chat
 * with a reply running is left alone.
 */
async function archiveIdleChats(orgRetentionDays: number): Promise<void> {
  const rows = await getDataStore().userPreferences.listByKey(CHAT_ARCHIVE_KEY);
  for (const row of rows) {
    const days = effectiveArchiveDays(parseChatArchivePrefs(row.value), orgRetentionDays);
    if (days === null) continue;
    const archived = await getDataStore().chats.archiveIdle(
      row.subject,
      new Date(Date.now() - days * DAY_MS)
    );
    if (archived.length === 0) continue;
    logger.info('auto-archived {count} idle chat(s)', {
      component: 'worker-agents/chat-retention',
      count: archived.length,
    });
  }
}

/** Chats whose attachment bytes are gone (or never existed); the rest wait. */
async function deleteAttachmentBlobs(
  chatIds: string[],
  store: BlobStore | null
): Promise<string[]> {
  const attachments = await getDataStore().artifacts.listBlobsInChats(chatIds);
  const blocked = new Set<string>();
  for (const attachment of attachments) {
    if (!attachment.chatId) continue;
    if (!store) {
      blocked.add(attachment.chatId);
      continue;
    }
    const deleted = await store.deleteObject(attachment.blobKey);
    if (deleted.ok || deleted.err.type === 'NOT_FOUND') {
      await getDataStore().artifacts.delete(attachment.id);
    } else {
      blocked.add(attachment.chatId);
      logger.warn('chat retention could not delete a blob: {error}', {
        component: 'worker-agents/chat-retention',
        error: deleted.err.message ?? deleted.err.type,
      });
    }
  }
  return chatIds.filter((id) => !blocked.has(id));
}

async function pruneOrphanGrants(): Promise<void> {
  await getDataStore().resourceGrants.pruneOrphans();
  await delegateClient().pruneOrphanResourceKeys();
}

async function blobStore(): Promise<BlobStore | null> {
  const store = await resolveTenantBlobStore();
  return store.ok ? store.val : null;
}
