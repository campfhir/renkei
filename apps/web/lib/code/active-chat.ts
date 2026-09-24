/**
 * One active chat per code project.
 *
 * A code project has one checkout on one branch, shared by every chat in
 * it (docs/sandbox-workspaces-design.md), so two chats working in it at
 * once would step on each other's edits and branch switches. Rather than
 * a checkout per chat, the project keeps one chat that may continue —
 * `chat_projects.active_chat_id` (migration 119) — and every other chat
 * in it is history: still there to read, never to send in.
 *
 * Starting a new chat in the project (`createChatInProject`) is the one
 * way the active chat moves forward: the new chat becomes active and the
 * previous one becomes history, in one transaction under a lock on the
 * project row. It is refused while the active chat's reply is running:
 * that turn is working in the checkout, and a second chat starting
 * beside it is exactly the confusion the rule exists to prevent — the
 * person stops the reply, or waits, and starts again. Deleting the active
 * chat clears the reference (the column's foreign key); archiving it
 * does the same here (`releaseActiveChat`), so a project may have no
 * active chat until the next new one. Unarchiving does not bring it
 * back: history is history.
 *
 * A chat project (`kind = 'chat'`) is untouched by all of this — its chats
 * are independent conversations that share context, and `isHistoryChat`
 * is always false there.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { createChat } from '@/lib/chat/store';
import type { ChatToolConfig } from '@/lib/chat/tool-config';
import { getActiveTurn } from '@/lib/chat/turns';

/** A code project's chat that is not its active one. */
export function isHistoryChat(
  project: { kind: 'chat' | 'code'; activeChatId: string | null } | null,
  chatId: string
): boolean {
  return project !== null && project.kind === 'code' && project.activeChatId !== chatId;
}

export type CreateChatInProjectError =
  /** The project's active chat has a reply in progress. */
  'TURN_RUNNING';

/**
 * Create a chat in a project. In a code project the new chat becomes the
 * active one, unless the current active chat is mid-reply; in a chat
 * project this is `createChat`, no more. The project row is locked for
 * the check and the switch together, so two people starting a chat at
 * the same instant leave exactly one of them active.
 */
export async function createChatInProject(
  db: Kysely<DB>,
  input: {
    tenantId: string;
    ownerSubject: string;
    projectId: string;
    llmModelId: string | null;
    toolConfig: ChatToolConfig | null;
    thinkingEnabled: boolean;
  }
): Promise<Result<string, CreateChatInProjectError>> {
  return db.transaction().execute(async (trx) => {
    const project = await trx
      .selectFrom('chat_projects')
      .select(['id', 'kind', 'active_chat_id'])
      .where('tenant_id', '=', input.tenantId)
      .where('id', '=', input.projectId)
      .forUpdate()
      .executeTakeFirst();
    const code = project?.kind === 'code';
    if (code && project.active_chat_id && (await getActiveTurn(trx, project.active_chat_id))) {
      return err('TURN_RUNNING' as const);
    }
    const chatId = await createChat(trx, {
      tenantId: input.tenantId,
      ownerSubject: input.ownerSubject,
      projectId: input.projectId,
      llmModelId: input.llmModelId,
      toolConfig: input.toolConfig,
      thinkingEnabled: input.thinkingEnabled,
      autoMode: code,
    });
    if (code) {
      await trx
        .updateTable('chat_projects')
        .set({ active_chat_id: chatId })
        .where('tenant_id', '=', input.tenantId)
        .where('id', '=', input.projectId)
        .execute();
    }
    return ok(chatId);
  });
}

/**
 * The chat stops being its code project's active one — on archive. A
 * no-op for any chat that is not a code project's active chat, so callers
 * need not check first.
 */
export async function releaseActiveChat(
  db: Kysely<DB>,
  tenantId: string,
  chatId: string
): Promise<void> {
  await db
    .updateTable('chat_projects')
    .set({ active_chat_id: null })
    .where('tenant_id', '=', tenantId)
    .where('kind', '=', 'code')
    .where('active_chat_id', '=', chatId)
    .execute();
}
