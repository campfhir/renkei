/**
 * The composer's queue, kept server-side (`chat_queued_sends`): messages
 * (and compaction requests) held behind a running turn. The page rewrites
 * the whole list on every change and reads it back with the chat, so a
 * reload or a second tab sees what is still waiting.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { AttachmentView, QueuedSend } from './views';

const MAX_ITEMS = 50;
const MAX_TEXT_CHARS = 200_000;
const MAX_ATTACHMENTS = 50;

/** A plain object's entries as a record, or null for anything else. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}

function parseAttachment(value: unknown): AttachmentView | null {
  const v = asRecord(value);
  if (!v) return null;
  if (
    typeof v.id !== 'string' ||
    typeof v.filename !== 'string' ||
    typeof v.contentType !== 'string' ||
    typeof v.sizeBytes !== 'number' ||
    typeof v.extractStatus !== 'string'
  ) {
    return null;
  }
  return {
    id: v.id,
    filename: v.filename,
    contentType: v.contentType,
    sizeBytes: v.sizeBytes,
    extractStatus: v.extractStatus,
  };
}

/** The queue a request or a stored row describes, or null when any item is malformed. */
export function parseQueue(value: unknown): QueuedSend[] | null {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return null;
  const queue: QueuedSend[] = [];
  for (const raw of value) {
    const item = asRecord(raw);
    if (!item) return null;
    if (typeof item.id !== 'number' || !Number.isSafeInteger(item.id)) return null;
    if (item.kind === 'compact') {
      queue.push({ id: item.id, kind: 'compact' });
      continue;
    }
    const input = asRecord(item.input);
    if (item.kind !== 'message' || !input) return null;
    if (typeof input.text !== 'string' || input.text.length > MAX_TEXT_CHARS) return null;
    if (!Array.isArray(input.attachments) || input.attachments.length > MAX_ATTACHMENTS) {
      return null;
    }
    const attachments: AttachmentView[] = [];
    for (const attachment of input.attachments) {
      const parsed = parseAttachment(attachment);
      if (!parsed) return null;
      attachments.push(parsed);
    }
    queue.push({
      id: item.id,
      kind: 'message',
      input: { text: input.text, attachments, ...(input.voice === true ? { voice: true } : {}) },
    });
  }
  return queue;
}

export async function loadQueuedSends(
  db: Kysely<DB>,
  tenantId: string,
  chatId: string
): Promise<QueuedSend[]> {
  const row = await db
    .selectFrom('chat_queued_sends')
    .select('queue')
    .where('tenant_id', '=', tenantId)
    .where('chat_id', '=', chatId)
    .executeTakeFirst();
  return parseQueue(row?.queue) ?? [];
}

export async function saveQueuedSends(
  db: Kysely<DB>,
  tenantId: string,
  chatId: string,
  queue: QueuedSend[]
): Promise<void> {
  if (queue.length === 0) {
    await db
      .deleteFrom('chat_queued_sends')
      .where('tenant_id', '=', tenantId)
      .where('chat_id', '=', chatId)
      .execute();
    return;
  }
  const json = JSON.stringify(queue);
  await db
    .insertInto('chat_queued_sends')
    .values({ tenant_id: tenantId, chat_id: chatId, queue: json })
    .onConflict((oc) =>
      oc.columns(['tenant_id', 'chat_id']).doUpdateSet({ queue: json, updated_at: new Date() })
    )
    .execute();
}
