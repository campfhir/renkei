/**
 * The events a turn's stream carries to the browser, and the one reducer
 * that folds them into the thread — shared by the server (which emits
 * them) and the client (which renders the result), so the two can never
 * disagree about what a delta means.
 *
 * Two families:
 *   - incremental events, addressed by message id and block index, that
 *     mirror the LLM stream one-to-one plus the turn runner's own
 *     message boundaries (a new assistant message per tool round, the
 *     tool-results message it fed back);
 *   - `snapshot`, the whole turn's rows as the database has them, sent by
 *     a replica that is not running the turn (or after a reconnect the
 *     ring buffer can no longer replay). The reducer treats it as
 *     "replace this turn's messages" — coarser, never wrong.
 *
 * Pure and dependency-free so it is testable and safe to import from a
 * client component.
 */

import type { LlmUsage } from '@renkei/agent-llm';
import type {
  AttachmentView,
  ChatBlock,
  ChatMessageView,
  MessageKind,
  MessageRole,
  MessageStatus,
  TurnStatus,
  TurnView,
} from './views';

export type ChatStreamEvent =
  | {
      type: 'message_start';
      messageId: string;
      turnId: string;
      seq: number;
      role: MessageRole;
      kind: MessageKind;
      llmModelId: string | null;
      provider: string | null;
      model: string | null;
      createdAt: string;
    }
  | { type: 'block_start'; messageId: string; index: number; block: ChatBlock }
  | { type: 'text_delta'; messageId: string; index: number; text: string }
  | { type: 'thinking_delta'; messageId: string; index: number; thinking: string }
  | { type: 'input_json_delta'; messageId: string; index: number; partialJson: string }
  /** Closes a block; for tool_use carries the parsed input. */
  | { type: 'block_stop'; messageId: string; index: number; block?: ChatBlock }
  | {
      type: 'message_end';
      messageId: string;
      status: MessageStatus;
      stopReason: string | null;
      usage: LlmUsage | null;
      error: string | null;
    }
  /** The runner is executing this tool call (between block_stop and the results message). */
  | { type: 'tool_call_start'; messageId: string; toolUseId: string; name: string }
  /** A tool handed back a file; it is stored and listed under Artifacts. */
  | { type: 'artifact'; messageId: string; attachment: AttachmentView }
  | {
      type: 'snapshot';
      turn: TurnView;
      messages: ChatMessageView[];
      artifacts?: AttachmentView[];
    }
  | { type: 'turn_end'; turnId: string; status: TurnStatus; error: string | null }
  /**
   * Raised by the page, never by the server: a prompt was resent, so this
   * row and everything after it are gone, along with the files those
   * replies produced.
   */
  | { type: 'truncate'; fromSeq: number; removedArtifactIds: string[] };

export interface ThreadState {
  messages: ChatMessageView[];
  /** Tool calls currently executing, by tool_use id. */
  pendingToolCalls: string[];
  turn: TurnView | null;
  /** Files tools produced in this chat, oldest first. */
  artifacts: AttachmentView[];
}

function withArtifacts(current: AttachmentView[], added: AttachmentView[]): AttachmentView[] {
  const known = new Set(current.map((artifact) => artifact.id));
  return [...current, ...added.filter((artifact) => !known.has(artifact.id))];
}

function replaceMessage(
  messages: ChatMessageView[],
  id: string,
  update: (message: ChatMessageView) => ChatMessageView
): ChatMessageView[] {
  return messages.map((message) => (message.id === id ? update(message) : message));
}

function updateBlock(
  message: ChatMessageView,
  index: number,
  update: (block: ChatBlock) => ChatBlock
): ChatMessageView {
  if (index < 0 || index >= message.blocks.length) return message;
  const blocks = message.blocks.slice();
  blocks[index] = update(blocks[index]);
  return { ...message, blocks };
}

/** Blocks are addressed by provider index; a gap is filled with empty text so later indices line up. */
function withBlockAt(message: ChatMessageView, index: number, block: ChatBlock): ChatMessageView {
  const blocks = message.blocks.slice();
  while (blocks.length < index) blocks.push({ type: 'text', text: '' });
  blocks[index] = block;
  return { ...message, blocks };
}

