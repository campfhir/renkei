/**
 * The turn engine's writes on a chat's thread (apps/web/lib/chat/turns.ts,
 * messages.ts, start-turn.ts, compaction.ts, turn-recovery.ts,
 * subagent-runs.ts, resend.ts, widget-tools.ts): turns opened, heartbeat,
 * parked behind a permission ask, finished or claimed back after a lost
 * process; messages appended and flushed; summaries; sub-agent runs.
 * Content goes in sealed and comes back as stored.
 */

import type { ChatMessageRecord, ChatTurnRecord } from './types';

/** A new turn row: running, with what a resume needs (`runner`, JSON-serializable or null). */
export interface ChatTurnInsert {
  chatId: string;
  kind: string;
  llmModelId: string | null;
  thinkingBudget: number | null;
  runner: unknown;
}

/** A new message row, appended at the chat's next seq; `content` already sealed. */
export interface ChatMessageInsert {
  chatId: string;
  turnId: string | null;
  role: string;
  kind: string;
  status: string;
  content: string;
  llmModelId?: string | null;
  provider?: string | null;
  model?: string | null;
}

export interface InsertedChatMessage {
  id: string;
  seq: number;
  createdAt: Date;
}

/** What a flush changes on a message; absent fields stay. `usage`/`timing`: JSON objects or null. */
export interface ChatMessagePatch {
  content?: string;
  status?: string;
  stopReason?: string | null;
  usage?: unknown;
  timing?: unknown;
  error?: string | null;
}

/** How a running turn ended. */
export interface ChatTurnOutcome {
  status: string;
  error: string | null;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
}

/** A sub-agent run as it starts (chat_subagent_runs); task and instructions sealed. */
export interface ChatSubagentRunStart {
  chatId: string;
  turnId: string;
  toolUseId: string;
  task: string;
  instructions: string | null;
  readOnly: boolean;
  maxSteps: number;
  llmModelId: string | null;
  provider: string | null;
  model: string | null;
}

