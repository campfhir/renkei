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

/** A run as created, before anything has claimed it (status 'queued'). */
export interface AgentRunNewInput {
  id: string;
  agentId: string;
  ownerSubject: string;
  triggerId: string | null;
  triggerKind: string;
  triggeredBySubject: string | null;
  parentRunId: string | null;
  /** Ancestor agent ids; `depth` is its length. */
  lineage: string[];
  definitionSnapshot: unknown;
  llmModelId: string | null;
  initialState: Record<string, unknown> | null;
}

/** A run's durable log row (agent_run_log). */
export interface AgentRunLogRecord {
  runId: string;
  agentId: string;
  ownerSubject: string;
  triggerKind: string;
  status: string;
  createdAt: Date;
  finishedAt: Date | null;
  errorKind: string | null;
  outcomeCode: string | null;
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  attempts: number;
}

/** How a run ended, for its durable run-log row (agent_run_log). */
export interface AgentRunOutcomeInput {
  runId: string;
  agentId: string;
  ownerSubject: string;
  status: string;
  /** Already clipped by the caller; null unless the run failed. */
  errorKind: string | null;
  error: string | null;
  /** Keep only the newest failed attempt's outcome code (clipped to 64). */
  failed: boolean;
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
  /** How many runs were created after `since`. */
  countCreatedSince(since: Date): Promise<number>;
  /** Insert a run in status 'queued'. */
  createQueued(run: AgentRunNewInput): Promise<void>;
  /** Drop a run (a queued row whose message never landed); returns how many went. */
  deleteRun(runId: string): Promise<number>;
  /** The durable run log's row for a new run (agent_run_log). */
  logRunCreated(entry: {
    runId: string;
    agentId: string;
    ownerSubject: string;
    triggerKind: string;
    status: string;
  }): Promise<void>;
  /** The agent's newest run still queued or running (ties by id, descending). */
  findInProgress(agentId: string): Promise<{ id: string; status: string } | null>;
  /** The run as a resume needs it, when it is this agent's and this owner's. */
  findForResume(
    runId: string,
    agentId: string,
    ownerSubject: string
  ): Promise<{ status: string; error: string | null; errorKind: string | null } | null>;
  /**
   * Put a FAILED run back to 'queued': failure, timing, budget and cancel
   * flags cleared, the resume recorded (time, who, count + 1, guidance,
   * the failure it replaces). False when the run was not failed.
   */
  markResumed(
    runId: string,
    resume: { resumedBy: string; guidance: string | null; failure: string | null }
  ): Promise<boolean>;
  /** Undo a resume whose message never landed: a still-'queued' run back to failed. */
  restoreFailure(
    runId: string,
    failure: { error: string | null; errorKind: string | null }
  ): Promise<void>;
  /** One run's log row. */
  findRunLog(runId: string): Promise<AgentRunLogRecord | null>;
  /** The run log says the run is in flight again (queued, unfinished). */
  markLogQueued(runId: string): Promise<void>;
  /**
   * Finalize the run's log row: its outcome plus what its attempts
   * (agent_run_steps) cost — summed tokens and tool calls, the attempt
   * count, and for a failure the newest failed attempt's outcome code.
   * An upsert: the row is written even when creation's insert was missed.
   */
  recordOutcome(outcome: AgentRunOutcomeInput): Promise<void>;
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
