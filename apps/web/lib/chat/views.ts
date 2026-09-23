/**
 * What the browser sees of a chat. Every shape here is JSON-safe and
 * free of anything the client must not carry: attachment blocks lose
 * their base64 (the bytes are reachable only through the download route),
 * and nothing carries a subject other than the owner's for attribution.
 */

import type { LlmContentBlock, LlmUsage } from '@renkei/agent-llm';

export type ChatRole = 'owner' | 'viewer';
export type MessageRole = 'user' | 'assistant';
/**
 * 'nudge': a user-role row the runner itself wrote in auto mode — the
 * word to carry on when a reply ended without the task marked complete
 * (auto-mode.ts). Shown as a note, never as the person's bubble.
 * 'note': a user-role row the code pane wrote for what the person did
 * to the checkout by hand — a save, a commit, a push (lib/code/notes.ts).
 * Shown as a small line too; the model reads it as part of the thread.
 */
export type MessageKind = 'prompt' | 'assistant' | 'tool_results' | 'nudge' | 'note';
export type MessageStatus = 'complete' | 'streaming' | 'canceled' | 'interrupted' | 'failed';
export type TurnStatus = 'running' | 'completed' | 'failed' | 'canceled' | 'interrupted';
/** 'compaction': a chat_compact pass riding the turn machinery, no messages of its own. */
export type TurnKind = 'reply' | 'compaction';

/** A content block as rendered: attachments carry size, not bytes. */
export type ChatBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'redacted_thinking' }
  | { type: 'tool_use'; id: string; name: string; input: unknown; partialJson?: string }
  | {
      type: 'tool_result';
      toolUseId: string;
      content: string;
      isError?: boolean;
      /** MCP Apps widget binding — see LlmContentBlock's tool_result doc. */
      uiResourceUri?: string;
      structuredContent?: unknown;
    }
  | { type: 'document'; mediaType: string; title?: string; bytes: number }
  | { type: 'image'; mediaType: string; bytes: number };

export interface ChatMessageView {
  id: string;
  turnId: string | null;
  seq: number;
  role: MessageRole;
  kind: MessageKind;
  status: MessageStatus;
  blocks: ChatBlock[];
  llmModelId: string | null;
  provider: string | null;
  model: string | null;
  stopReason: string | null;
  usage: LlmUsage | null;
  error: string | null;
  createdAt: string;
  /** Attachments the person sent with this prompt (Phase 5 fills these). */
  attachments: AttachmentView[];
}

export interface AttachmentView {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  extractStatus: string;
}

/** What a person answers a permission ask with. */
export type ToolPermissionDecision = 'once' | 'always' | 'deny';

/**
 * The tool call a running turn is parked behind: the runner asked, the
 * owner has not answered yet. Carried on the turn (so a reload or a
 * reconnect through the snapshot path finds it) and on its own stream
 * event (so an open thread shows it the moment it is raised). The call's
 * name and input are in the assistant row's tool_use block by id; only
 * what is needed to find that block and to ask rides here.
 */
export interface PendingToolPermission {
  toolUseId: string;
  messageId: string;
  name: string;
  requestedAt: string;
}

export interface TurnView {
  id: string;
  status: TurnStatus;
  kind: TurnKind;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** The ask in flight, if the turn is waiting on one; absent or null otherwise. */
  pendingPermission?: PendingToolPermission | null;
}

export interface ChatToolConfigView {
  connectors: string[];
}

export interface ChatView {
  id: string;
  title: string | null;
  projectId: string | null;
  projectName: string | null;
  /** Which section the project lives under; null outside a project. */
  projectKind: 'chat' | 'code' | null;
  /** A code project's checkout branch as the worker last saw it; null when none is usable. */
  projectBranch: string | null;
  /**
   * A code project's active chat — the one that may continue
   * (lib/code/active-chat.ts). When it is not this chat, this chat is
   * history: read-only for everyone, its owner included. Null outside a
   * code project, and in one whose active chat is gone.
   */
  projectActiveChatId: string | null;
  llmModelId: string | null;
  toolConfig: ChatToolConfigView | null;
  thinkingEnabled: boolean;
  /**
   * Auto mode (auto-mode.ts): the chat's tools run without asking and a
   * turn carries on until the model marks the task complete. Only a code
   * project's chat honours it; elsewhere it is stored and ignored.
   */
  autoMode: boolean;
  ownerSubject: string;
  ownerName: string | null;
  role: ChatRole;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  /** The running turn, if one is in flight when the page loads. */
  activeTurn: TurnView | null;
  /** Files tools produced in this chat, oldest first. */
  artifacts: AttachmentView[];
}

export interface ChatListItem {
  id: string;
  title: string | null;
  projectId: string | null;
  /** The project's name; null outside a project. */
  projectName: string | null;
  /** Which kind of project that is — a chat in a code project is listed
   *  with a different mark than one in a chat project. Null outside one. */
  projectKind: 'chat' | 'code' | null;
  /** A code project's checkout branch, named under the title beside the project. */
  projectBranch: string | null;
  /** A code project's chat that is no longer its active one: readable, not continuable. */
  history: boolean;
  updatedAt: string;
  lastMessageAt: string | null;
  archived: boolean;
  ownerSubject: string;
  ownerName: string | null;
  /** How the viewer sees it: theirs, shared by name, or via a project. */
  via: 'owner' | 'grant' | 'project';
}

export interface ModelOption {
  id: string;
  label: string;
  provider: string;
  model: string;
  isDefault: boolean;
  /** Anthropic models take a thinking budget; the OpenAI dialect does not. */
  supportsThinking: boolean;
}

/** Bytes of a base64 string, without decoding it. */
function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

export function toChatBlock(block: LlmContentBlock): ChatBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'thinking':
      return { type: 'thinking', thinking: block.thinking };
    case 'redacted_thinking':
      return { type: 'redacted_thinking' };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
        ...(block.partialJson !== undefined ? { partialJson: block.partialJson } : {}),
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        toolUseId: block.toolUseId,
        content: block.content,
        ...(block.isError ? { isError: true } : {}),
        ...(block.uiResourceUri ? { uiResourceUri: block.uiResourceUri } : {}),
        ...('structuredContent' in block ? { structuredContent: block.structuredContent } : {}),
      };
    case 'document':
      return {
        type: 'document',
        mediaType: block.mediaType,
        ...(block.title ? { title: block.title } : {}),
        bytes: base64Bytes(block.dataBase64),
      };
    case 'image':
      return { type: 'image', mediaType: block.mediaType, bytes: base64Bytes(block.dataBase64) };
  }
}

export function toChatBlocks(blocks: LlmContentBlock[]): ChatBlock[] {
  return blocks.map(toChatBlock);
}