export interface ChatSubagentRunRecord {
  id: string;
  chatId: string;
  turnId: string;
  toolUseId: string;
  status: string;
  /** Sealed, as stored. */
  task: string;
  instructions: string | null;
  readOnly: boolean;
  llmModelId: string | null;
  provider: string | null;
  model: string | null;
  /** The model config's label as it reads now; null once the config is gone. */
  modelLabel: string | null;
  steps: number;
  maxSteps: number;
  toolCalls: number;
  lastTool: string | null;
  /** Sealed, as stored. */
  transcript: string | null;
  report: string | null;
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  startedAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

export interface ChatTurnEngineStore {
  /** A new running turn's id; rejects with 23505 while the chat has a running turn already. */
  createTurn(turn: ChatTurnInsert): Promise<string>;
  /**
   * Send's write, all or nothing: the turn, its messages in order (each at
   * the chat's next seq), and — with `link` — the owner's listed artifacts
   * of the chat pointed at the message at `messageIndex`. Rejects with
   * 23505 while another turn runs.
   */
  openTurn(input: {
    turn: ChatTurnInsert;
    messages: Omit<ChatMessageInsert, 'chatId' | 'turnId'>[];
    link?: { messageIndex: number; ownerSubject: string; artifactIds: string[] };
  }): Promise<{ turnId: string; messages: InsertedChatMessage[] }>;
  /** Append one message at the chat's next seq. */
  insertMessage(message: ChatMessageInsert): Promise<InsertedChatMessage>;
  /**
   * Append one message only while no turn of the chat is running (the chat
   * row locked for the check and the insert); null when one is.
   */
  insertMessageWhenIdle(message: ChatMessageInsert): Promise<InsertedChatMessage | null>;
  /** One message of one chat, or null. */
  getMessage(chatId: string, messageId: string): Promise<ChatMessageRecord | null>;
  /** Change one message, bumping `updatedAt`. */
  updateMessage(messageId: string, patch: ChatMessagePatch): Promise<void>;
  deleteMessage(messageId: string): Promise<void>;
  /** Every still-streaming message of a turn gets `status`. */
  settleStreamingMessages(turnId: string, status: string): Promise<void>;
  /**
   * Resend's cut: every message of the chat at or after `fromSeq`, the
   * model's artifacts on them, and the turns they belonged to, deleted in
   * one transaction. The artifacts removed, by id.
   */
  truncateFrom(chatId: string, fromSeq: number): Promise<{ id: string; blobKey: string }[]>;
  /**
   * The running turn's liveness: `updatedAt` now, `iterations` and
   * `stage` set, `stageAt` now only when the stage changed. Whether a
   * cancel was requested (false for a turn not running).
   */
  heartbeatTurn(turnId: string, iterations: number, stage: string | null): Promise<boolean>;
  /** End a running turn (its pending ask cleared, finished now); a settled turn is left alone. */
  finishTurn(turnId: string, outcome: ChatTurnOutcome): Promise<void>;
  /** A running turn left by its runner: suspended now, no stage. */
  suspendTurn(turnId: string, iterations: number): Promise<void>;
  /**
   * Claim running reply turns nobody runs — suspended, or a heartbeat older
   * than `staleSeconds` — resumed fewer than `maxResumes` times, oldest
   * heartbeat first, at most `limit`: each unsuspended, its resume count
   * bumped, its ask and stage cleared. The claimed turns, by start (ties by id).
   */
  claimResumableTurns(options: {
    staleSeconds: number;
    maxResumes: number;
    limit: number;
  }): Promise<ChatTurnRecord[]>;
  /**
   * End as interrupted (with `error`) the orphaned reply turns resumed
   * `maxResumes` times already, and their streaming messages. Their ids, ascending.
   */
  interruptExhaustedTurns(options: {
    staleSeconds: number;
    maxResumes: number;
    error: string;
  }): Promise<string[]>;
  /** Mark a cancel on the chat's running turn; whether it was running. */
  requestTurnCancel(chatId: string, turnId: string): Promise<boolean>;
  /** Park a running turn behind this ask (JSON-serializable), bumping `updatedAt`. */
  setToolPermission(turnId: string, ask: unknown): Promise<void>;
  /**
   * Merge the answer into the running turn's ask for `toolUseId`, only
   * while that ask is unanswered; whether it was written.
   */
  decideToolPermission(
    chatId: string,
    turnId: string,
    toolUseId: string,
    answer: { decision: string; decidedAt: string }
  ): Promise<boolean>;
  /** The turn's ask as stored (parsed JSON), or null. */
  getToolPermission(turnId: string): Promise<unknown>;
  clearToolPermission(turnId: string): Promise<void>;
  /** A compaction pass's summary (sealed), and the messages it folded attributed to it; its id. */
  insertSummary(summary: {
    chatId: string;
    content: string;
    throughSeq: number;
    foldedCount: number;
    createdBy: string;
    messageIds: string[];
  }): Promise<string>;
  /** Record a card's decision; the first for a key wins, later ones change nothing. */
  recordWidgetDecision(decision: {
    chatId: string;
    stateKey: string;
    decision: string;
    state: unknown;
    decidedBy: string;
  }): Promise<void>;
  /**
   * Messages of these chats of these kinds, for a scan: newest chat first
   * (by `updatedAt`, ties by chat id), newest message first within one
   * (seq descending), a page at a time.
   */
  searchMessages(
    chatIds: string[],
    options: { kinds: string[]; limit: number; offset: number }
  ): Promise<{ id: string; chatId: string; content: string }[]>;
  /** A sub-agent run for this call, starting over the row a retry of the same call had; its id. */
  startSubagentRun(run: ChatSubagentRunStart): Promise<string>;
  /** A running run's counters; tokens are added to what it spent so far. */
  progressSubagentRun(
    runId: string,
    state: {
      steps: number;
      toolCalls: number;
      lastTool: string | null;
      inputTokens: number;
      outputTokens: number;
    }
  ): Promise<void>;
  /** The run's end; transcript and report sealed. */
  finishSubagentRun(
    runId: string,
    outcome: {
      status: string;
      steps: number;
      toolCalls: number;
      transcript: string | null;
      report: string | null;
      error: string | null;
    }
  ): Promise<void>;
  /** Every run of the turn still running ends interrupted with `error`. */
  interruptSubagentRuns(turnId: string, error: string): Promise<void>;
  /** One run by the chat and the tool_use id that started it, or null. */
  getSubagentRunByCall(chatId: string, toolUseId: string): Promise<ChatSubagentRunRecord | null>;
}
