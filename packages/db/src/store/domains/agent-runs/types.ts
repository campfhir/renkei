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
  /** The run's agent and what started it (`trigger_kind`), whoever owns it, or null. */
  findRunOrigin(runId: string): Promise<{ agentId: string; triggerKind: string } | null>;
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

  // The executor's own reads and writes (worker-agents: engine, actions).
  // Every write stamps `updated_at`; "now" is the database's clock.

  /** The run as its executor reads it on each delivery, or null. */
  findForExecution(runId: string): Promise<AgentRunExecutionRecord | null>;
  /** Change a run's execution state: only the fields given are written. */
  updateExecution(runId: string, patch: AgentRunExecutionPatch): Promise<void>;
  /** Whether the run is still wanted: its status and cancel request, or null. */
  findCancelState(
    runId: string
  ): Promise<{ status: string; cancelRequestedAt: Date | null } | null>;
  /** How the run was started and by which parent (its lineage as stored), or null. */
  findChainLink(
    runId: string
  ): Promise<{ triggerKind: string; parentRunId: string | null; lineage: Json } | null>;
  /** The run's rows of `stepId`, by attempt (ties by id). */
  listTurns(runId: string, stepId: string): Promise<AgentRunTurnRecord[]>;
  /**
   * Open a turn row: running, started now, iteration 0, step index =
   * attempt. A second row for the same (run, step, iteration, attempt) is
   * refused (23505) — the tripwire against two executors of one run.
   */
  openTurn(turn: AgentRunTurnInput): Promise<void>;
  /** Rewrite a turn row's status, billing and detail; `finished` stamps finished_at. */
  writeTurn(turnId: string, write: AgentRunTurnWrite): Promise<void>;
  /** The run's running and waiting rows to `status`, finished now. */
  closeOpenTurns(runId: string, status: string): Promise<void>;
  /**
   * End the run: status, error, no deadline, finished now — and every
   * row still running or waiting canceled, in one transaction.
   */
  finishExecution(
    runId: string,
    outcome: { status: string; errorKind: string | null; error: string | null }
  ): Promise<void>;
  /**
   * Cancel a run that waits (or was never started), in one transaction:
   * the run canceled and finished, its undecided cards expired with
   * `{ reason }` as their result, its proposed batches expired, its
   * running and waiting rows canceled.
   */
  cancelWaiting(runId: string, reason: string): Promise<void>;
  /** Insert a staged batch; a second batch for the same (run, turn) is refused (23505). */
  stageBatch(batch: AgentRunNewBatchInput): Promise<void>;
  /** A batch with its run's status and cancel request and its agent's name, or null. */
  findBatchState(batchId: string): Promise<AgentRunBatchStateRecord | null>;
  /**
   * Record the decision on a proposed batch (decided now). False when it
   * was no longer proposed — someone else moved it first.
   */
  settleProposedBatch(
    batchId: string,
    decision: {
      status: string;
      acceptedBy: string | null;
      decidedBy: string | null;
      comment: string | null;
    }
  ): Promise<boolean>;
  /** An accepted or executing batch to expired with `comment`, finished now. */
  expireLiveBatch(batchId: string, comment: string): Promise<void>;
  /** Claim an accepted batch for execution (started now). False when it was not accepted. */
  claimBatch(batchId: string): Promise<boolean>;
  /**
   * Mark progress on an executing batch: the results so far, when given
   * (stored as JSON) — otherwise only the touch, which says a call began.
   */
  saveBatchProgress(batchId: string, results?: unknown): Promise<void>;
  /** The batch completed with these results (stored as JSON), finished now. */
  completeBatch(batchId: string, results: unknown): Promise<void>;
  /**
   * Raise a run's approval or question card for one turn. False when the
   * (run, step, iteration 0, attempt) already has one — a racing executor
   * raised it.
   */
  raiseTurnCard(card: AgentRunTurnCardInput): Promise<boolean>;
  /** The card raised for a run's turn (iteration 0), or null; ties by id. */
  findTurnCard(
    runId: string,
    stepId: string,
    attempt: number
  ): Promise<{
    id: string;
    status: string;
    result: Json | null;
    decidedBy: string | null;
  } | null>;
  /**
   * Expire an undecided card (decided and archived now, `result` stored as
   * JSON). False when it was decided meanwhile.
   */
  expireCard(cardId: string, result: unknown): Promise<boolean>;
}

/** A run as its executor reads it (worker-agents engine). */
export interface AgentRunExecutionRecord {
  id: string;
  agentId: string;
  ownerSubject: string;
  definitionSnapshot: Json | null;
  llmModelId: string | null;
  initialState: Json | null;
  status: string;
  startedAt: Date | null;
  waitingUntil: Date | null;
  cancelRequestedAt: Date | null;
  resumedAt: Date | null;
  resumeGuidance: string | null;
  resumeFailure: string | null;
  errorKind: string | null;
  triggerKind: string;
  parentRunId: string | null;
  activeMs: number;
}

/** What the executor changes on a run; a field left out is left as it is. */
export interface AgentRunExecutionPatch {
  status?: string;
  startedAt?: Date;
  waitingUntil?: Date | null;
  llmModelId?: string | null;
  errorKind?: string | null;
  error?: string | null;
  activeMs?: number;
}

/** One turn row, as the executor rebuilds a conversation from. `detail` as stored. */
export interface AgentRunTurnRecord {
  id: string;
  attempt: number;
  status: string;
  createdAt: Date;
  toolCallCount: number;
  detail: Json | null;
}

/** A turn row to open; `detail` is JSON text (its content half already sealed). */
export interface AgentRunTurnInput {
  id: string;
  runId: string;
  stepId: string;
  attempt: number;
  detail: string;
}

/** A turn row's rewrite; `detail` is JSON text. */
export interface AgentRunTurnWrite {
  status: string;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outcome: string | null;
  detail: string;
  /** Stamp finished_at now (a row that is neither running nor waiting). */
  finished: boolean;
}

/** A staged batch to insert; `actions` is stored as JSON. */
export interface AgentRunNewBatchInput {
  id: string;
  runId: string;
  agentId: string;
  ownerSubject: string;
  turn: number;
  status: string;
  summary: string;
  actions: unknown;
  reviewReason: string | null;
  acceptedBy: string | null;
  /** Stamp decided_at now (an auto-accepted batch). */
  decided: boolean;
  waitingUntil: Date | null;
}

/** A batch with the state of its run and the name of its agent. */
export interface AgentRunBatchStateRecord {
  id: string;
  runId: string;
  agentId: string;
  ownerSubject: string;
  status: string;
  actions: Json;
  results: Json;
  acceptedBy: string | null;
  comment: string | null;
  waitingUntil: Date | null;
  updatedAt: Date;
  runStatus: string;
  runCancelRequestedAt: Date | null;
  agentName: string;
}

/** A run's card for one turn (source 'agents', suggested, no evidence). */
export interface AgentRunTurnCardInput {
  id: string;
  kind: string;
  title: string;
  summary: string;
  /** Stored as JSON. */
  suggestedAction: unknown;
  ownerSubject: string;
  agentId: string;
  runId: string;
  stepId: string;
  attempt: number;
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
