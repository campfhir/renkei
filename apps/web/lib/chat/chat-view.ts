/**
 * A chat page's initial data: the chat as the viewer may see it, its
 * messages, and the turn in flight if any — the same shape the SSE
 * snapshot path sends, so the page and a reconnect agree.
 */

import { getDataStore } from '@renkei/db';
import type { ChatAccess } from './access';
import { listMessages, toMessageView } from './messages';
import { workspaceBranches } from '@/lib/code/branches';
import { getProjectRow } from './projects';
import { getActiveTurn, toTurnView } from './turns';
import { listWidgetDecisions } from './widget-tools';
import { loadQueuedSends } from './queued-sends';
import { loadDraft } from './drafts';
import { estimateRequestTokens, getRequestOverhead, latestChatSummary } from './compaction';
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
export function withResolvedWidgets(
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
  access: ChatAccess,
  viewerSubject: string
): Promise<{ chat: ChatView; messages: ChatMessageView[] }> {
  const { chat } = access;
  const [
    rows,
    active,
    project,
    owner,
    attachments,
    widgetDecisions,
    queue,
    summary,
    overhead,
    draft,
  ] = await Promise.all([
    listMessages(chat.id, access.cipher),
    getActiveTurn(chat.id),
    chat.projectId ? getProjectRow(chat.projectId) : Promise.resolve(null),
    chat.ownerSubject === viewerSubject
      ? Promise.resolve(null)
      : getDataStore().identities.get(chat.ownerSubject),
    getDataStore().artifacts.listByChat(chat.id),
    listWidgetDecisions(chat.id),
    // Only the owner sends, so only the owner has a queue to show.
    chat.ownerSubject === viewerSubject ? loadQueuedSends(chat.id) : Promise.resolve([]),
    latestChatSummary(chat.id, access.cipher),
    getRequestOverhead(chat.id),
    // Like the queue, only the owner has a box to put it back in.
    chat.ownerSubject === viewerSubject ? loadDraft(chat.id, access.cipher) : Promise.resolve(''),
  ]);
  const branches =
    project?.kind === 'code' && chat.workspaceId
      ? await workspaceBranches([chat.workspaceId])
      : new Map<string, string>();
  const byMessage = new Map<string, AttachmentView[]>();
  const artifacts: AttachmentView[] = [];
  for (const row of attachments) {
    const view: AttachmentView = {
      id: row.id,
      filename: row.filename,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      extractStatus: row.extractStatus,
      messageId: row.messageId,
    };
    if (row.origin === 'model') {
      artifacts.push(view);
      continue;
    }
    if (!row.messageId) continue;
    byMessage.set(row.messageId, [...(byMessage.get(row.messageId) ?? []), view]);
  }
  return {
    chat: {
      id: chat.id,
      title: chat.title,
      projectId: chat.projectId,
      projectName: project?.name ?? null,
      projectKind: project?.kind ?? null,
      projectBranch: chat.workspaceId ? (branches.get(chat.workspaceId) ?? null) : null,
      llmModelId: chat.llmModelId,
      toolConfig: chat.toolConfig,
      projectToolConfig: project?.toolConfig ?? null,
      thinkingEnabled: chat.thinkingEnabled,
      autoMode: chat.autoMode,
      ownerSubject: chat.ownerSubject,
      ownerName: owner ? (owner.displayName ?? owner.email ?? null) : null,
      role: access.role,
      archived: chat.archivedAt !== null,
      temporary: chat.temporary,
      keyUnavailable: access.cipher.unavailable,
      createdAt: chat.createdAt.toISOString(),
      updatedAt: chat.updatedAt.toISOString(),
      activeTurn: active ? toTurnView(active) : null,
      artifacts,
      contextTokens: rows.some((row) => row.usage)
        ? Math.round(
            estimateRequestTokens(
              rows,
              summary ? { createdAt: summary.createdAt, chars: summary.content.length } : null,
              overhead
            )
          )
        : null,
      queue,
      draft,
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
