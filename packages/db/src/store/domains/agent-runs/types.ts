import type { Json } from '../../../db.types';

/** Who is reading runs: the owner sees content; an operator sees it only on failed runs. */
export type RunAudience = 'owner' | 'admin';

/** A run's content-free columns — safe for every audience. */
export interface RunSummaryRecord {
  id: string;
  agentId: string;
  status: string;
  triggerKind: string;
  errorKind: string | null;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  resumeCount: number;
  resumedAt: Date | null;
}

/** One agent_run_steps row; `detail` as stored (its content half sealed). */
export interface RunStepRecord {
  stepId: string;
  stepIndex: number;
  attempt: number;
  iteration: number;
  status: string;
  outcome: string | null;
  outcomeCode: string | null;
  toolCallCount: number;
  detail: Json | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/** One staged action batch of a run. */
export interface RunBatchRecord {
  id: string;
  turn: number;
  status: string;
  reviewReason: string | null;
  acceptedBy: string | null;
  summary: string;
  actions: Json;
  results: Json;
  comment: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

/**
 * A run with its turns and batches. For the admin audience the trigger
 * input and resume guidance come back only on a failed run — they never
 * leave the database otherwise (null in their place).
 */
export interface RunDetailRecord extends RunSummaryRecord {
  ownerSubject: string;
  definitionSnapshot: Json | null;
  initialState: Json | null;
  resumeGuidance: string | null;
  activeMs: number;
  /** By step index, iteration, attempt (ties by step id). */
  steps: RunStepRecord[];
  /** By turn. */
  batches: RunBatchRecord[];
}

/** An undecided approval or question card, joined to its agent and run. */
export interface PendingCardRecord {
  cardId: string;
  runId: string | null;
  title: string;
  summary: string;
  suggestedAction: Json | null;
  createdAt: Date;
  agentId: string;
  agentName: string;
  waitingUntil: Date | null;
}

/** The fields a decision reads off a card. */
export interface CardRecord {
  id: string;
  kind: string;
  status: string;
  runId: string | null;
  summary: string;
  suggestedAction: Json | null;
}

export interface AgentRunStore {
  /**
   * One agent's retained runs, newest first (ties by id), at most `limit`.
   * `ownerSubject` narrows to the owner's runs (the owner's pages); null
   * reads every run of the agent (the operator's).
   *
   * `q` matches, case-insensitively and literally, the error text, the
   * trigger kind, or the trigger input's JSON text — for the admin
   * audience the input only on failed runs; `matchId` (a run id the
   * caller recognised in the search) matches exactly as well. Memory
   * prints the input the way jsonb does (./agents/json.ts); a number
   * written with a fraction like 1.0 prints differently, which no
   * scenario relies on.
   */
  list(options: {
    agentId: string;
    ownerSubject: string | null;
    audience: RunAudience;
    status?: string;
    q?: string;
    matchId?: string;
    limit: number;
  }): Promise<RunSummaryRecord[]>;
  /** One run with its turns and batches, or null (scoped like `list`). */
  findDetail(options: {
    agentId: string;
    runId: string;
    ownerSubject: string | null;
    audience: RunAudience;
  }): Promise<RunDetailRecord | null>;
  /** The newest undecided approval or question card on the run that is this owner's. */
  findPauseCard(
    runId: string,
    ownerSubject: string
  ): Promise<{
    id: string;
    kind: string;
    status: string;
    summary: string;
    suggestedAction: Json | null;
  } | null>;
  /** A run's status and owner, scoped to the agent (and owner, when given). */
  findStatus(options: {
    agentId: string;
    runId: string;
    ownerSubject?: string;
  }): Promise<{ id: string; status: string; ownerSubject: string } | null>;
  /**
   * What starting a run again from this one reads: its status, how it was
   * triggered, and its trigger input — scoped to the agent and owner.
   */
  findRestartSource(options: {
    agentId: string;
    runId: string;
    ownerSubject: string;
  }): Promise<RunRestartSourceRecord | null>;
  /**
   * The operator's override: a live run straight to canceled with the
   * given error, the cancel request recorded (kept when one was already
   * there), and its running attempt rows closed out as canceled, in one
   * transaction. False when the run was no longer live.
   */
  forceCancel(
    runId: string,
    input: { bySubject: string; errorKind: string; error: string }
  ): Promise<boolean>;
  /**
   * Flag a live run (queued, running, waiting) for cancellation, once:
   * false when it was already flagged or is no longer live.
   */
  requestCancel(runId: string, bySubject: string): Promise<boolean>;
  /**
   * Put the owner's runs parked for a sign-in (waiting, error kind
   * `errorKind`) back to queued, clearing the error; returns them by id.
   */
  requeueWaiting(
    ownerSubject: string,
    errorKind: string
  ): Promise<{ id: string; agentId: string }[]>;
  /**
   * The undecided, unarchived cards of `kind` raised by an agent for this
   * person, oldest first (ties by id), at most `limit`.
   */
  listPendingCards(
    subject: string,
    options: { kind: string; agentId?: string; limit: number }
  ): Promise<PendingCardRecord[]>;
  /** One of the person's cards, or null. */
  findCard(cardId: string, subject: string): Promise<CardRecord | null>;
  /**
   * Decide an undecided card: status, result and who decided, archived
   * at once. False when it was no longer undecided — someone else won.
   */
  claimCard(
    cardId: string,
    decision: { status: string; result: Json; decidedBy: string }
  ): Promise<boolean>;
  /** The run's agent, for waking it. */
  findRunAgent(runId: string): Promise<{ id: string; agentId: string } | null>;
  /**
   * What an optimization pass reads about one owner's agent over the last
   * `days`: its failed runs from the durable log (newest first, ties by
   * run id, at most `maxFailures`), run-level statistics over its settled
   * runs, and the tool-call profile of its retained turns (each turn's
   * `detail.toolCalls`, free calls left out; most calls first, ties by
   * tool, at most `maxTools`).
   */
  optimizationEvidence(options: {
    ownerSubject: string;
    agentId: string;
    days: number;
    maxFailures: number;
    maxTools: number;
  }): Promise<OptimizationEvidenceRecord>;
}

export interface RunRestartSourceRecord {
  id: string;
  status: string;
  triggerKind: string;
  triggerId: string | null;
  /** The trigger.* variables the run started with, as stored. */
  initialState: Json | null;
}

export interface OptimizationEvidenceRecord {
  failures: {
    createdAt: Date;
    triggerKind: string;
    errorKind: string | null;
    outcomeCode: string | null;
    error: string | null;
    inputTokens: number;
    outputTokens: number;
    toolCalls: number;
  }[];
  /** Over succeeded, failed and stopped runs; averages and the max are null without any. */
  stats: {
    runs: number;
    succeeded: number;
    failed: number;
    avgTokens: number | null;
    maxTokens: number | null;
    avgTurns: number | null;
    avgCalls: number | null;
  };
  tools: { tool: string; calls: number; failed: number }[];
}
