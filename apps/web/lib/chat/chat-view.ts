/**
 * A chat page's initial data: the chat as the viewer may see it, its
 * messages, and the turn in flight if any — the same shape the SSE
 * snapshot path sends, so the page and a reconnect agree.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { ChatAccess } from './access';
import { listMessages, toMessageView } from './messages';
import { getProjectRow } from './projects';
import { getActiveTurn, toTurnView } from './turns';
import type { AttachmentView, ChatMessageView, ChatView } from './views';

export async function loadChatView(
  db: Kysely<DB>,
  tenantId: string,
  access: ChatAccess,
  viewerSubject: string
): Promise<{ chat: ChatView; messages: ChatMessageView[] }> {
  const { chat } = access;
  const [rows, active, project, owner, attachments] = await Promise.all([
    listMessages(db, tenantId, chat.id),
    getActiveTurn(db, chat.id),
    chat.projectId ? getProjectRow(db, tenantId, chat.projectId) : Promise.resolve(null),
    chat.ownerSubject === viewerSubject
      ? Promise.resolve(null)
      : db
          .selectFrom('identities')
          .select(['display_name', 'email'])
          .where('tenant_id', '=', tenantId)
          .where('subject', '=', chat.ownerSubject)
          .executeTakeFirst(),
    db
      .selectFrom('chat_attachments')
      .select([
        'id',
        'filename',
        'content_type',
        'size_bytes',
        'extract_status',
        'message_id',
        'origin',
      ])
      .where('tenant_id', '=', tenantId)
      .where('chat_id', '=', chat.id)
      .orderBy('created_at', 'asc')
      .execute(),
  ]);
  const byMessage = new Map<string, AttachmentView[]>();
  const artifacts: AttachmentView[] = [];
  for (const row of attachments) {
    const view: AttachmentView = {
      id: row.id,
      filename: row.filename,
      contentType: row.content_type,
      sizeBytes: Number(row.size_bytes),
      extractStatus: row.extract_status,
    };
    if (row.origin === 'model') {
      artifacts.push(view);
      continue;
    }
    if (!row.message_id) continue;
    byMessage.set(row.message_id, [...(byMessage.get(row.message_id) ?? []), view]);
  }
  return {
    chat: {
      id: chat.id,
      title: chat.title,
      projectId: chat.projectId,
      projectName: project?.name ?? null,
      llmModelId: chat.llmModelId,
      toolConfig: chat.toolConfig,
      thinkingEnabled: chat.thinkingEnabled,
      ownerSubject: chat.ownerSubject,
      ownerName: owner ? (owner.display_name ?? owner.email ?? null) : null,
      role: access.role,
      archived: chat.archivedAt !== null,
      createdAt: chat.createdAt.toISOString(),
      updatedAt: chat.updatedAt.toISOString(),
      activeTurn: active ? toTurnView(active) : null,
      artifacts,
    },
    messages: rows.map((row) => ({
      ...toMessageView(row),
      attachments: byMessage.get(row.id) ?? [],
    })),
  };
}
