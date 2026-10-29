/**
 * What hangs off one chat and makes up its thread on screen: messages,
 * turns, the newest compaction summary, widget decisions, the composer's
 * saved draft and queue. Content comes back as stored — sealed under the
 * chat's key (apps/web/lib/chat/content-crypto.ts opens it) — and JSON
 * columns unparsed beyond what pg does.
 */

import type { ChatTurnEngineStore } from './engine-types';

export type * from './engine-types';

export interface ChatMessageRecord {
  id: string;
  chatId: string;
  turnId: string | null;
  seq: number;
  role: string;
  kind: string;
  status: string;
  /** Sealed blocks, as stored. */
  content: string;
  llmModelId: string | null;
  provider: string | null;
  model: string | null;
  stopReason: string | null;
  usage: unknown;
  timing: unknown;
  error: string | null;
  summaryId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatTurnRecord {
  id: string;
  chatId: string;
  status: string;
  kind: string;
  llmModelId: string | null;
  thinkingBudget: number | null;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  cancelRequestedAt: Date | null;
  error: string | null;
  stage: string | null;
  stageAt: Date | null;
  toolPermission: unknown;
  suspendedAt: Date | null;
  resumeCount: number;
  runner: unknown;
  startedAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

export interface ChatSummaryRecord {
  id: string;
  chatId: string;
  /** Sealed, as stored. */
  content: string;
  throughSeq: number;
  foldedCount: number;
  createdBy: string;
  createdAt: Date;
}

/** One card's recorded decision (chat_widget_decisions). */
export interface ChatWidgetDecisionRecord {
  stateKey: string;
  /** The card's receipt, as stored (the caller validates it). */
  state: unknown;
  decision: string;
  decidedBy: string;
}

export interface ChatThreadStore extends ChatTurnEngineStore {
  /** A chat's messages in order (seq ascending). */
  listMessages(chatId: string): Promise<ChatMessageRecord[]>;
  /** One turn's messages in order (seq ascending, ties by id). */
  listTurnMessages(turnId: string): Promise<ChatMessageRecord[]>;
  /** The chat's running turn, if any (at most one runs per chat). */
  getActiveTurn(chatId: string): Promise<ChatTurnRecord | null>;
  /** One turn of one chat; null when the turn is not that chat's. */
  getTurn(chatId: string, turnId: string): Promise<ChatTurnRecord | null>;
  /** The chat's newest compaction summary (ties by id), or null. */
  latestSummary(chatId: string): Promise<ChatSummaryRecord | null>;
  /**
   * Every widget decision recorded in the chat, by state key ascending:
   * the card's state, which way it went and who decided it.
   */
  listWidgetDecisions(chatId: string): Promise<ChatWidgetDecisionRecord[]>;
  /** One decision's state by its key, or null. */
  getWidgetDecision(stateKey: string): Promise<unknown>;
  /** The composer's saved draft, sealed, or null when there is none. */
  getDraft(chatId: string): Promise<string | null>;
  /** Insert or replace the draft (sealed). */
  saveDraft(chatId: string, sealed: string): Promise<void>;
  deleteDraft(chatId: string): Promise<void>;
  /** The composer's queue as stored (JSON), or null when there is none. */
  getQueue(chatId: string): Promise<unknown>;
  /** Insert or replace the queue (JSON-serializable). */
  saveQueue(chatId: string, queue: unknown): Promise<void>;
  deleteQueue(chatId: string): Promise<void>;
  /**
   * The janitor: every `running` turn (anyone's) last updated before
   * `staleBefore` is marked interrupted with `error`, finished now, and its
   * still-streaming messages interrupted with it. Returns those turns by
   * id, with their chat, stage and `staleSince` (the update time they had
   * before this wrote over it).
   */
  interruptStaleTurns(staleBefore: Date, error: string): Promise<ChatStaleTurnRecord[]>;
}

/** A turn the janitor interrupted, as it was just before. */
export interface ChatStaleTurnRecord {
  id: string;
  chatId: string;
  stage: string | null;
  staleSince: Date;
}
