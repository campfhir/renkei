/**
 * The chat's own tools, chosen per turn from what the chat has: reading
 * and staging its attachments, writing a file for the person to keep,
 * remembering things for its project or (outside a project) for the
 * person across every chat they own, recalling their other chats, and
 * compacting its own history (chat_compact, offered unconditionally — see
 * below). Each of the others is registered only when it can do something — no project, no
 * project memory tools; a chat in a project, no personal memory or recall
 * tools either, since a project is self-contained and does not reach
 * outside itself; no attachments, no attachment tools; no file store, no
 * writing; no chart renderer, no charts — so the model is never offered a
 * verb that can only fail.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { LocalTool, LocalToolContext } from './local-tools';
import type { ChatToolConfig } from './tool-config';
import { sandboxChartsEnabled } from '@renkei/sandbox-client';
import { attachmentTools } from './attachment-tools';
import { compactionTools } from './compaction-tools';
import { chartTools } from './chart-tools';
import { fileTools } from './file-tools';
import { memoryTools } from './memory-tools';
import { userMemoryTools } from './user-memory-tools';
import { recallTools } from './recall-tools';

export async function chatLocalTools(
  db: Kysely<DB>,
  context: LocalToolContext,
  toolConfig: ChatToolConfig,
  /** The org has somewhere to keep files; without one nothing written could be kept. */
  filesAllowed: boolean
): Promise<LocalTool[]> {
  // chat_compact acts on the chat's own stored messages, never an
  // organization system, so every chat gets it — no project or
  // read-only gate, unlike the tools below.
  const tools: LocalTool[] = [...compactionTools()];
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
  if (filesAllowed) {
    tools.push(...fileTools());
    // A chart needs the worker's Chromium as well as somewhere to keep the file.
    if (sandboxChartsEnabled()) tools.push(...chartTools());
  }
  if (context.projectId) {
    if (!context.readOnly) tools.push(...memoryTools());
  } else if (!context.readOnly) {
    tools.push(...userMemoryTools());
  }
  // Recall sees the project's own chats in a project, the person's own
  // outside one — the tool decides from the context (recall-tools.ts).
  tools.push(...recallTools());
  return tools;
}
