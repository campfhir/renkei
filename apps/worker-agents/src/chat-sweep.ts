/**
 * Chat hygiene, three sweeps in one module.
 *
 * The janitor: a turn's runner heartbeats its row every few hundred
 * milliseconds while it works, so a `running` turn whose heartbeat is
 * minutes old belongs to a process that died. It is marked interrupted
 * — with its still-streaming reply — so the chat accepts a new turn (the
 * partial unique index only counts `running`) and the person sees what
 * happened instead of a spinner that never stops.
 *
 * Retention: the org's chatRetentionDays (0 = keep). Bytes go before rows
 * — an attachment whose object could not be deleted keeps its row so a
 * later sweep can try again, and nothing in the store is ever orphaned
 * by a row that vanished first.
 *
 * Orphaned grants: resource_access_grants has no foreign key to the
 * polymorphic resource it names; the app deletes grants with their
 * resource, and this catches whatever a crash between the two left.
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { resolveTenantBlobStore, type BlobStore } from '@renkei/blob-store';
import { getOrgSettings } from '@renkei/settings';
import { logger } from './logger';

export const CHAT_JANITOR_INTERVAL_MS = 5 * 60_000;
export const CHAT_RETENTION_INTERVAL_MS = 15 * 60_000;

/** Well past the runner's heartbeat cadence; a healthy turn never trips this. */
const STALE_MINUTES = 15;
const RETENTION_BATCH = 500;

export function createChatTurnJanitor(db: Kysely<DB>) {
  return async function sweep(): Promise<void> {
    const stale = await sql<{ id: string }>`
      UPDATE chat_turns
         SET status = 'interrupted',
             error = 'The reply stopped unexpectedly and did not finish.',
             finished_at = NOW(),
             updated_at = NOW()
       WHERE status = 'running'
         AND updated_at < NOW() - make_interval(mins => ${STALE_MINUTES})
      RETURNING id
    `.execute(db);
    if (stale.rows.length === 0) return;
    await db
      .updateTable('chat_messages')
      .set({ status: 'interrupted', updated_at: sql<Date>`NOW()` })
      .where(
        'turn_id',
        'in',
        stale.rows.map((row) => row.id)
      )
      .where('status', '=', 'streaming')
      .execute();
    logger.warn('interrupted {count} chat turn(s) whose runner went silent', {
      component: 'worker-agents/chat-janitor',
      count: stale.rows.length,
    });
  };
}

export function createChatRetentionSweep(
  db: Kysely<DB>,
  store: (tenantId: string) => Promise<BlobStore | null> = blobStore
) {
  return async function sweep(): Promise<void> {
    const tenants = await db.selectFrom('tenants').select('id').execute();
    for (const tenant of tenants) {
      const settings = await getOrgSettings(tenant.id);
      if (!settings.ok || settings.val.chatRetentionDays <= 0) continue;
      const days = settings.val.chatRetentionDays;
      const expired = await db
        .selectFrom('chats')
        .select('id')
        .where('tenant_id', '=', tenant.id)
        .where('updated_at', '<', sql<Date>`NOW() - make_interval(days => ${days})`)
        .limit(RETENTION_BATCH)
        .execute();
      if (expired.length === 0) continue;
      const chatIds = expired.map((row) => row.id);
      const deletable = await deleteAttachmentBlobs(db, tenant.id, chatIds, await store(tenant.id));
      if (deletable.length === 0) continue;
      await db
        .deleteFrom('chats')
        .where('tenant_id', '=', tenant.id)
        .where('id', 'in', deletable)
        .execute();
      await db
        .deleteFrom('resource_access_grants')
        .where('tenant_id', '=', tenant.id)
        .where('resource_kind', '=', 'chat')
        .where('resource_id', 'in', deletable)
        .execute();
      logger.info('chat retention removed {count} chat(s)', {
        component: 'worker-agents/chat-retention',
        tenantId: tenant.id,
        count: deletable.length,
      });
    }
    await pruneOrphanGrants(db);
  };
}

/** Chats whose attachment bytes are gone (or never existed); the rest wait. */
async function deleteAttachmentBlobs(
  db: Kysely<DB>,
  tenantId: string,
  chatIds: string[],
  store: BlobStore | null
): Promise<string[]> {
  const attachments = await db
    .selectFrom('chat_attachments')
    .select(['id', 'chat_id', 'blob_key'])
    .where('tenant_id', '=', tenantId)
    .where('chat_id', 'in', chatIds)
    .execute();
  const blocked = new Set<string>();
  for (const attachment of attachments) {
    if (!attachment.chat_id) continue;
    if (!store) {
      blocked.add(attachment.chat_id);
      continue;
    }
    const deleted = await store.deleteObject(attachment.blob_key);
    if (deleted.ok || deleted.err.type === 'NOT_FOUND') {
      await db.deleteFrom('chat_attachments').where('id', '=', attachment.id).execute();
    } else {
      blocked.add(attachment.chat_id);
      logger.warn('chat retention could not delete a blob: {error}', {
        component: 'worker-agents/chat-retention',
        tenantId,
        error: deleted.err.message ?? deleted.err.type,
      });
    }
  }
  return chatIds.filter((id) => !blocked.has(id));
}

async function pruneOrphanGrants(db: Kysely<DB>): Promise<void> {
  await sql`
    DELETE FROM resource_access_grants g
     WHERE (g.resource_kind = 'chat' AND NOT EXISTS (SELECT 1 FROM chats c WHERE c.id = g.resource_id))
        OR (g.resource_kind = 'chat_project' AND NOT EXISTS (SELECT 1 FROM chat_projects p WHERE p.id = g.resource_id))
        OR (g.resource_kind = 'prompt_library' AND NOT EXISTS (SELECT 1 FROM prompt_libraries l WHERE l.id = g.resource_id))
  `.execute(db);
}

async function blobStore(tenantId: string): Promise<BlobStore | null> {
  const store = await resolveTenantBlobStore(tenantId);
  return store.ok ? store.val : null;
}
