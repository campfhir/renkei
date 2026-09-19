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
  PendingToolPermission,
  ToolPermissionDecision,
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
  /**
   * The runner will not run this call until the owner says so: the turn
   * is parked, the thread shows the ask inline, and a notification goes
   * out for a person who is not looking (turn-runner.ts, permission-notification.ts).
   */
  | { type: 'tool_permission_request'; turnId: string; permission: PendingToolPermission }
  /**
   * The ask was answered — by the owner, or by the clock ('timeout') —
   * and the runner moved on: ran the call, or fed the model a refusal.
   */
  | {
      type: 'tool_permission_decided';
      turnId: string;
      toolUseId: string;
      decision: ToolPermissionDecision | 'timeout';
    }
  /** A tool handed back a file; it is stored and listed under Artifacts. */
  | { type: 'artifact'; messageId: string; attachment: AttachmentView }
  /**
   * A compaction pass reporting how far it has folded (compaction.ts) —
   * from a compaction turn (turn.kind === 'compaction') or from the
   * chat_compact tool running inside an ordinary reply turn alike, so
   * either way the thread can show it live.
   */
  | {
      type: 'compaction_progress';
      turnId: string;
      foldedSoFar: number;
      totalToFold: number;
      /**
       * The pass's own end, when it runs inside a reply turn (start-turn.ts):
       * 'done' once the summary is written, 'failed' when it threw. Without
       * it the card could only read the pass's fate off the turn's — and a
       * reply that fails AFTER a successful fold would say the fold failed.
       */
      status?: 'done' | 'failed';
    }
  /**
   * A sub-agent (code_delegate) reporting how far it is — raised at its
   * start, after every model call, and at its end — keyed by the
   * delegating call's tool_use id, which is the card in the thread.
   */
  | { type: 'subagent_progress'; turnId: string; subagent: SubagentProgress }
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

/** A sub-agent's live state, as the thread shows it on its card. */
export interface SubagentProgress {
  toolUseId: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  steps: number;
  maxSteps: number;
  toolCalls: number;
  /** The tool it last reached for, while running. */
  lastTool: string | null;
}

export interface CompactionProgress {
  turnId: string;
  /** 'running' while folding; 'done'/'failed' once its turn_end arrives — left in state as a marker, not cleared. */
  status: 'running' | 'done' | 'failed';
  foldedSoFar: number;
  totalToFold: number;
}

export interface ThreadState {
  messages: ChatMessageView[];
  /** Tool calls currently executing, by tool_use id. */
  pendingToolCalls: string[];
  turn: TurnView | null;
  /** Files tools produced in this chat, oldest first. */
  artifacts: AttachmentView[];
  /** A compaction pass in progress right now, live or reconnected mid-way. */
  compaction: CompactionProgress | null;
  /** The tool call the running turn is waiting on the owner for, if any. */
  pendingPermission: PendingToolPermission | null;
  /** Sub-agents this page has watched, by the delegating call's id; kept after they end. */
  subagents: Record<string, SubagentProgress>;
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
      // A tool_use block's `input` only ever becomes real at its own
      // block_stop (the server sends the parsed args there, replacing the
      // whole block — see turn-runner.ts). A block that still carries
      // `partialJson` here never got one: the turn ended (error, timeout,
      // cancel) mid-argument-stream, and `input` is still the `{}`
      // placeholder block_start opened with. Leaving `partialJson` in
      // place keeps the raw partial args on screen — the true, if
      // incomplete, record of what streamed — instead of a synthesized
      // `input` that looks like the model called the tool with nothing.
      return {
        ...state,
        messages: replaceMessage(state.messages, event.messageId, (message) => ({
          ...message,
          status: event.status,
          stopReason: event.stopReason,
          usage: event.usage,
          error: event.error,
        })),
      };
    case 'tool_call_start':
      return state.pendingToolCalls.includes(event.toolUseId)
        ? state
        : { ...state, pendingToolCalls: [...state.pendingToolCalls, event.toolUseId] };
    case 'artifact':
      return { ...state, artifacts: withArtifacts(state.artifacts, [event.attachment]) };
    case 'tool_permission_request':
      return { ...state, pendingPermission: event.permission };
    case 'tool_permission_decided':
      return state.pendingPermission?.toolUseId === event.toolUseId
        ? { ...state, pendingPermission: null }
        : state;
    case 'subagent_progress':
      return {
        ...state,
        subagents: { ...state.subagents, [event.subagent.toolUseId]: event.subagent },
      };
    case 'compaction_progress':
      return {
        ...state,
        compaction: {
          turnId: event.turnId,
          status: event.status ?? 'running',
          foldedSoFar: event.foldedSoFar,
          totalToFold: event.totalToFold,
        },
      };
    case 'snapshot': {
      const turnId = event.turn.id;
      const others = state.messages.filter((message) => message.turnId !== turnId);
      const known = state.compaction?.turnId === turnId ? state.compaction : null;
      return {
        messages: [...others, ...event.messages].sort((a, b) => a.seq - b.seq),
        pendingToolCalls: [],
        turn: event.turn,
        artifacts: withArtifacts(state.artifacts, event.artifacts ?? []),
        // The snapshot is the database's word on whether an ask is still
        // open: a row with none means the answer landed (or the turn moved
        // on), whatever a stale live event said.
        pendingPermission:
          event.turn.status === 'running' ? (event.turn.pendingPermission ?? null) : null,
        subagents: state.subagents,
        compaction:
          event.turn.kind === 'compaction'
            ? {
                turnId,
                status:
                  event.turn.status === 'running'
                    ? 'running'
                    : event.turn.status === 'completed'
                      ? 'done'
                      : 'failed',
                foldedSoFar: known?.foldedSoFar ?? 0,
                totalToFold: known?.totalToFold ?? 0,
              }
            : known,
      };
    }
    case 'truncate': {
      const removed = new Set(event.removedArtifactIds);
      return {
        messages: state.messages.filter((message) => message.seq < event.fromSeq),
        pendingToolCalls: [],
        turn: null,
        artifacts: state.artifacts.filter((artifact) => !removed.has(artifact.id)),
        compaction: null,
        pendingPermission: null,
        subagents: {},
      };
    }
    case 'turn_end':
      return {
        ...state,
        pendingToolCalls: [],
        pendingPermission: null,
        // A pass that already said how it ended keeps its word; one still
        // running when the turn ends takes the turn's outcome.
        compaction:
          state.compaction &&
          state.compaction.turnId === event.turnId &&
          state.compaction.status === 'running'
            ? { ...state.compaction, status: event.status === 'completed' ? 'done' : 'failed' }
            : state.compaction,
        turn: state.turn
          ? { ...state.turn, status: event.status, error: event.error }
          : {
              id: event.turnId,
              status: event.status,
              kind: 'reply',
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
  return {
    messages,
    pendingToolCalls: [],
    turn: activeTurn,
    artifacts,
    compaction: null,
    pendingPermission:
      activeTurn?.status === 'running' ? (activeTurn.pendingPermission ?? null) : null,
    subagents: {},
  };
}
