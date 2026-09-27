/**
 * A chat page's initial data: the chat as the viewer may see it, its
 * messages, and the turn in flight if any — the same shape the SSE
 * snapshot path sends, so the page and a reconnect agree.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { ChatAccess } from './access';
import { listMessages, toMessageView } from './messages';
import { workspaceBranches } from '@/lib/code/branches';
import { getProjectRow } from './projects';
import { getActiveTurn, toTurnView } from './turns';
import { listWidgetDecisions } from './widget-tools';
import { widgetStateKeyOf } from './views';
import type {
  AttachmentView,
  ChatBlock,
  ChatMessageView,
  ChatView,
  WidgetDecisionState,
} from './views';

/**
 * A message's blocks, with every widget card's already-made decision
 * (`chat_widget_decisions`, widget-tools.ts) stamped onto its `tool_result`
 * block as `resolved` — the reader's counterpart to widget-tools.ts's
 * `recordWidgetDecision`. Without this, a card's receipt lives only in the
 * browser that clicked its button (mcp-widgets/src/ui.ts's localStorage
 * rememberDone/recallDone), and opening the same chat elsewhere replays the
 * unchanged tool_result as live Confirm/Cancel buttons for something
 * already decided.
 */
function withResolvedWidgets(
  blocks: ChatBlock[],
  decisions: Map<string, WidgetDecisionState>
): ChatBlock[] {
  if (decisions.size === 0) return blocks;
  return blocks.map((block) => {
    const stateKey = widgetStateKeyOf(block);
    const resolved = stateKey ? decisions.get(stateKey) : undefined;
    return resolved && block.type === 'tool_result' ? { ...block, resolved } : block;
  });
}

export async function loadChatView(
  db: Kysely<DB>,
  tenantId: string,
  access: ChatAccess,
  viewerSubject: string
): Promise<{ chat: ChatView; messages: ChatMessageView[] }> {
  const { chat } = access;
  const [rows, active, project, owner, attachments, widgetDecisions] = await Promise.all([
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
    listWidgetDecisions(db, tenantId, chat.id),
  ]);
  const branches =
    project?.kind === 'code' && project.workspaceId
      ? await workspaceBranches(db, tenantId, [project.workspaceId])
      : new Map<string, string>();
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
      projectKind: project?.kind ?? null,
      projectBranch: project?.workspaceId ? (branches.get(project.workspaceId) ?? null) : null,
      projectActiveChatId: project?.kind === 'code' ? project.activeChatId : null,
      llmModelId: chat.llmModelId,
      toolConfig: chat.toolConfig,
      projectToolConfig: project?.toolConfig ?? null,
      thinkingEnabled: chat.thinkingEnabled,
      autoMode: chat.autoMode,
      ownerSubject: chat.ownerSubject,
      ownerName: owner ? (owner.display_name ?? owner.email ?? null) : null,
      role: access.role,
      archived: chat.archivedAt !== null,
      createdAt: chat.createdAt.toISOString(),
      updatedAt: chat.updatedAt.toISOString(),
      activeTurn: active ? toTurnView(active) : null,
      artifacts,
    },
    messages: rows.map((row) => {
      const view = toMessageView(row);
      return {
        ...view,
        blocks: withResolvedWidgets(view.blocks, widgetDecisions),
        attachments: byMessage.get(row.id) ?? [],
      };
    }),
  };
}
