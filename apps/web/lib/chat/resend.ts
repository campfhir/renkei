/**
 * Resend a prompt — as it was, or edited — and start over from there.
 *
 * Everything from that prompt on is removed first: the rows of its turn
 * and every later turn, the turns themselves, and the files those
 * replies produced (their bytes too, best effort, after the rows are
 * gone). The prompt's own uploads survive: deleting their message only
 * unlinks them, and the new turn links them again. Then it is Send as
 * usual, through `startChatTurn`.
 *
 * The removal and the new turn are two steps, not one transaction: the
 * new turn runs after the response and cannot be inside it. Should Send
 * fail after the removal (no model, say), the chat is left truncated at
 * the prompt — a state the person can see and continue from.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { resolveTenantBlobStore } from '@renkei/blob-store';
import { logger } from '@/lib/logger';
import { isUuid } from '@/lib/uuid';
import { resolveChatAccess } from './access';
import { attachmentPromptBlocks } from './attachments';
import { openBlocks } from './content-crypto';
import { getActiveTurn } from './turns';
import { startChatTurn, type StartTurnError, type StartedTurn } from './start-turn';

export type ResendError = StartTurnError | 'NOT_PROMPT';

export interface ResendInput {
  tenantId: string;
  session: { subject: string; roles: string[] };
  chatId: string;
  messageId: string;
  /** The edited text; null resends the prompt as it was. */
  text: string | null;
  /** Uploads made while editing, on top of the prompt's own. */
  extraAttachmentIds?: string[];
  llmModelId?: string | null;
  defer?: (task: () => Promise<void>) => void;
}

export interface Resent extends StartedTurn {
  /** The resent prompt's old seq: rows from here on were removed. */
  fromSeq: number;
  /** Files tools produced in the removed replies, no longer listed. */
  removedArtifactIds: string[];
}

/** The typed text of a stored prompt: its first text block, without the attachment excerpts. */
export function promptTextOf(content: string): string {
  const blocks = openBlocks(content);
  const first = blocks.find((block) => block.type === 'text');
  if (!first || first.type !== 'text') return '';
  return first.text.replace(/<attachment [^>]*>[\s\S]*?<\/attachment>/g, '').trim();
}

export async function resendFromMessage(
  db: Kysely<DB>,
  input: ResendInput
): Promise<Result<Resent, ResendError>> {
  if (!isUuid(input.messageId)) return err('NOT_FOUND' as const);
  const access = await resolveChatAccess(db, input.tenantId, input.session.subject, input.chatId);
  if (!access) return err('NOT_FOUND' as const);
  if (access.role !== 'owner') return err('FORBIDDEN' as const);
  if (await getActiveTurn(db, access.chat.id)) return err('ALREADY_RUNNING' as const);

  const prompt = await db
    .selectFrom('chat_messages')
    .select(['id', 'seq', 'kind', 'content'])
    .where('tenant_id', '=', input.tenantId)
    .where('chat_id', '=', access.chat.id)
    .where('id', '=', input.messageId)
    .executeTakeFirst();
  if (!prompt) return err('NOT_FOUND' as const);
  if (prompt.kind !== 'prompt') return err('NOT_PROMPT' as const);

  const text = input.text !== null ? input.text : promptTextOf(prompt.content);
  const ownUploads = await db
    .selectFrom('chat_attachments')
    .select('id')
    .where('tenant_id', '=', input.tenantId)
    .where('chat_id', '=', access.chat.id)
    .where('message_id', '=', prompt.id)
    .where('origin', '=', 'upload')
    .execute();
  const attachmentIds = [
    ...ownUploads.map((row) => row.id),
    ...(input.extraAttachmentIds ?? []).filter(isUuid),
  ];

  const removedBlobKeys: string[] = [];
  const removedArtifactIds: string[] = [];
  await db.transaction().execute(async (trx) => {
    const doomed = await trx
      .selectFrom('chat_messages')
      .select(['id', 'turn_id'])
      .where('chat_id', '=', access.chat.id)
      .where('seq', '>=', prompt.seq)
      .execute();
    const messageIds = doomed.map((row) => row.id);
    const turnIds = [...new Set(doomed.flatMap((row) => (row.turn_id ? [row.turn_id] : [])))];
    if (messageIds.length > 0) {
      const artifacts = await trx
        .selectFrom('chat_attachments')
        .select(['id', 'blob_key'])
        .where('chat_id', '=', access.chat.id)
        .where('origin', '=', 'model')
        .where('message_id', 'in', messageIds)
        .execute();
      if (artifacts.length > 0) {
        await trx
          .deleteFrom('chat_attachments')
          .where(
            'id',
            'in',
            artifacts.map((row) => row.id)
          )
          .execute();
        removedBlobKeys.push(...artifacts.map((row) => row.blob_key));
        removedArtifactIds.push(...artifacts.map((row) => row.id));
      }
      await trx.deleteFrom('chat_messages').where('id', 'in', messageIds).execute();
    }
    if (turnIds.length > 0) {
      await trx
        .deleteFrom('chat_turns')
        .where('chat_id', '=', access.chat.id)
        .where('id', 'in', turnIds)
        .execute();
    }
  });
  if (removedBlobKeys.length > 0) {
    const store = await resolveTenantBlobStore(input.tenantId);
    if (store.ok) {
      for (const key of removedBlobKeys) {
        const deleted = await store.val.deleteObject(key);
        if (!deleted.ok && deleted.err.type !== 'NOT_FOUND') {
          // The retention sweep cannot see an orphan; say so where someone can.
          logger.warn('chat artifact blob not deleted: {key} {reason}', {
            key,
            reason: deleted.err.type,
          });
        }
      }
    }
  }

  const extraBlocks =
    attachmentIds.length > 0
      ? await attachmentPromptBlocks(
          db,
          input.tenantId,
          input.session.subject,
          access.chat.id,
          attachmentIds
        )
      : [];
  const started = await startChatTurn(db, {
    tenantId: input.tenantId,
    session: input.session,
    chatId: access.chat.id,
    text,
    extraBlocks,
    attachmentIds,
    llmModelId: input.llmModelId ?? null,
    defer: input.defer,
  });
  if (!started.ok) return started;
  return ok({ ...started.val, fromSeq: prompt.seq, removedArtifactIds });
}
