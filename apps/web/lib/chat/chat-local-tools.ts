/**
 * The chat's own tools, chosen per turn from what the chat has: reading
 * and staging its attachments, and remembering things for its project.
 * Each is registered only when it can do something — no project, no
 * memory tools; no attachments, no attachment tools — so the model is
 * never offered a verb that can only fail.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { LocalTool, LocalToolContext } from './local-tools';
import type { ChatToolConfig } from './tool-config';
import { attachmentTools } from './attachment-tools';
import { memoryTools } from './memory-tools';

export async function chatLocalTools(
  db: Kysely<DB>,
  context: LocalToolContext,
  toolConfig: ChatToolConfig
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
  if (context.projectId && !context.readOnly) tools.push(...memoryTools());
  return tools;
}
