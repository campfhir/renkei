/**
 * What the browser sees of a chat. Every shape here is JSON-safe and
 * free of anything the client must not carry: attachment blocks lose
 * their base64 (the bytes are reachable only through the download route),
 * and nothing carries a subject other than the owner's for attribution.
 */

import type { LlmContentBlock, LlmUsage } from '@renkei/agent-llm';

export type ChatRole = 'owner' | 'viewer';
export type MessageRole = 'user' | 'assistant';
export type MessageKind = 'prompt' | 'assistant' | 'tool_results';
export type MessageStatus = 'complete' | 'streaming' | 'canceled' | 'interrupted' | 'failed';
export type TurnStatus = 'running' | 'completed' | 'failed' | 'canceled' | 'interrupted';

/** A content block as rendered: attachments carry size, not bytes. */
export type ChatBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'redacted_thinking' }
  | { type: 'tool_use'; id: string; name: string; input: unknown; partialJson?: string }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
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

export interface TurnView {
  id: string;
  status: TurnStatus;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ChatToolConfigView {
  connectors: string[];
}

export interface ChatView {
  id: string;
  title: string | null;
  projectId: string | null;
  projectName: string | null;
  llmModelId: string | null;
  toolConfig: ChatToolConfigView | null;
  thinkingEnabled: boolean;
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
  /** The project's name, for the list's subheading; null outside a project. */
  projectName: string | null;
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
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        toolUseId: block.toolUseId,
        content: block.content,
        ...(block.isError ? { isError: true } : {}),
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