export function applyStreamEvent(state: ThreadState, event: ChatStreamEvent): ThreadState {
  switch (event.type) {
    case 'message_start': {
      if (state.messages.some((message) => message.id === event.messageId)) return state;
      const message: ChatMessageView = {
        id: event.messageId,
        turnId: event.turnId,
        seq: event.seq,
        role: event.role,
        kind: event.kind,
        status: 'streaming',
        blocks: [],
        llmModelId: event.llmModelId,
        provider: event.provider,
        model: event.model,
        stopReason: null,
        usage: null,
        error: null,
        createdAt: event.createdAt,
        attachments: [],
      };
      return {
        ...state,
        messages: [...state.messages, message].sort((a, b) => a.seq - b.seq),
      };
    }
    case 'block_start':
      return {
        ...state,
        messages: replaceMessage(state.messages, event.messageId, (message) =>
          withBlockAt(message, event.index, event.block)
        ),
      };
    case 'text_delta':
      return {
        ...state,
        messages: replaceMessage(state.messages, event.messageId, (message) =>
          updateBlock(message, event.index, (block) =>
            block.type === 'text' ? { type: 'text', text: block.text + event.text } : block
          )
        ),
      };
    case 'thinking_delta':
      return {
        ...state,
        messages: replaceMessage(state.messages, event.messageId, (message) =>
          updateBlock(message, event.index, (block) =>
            block.type === 'thinking'
              ? { type: 'thinking', thinking: block.thinking + event.thinking }
              : block
          )
        ),
      };
    case 'input_json_delta':
      return {
        ...state,
        messages: replaceMessage(state.messages, event.messageId, (message) =>
          updateBlock(message, event.index, (block) =>
            block.type === 'tool_use'
              ? { ...block, partialJson: (block.partialJson ?? '') + event.partialJson }
              : block
          )
        ),
      };
    case 'block_stop':
      if (!event.block) return state;
      return {
        ...state,
        messages: replaceMessage(state.messages, event.messageId, (message) =>
          withBlockAt(message, event.index, event.block ?? message.blocks[event.index])
        ),
      };
    case 'message_end':
      return {
        ...state,
        messages: replaceMessage(state.messages, event.messageId, (message) => ({
          ...message,
          status: event.status,
          stopReason: event.stopReason,
          usage: event.usage,
          error: event.error,
          // A closed message has no partial JSON left to show.
          blocks: message.blocks.map((block) =>
            block.type === 'tool_use' && block.partialJson !== undefined
              ? { type: 'tool_use', id: block.id, name: block.name, input: block.input }
              : block
          ),
        })),
      };
    case 'tool_call_start':
      return state.pendingToolCalls.includes(event.toolUseId)
        ? state
        : { ...state, pendingToolCalls: [...state.pendingToolCalls, event.toolUseId] };
    case 'artifact':
      return { ...state, artifacts: withArtifacts(state.artifacts, [event.attachment]) };
    case 'snapshot': {
      const turnId = event.turn.id;
      const others = state.messages.filter((message) => message.turnId !== turnId);
      return {
        messages: [...others, ...event.messages].sort((a, b) => a.seq - b.seq),
        pendingToolCalls: [],
        turn: event.turn,
        artifacts: withArtifacts(state.artifacts, event.artifacts ?? []),
      };
    }
    case 'truncate': {
      const removed = new Set(event.removedArtifactIds);
      return {
        messages: state.messages.filter((message) => message.seq < event.fromSeq),
        pendingToolCalls: [],
        turn: null,
        artifacts: state.artifacts.filter((artifact) => !removed.has(artifact.id)),
      };
    }
    case 'turn_end':
      return {
        ...state,
        pendingToolCalls: [],
        turn: state.turn
          ? { ...state.turn, status: event.status, error: event.error }
          : {
              id: event.turnId,
              status: event.status,
              error: event.error,
              startedAt: new Date(0).toISOString(),
              finishedAt: null,
            },
        // Whatever was still marked streaming when the turn ended takes the
        // turn's own outcome — the server's flush will agree.
        messages: state.messages.map((message) =>
          message.turnId === event.turnId && message.status === 'streaming'
            ? {
                ...message,
                status:
                  event.status === 'completed'
                    ? 'complete'
                    : event.status === 'running'
                      ? 'streaming'
                      : event.status,
              }
            : message
        ),
      };
  }
}

/** Where a fresh page starts: the persisted rows, no turn in flight. */
export function initialThreadState(
  messages: ChatMessageView[],
  activeTurn: TurnView | null,
  artifacts: AttachmentView[] = []
): ThreadState {
  return { messages, pendingToolCalls: [], turn: activeTurn, artifacts };
}
