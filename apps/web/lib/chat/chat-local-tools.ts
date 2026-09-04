/**
 * The chat's own tools, chosen per turn from what the chat has: reading
 * and staging its attachments, writing a file for the person to keep, and
 * remembering things for its project. Each is registered only when it can
 * do something — no project, no memory tools; no attachments, no
 * attachment tools; no file store, no writing — so the model is never
 * offered a verb that can only fail.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { LocalTool, LocalToolContext } from './local-tools';
import type { ChatToolConfig } from './tool-config';
import { attachmentTools } from './attachment-tools';
import { fileTools } from './file-tools';
import { memoryTools } from './memory-tools';

export async function chatLocalTools(
  db: Kysely<DB>,
  context: LocalToolContext,
  toolConfig: ChatToolConfig,
  /** The org has somewhere to keep files; without one nothing written could be kept. */
  filesAllowed: boolean
): Promise<LocalTool[]> {
  const tools: LocalTool[] = [];
  const hasFiles = await db
    .selectFrom('chat_attachments')
    .select('id')
    .where('tenant_id', '=', context.tenantId)
    .where((eb) =>
      eb.or([
        eb('chat_id', '=', context.chatId),
        ...(context.projectId ? [eb('project_id', '=', context.projectId)] : []),
      ])
    )
    .limit(1)
    .executeTakeFirst();
  if (hasFiles) tools.push(...attachmentTools(toolConfig));
  if (filesAllowed) tools.push(...fileTools());
  if (context.projectId && !context.readOnly) tools.push(...memoryTools());
  return tools;
}
