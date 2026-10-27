import type { Selectable } from 'kysely';
import type { AgentActionBatches, AgentRunLog, AgentRunSteps, AgentRuns } from '../../../db.types';
import type {
  AgentRunBatchStateRecord,
  AgentRunExecutionPatch,
  AgentRunExecutionRecord,
  AgentRunTurnCardInput,
  AgentRunTurnRecord,
  AgentRunTurnWrite,
  AgentRunLogRecord,
  AgentRunNewInput,
  RunBatchRecord,
  RunStepRecord,
  RunSummaryRecord,
} from './types';

/** The statuses a run is still live in — what a cancel can still reach. */
export const LIVE_STATUSES = ['queued', 'running', 'waiting'] as const;

/** A person's search text as a literal ILIKE pattern — wildcards escaped. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export function summaryFromRow(row: {
  id: string;
  agent_id: string;
  status: string;
  trigger_kind: string;
  error_kind: string | null;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  resume_count: number;
  resumed_at: Date | null;
}): RunSummaryRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    status: row.status,
    triggerKind: row.trigger_kind,
    errorKind: row.error_kind,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    resumeCount: row.resume_count,
    resumedAt: row.resumed_at,
  };
}

export function stepFromRow(row: Selectable<AgentRunSteps>): RunStepRecord {
  return {
    stepId: row.step_id,
    stepIndex: row.step_index,
    attempt: row.attempt,
    iteration: row.iteration,
    status: row.status,
    outcome: row.outcome,
    outcomeCode: row.outcome_code,
    toolCallCount: row.tool_call_count,
    detail: row.detail,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function batchFromRow(row: Selectable<AgentActionBatches>): RunBatchRecord {
  return {
    id: row.id,
    turn: row.turn,
    status: row.status,
    reviewReason: row.review_reason,
    acceptedBy: row.accepted_by,
    summary: row.summary,
    actions: row.actions,
    results: row.results,
    comment: row.comment,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

/** The agent_runs row a new run starts as. */
export function newRunValues(run: AgentRunNewInput) {
  return {
    id: run.id,
    agent_id: run.agentId,
    owner_subject: run.ownerSubject,
    trigger_id: run.triggerId,
    trigger_kind: run.triggerKind,
    triggered_by_subject: run.triggeredBySubject,
    parent_run_id: run.parentRunId,
    lineage: JSON.stringify(run.lineage),
    depth: run.lineage.length,
    definition_snapshot: JSON.stringify(run.definitionSnapshot),
    llm_model_id: run.llmModelId,
    initial_state: run.initialState ? JSON.stringify(run.initialState) : null,
    status: 'queued',
  };
}

export function runLogFromRow(row: Selectable<AgentRunLog>): AgentRunLogRecord {
  return {
    runId: row.run_id,
    agentId: row.agent_id,
    ownerSubject: row.owner_subject,
    triggerKind: row.trigger_kind,
    status: row.status,
    createdAt: new Date(row.created_at),
    finishedAt: row.finished_at ? new Date(row.finished_at) : null,
    errorKind: row.error_kind,
    outcomeCode: row.outcome_code,
    error: row.error,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    toolCalls: row.tool_calls,
    attempts: row.attempts,
  };
}

export function executionFromRow(
  row: Pick<
    Selectable<AgentRuns>,
    | 'id'
    | 'agent_id'
    | 'owner_subject'
    | 'definition_snapshot'
    | 'llm_model_id'
    | 'initial_state'
    | 'status'
    | 'started_at'
    | 'waiting_until'
    | 'cancel_requested_at'
    | 'resumed_at'
    | 'resume_guidance'
    | 'resume_failure'
    | 'error_kind'
    | 'trigger_kind'
    | 'parent_run_id'
    | 'active_ms'
  >
): AgentRunExecutionRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    ownerSubject: row.owner_subject,
    definitionSnapshot: row.definition_snapshot,
    llmModelId: row.llm_model_id,
    initialState: row.initial_state,
    status: row.status,
    startedAt: row.started_at,
    waitingUntil: row.waiting_until,
    cancelRequestedAt: row.cancel_requested_at,
    resumedAt: row.resumed_at,
    resumeGuidance: row.resume_guidance,
    resumeFailure: row.resume_failure,
    errorKind: row.error_kind,
    triggerKind: row.trigger_kind,
    parentRunId: row.parent_run_id,
    activeMs: Number(row.active_ms ?? 0),
  };
}

/** The agent_runs columns an execution patch writes: only the fields it names. */
export function executionColumns(patch: AgentRunExecutionPatch) {
  return {
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.startedAt !== undefined ? { started_at: patch.startedAt } : {}),
    ...(patch.waitingUntil !== undefined ? { waiting_until: patch.waitingUntil } : {}),
    ...(patch.llmModelId !== undefined ? { llm_model_id: patch.llmModelId } : {}),
    ...(patch.errorKind !== undefined ? { error_kind: patch.errorKind } : {}),
    ...(patch.error !== undefined ? { error: patch.error } : {}),
    ...(patch.activeMs !== undefined ? { active_ms: String(patch.activeMs) } : {}),
  };
}

export function turnFromRow(
  row: Pick<
    Selectable<AgentRunSteps>,
    'id' | 'attempt' | 'status' | 'created_at' | 'tool_call_count' | 'detail'
  >
): AgentRunTurnRecord {
  return {
    id: row.id,
    attempt: row.attempt,
    status: row.status,
    createdAt: new Date(row.created_at),
    toolCallCount: row.tool_call_count,
    detail: row.detail,
  };
}

/** The agent_run_steps columns a turn rewrite sets (finished_at is the caller's: now). */
export function turnWriteColumns(write: AgentRunTurnWrite) {
  return {
    status: write.status,
    tool_call_count: write.toolCallCount,
    input_tokens: write.inputTokens,
    output_tokens: write.outputTokens,
    cache_read_input_tokens: write.cacheReadInputTokens,
    cache_write_input_tokens: write.cacheWriteInputTokens,
    outcome: write.outcome,
    detail: write.detail,
  };
}

export function batchStateFromRow(
  row: Pick<
    Selectable<AgentActionBatches>,
    | 'id'
    | 'run_id'
    | 'agent_id'
    | 'owner_subject'
    | 'status'
    | 'actions'
    | 'results'
    | 'accepted_by'
    | 'comment'
    | 'waiting_until'
    | 'updated_at'
  > & { run_status: string; cancel_requested_at: Date | null; agent_name: string }
): AgentRunBatchStateRecord {
  return {
    id: row.id,
    runId: row.run_id,
    agentId: row.agent_id,
    ownerSubject: row.owner_subject,
    status: row.status,
    actions: row.actions,
    results: row.results,
    acceptedBy: row.accepted_by,
    comment: row.comment,
    waitingUntil: row.waiting_until,
    updatedAt: new Date(row.updated_at),
    runStatus: row.run_status,
    runCancelRequestedAt: row.cancel_requested_at,
    agentName: row.agent_name,
  };
}

/** The partial unique index that admits one card per run turn. */
export const TURN_CARD_INDEX = 'idx_actionable_items_run_step';

/** The actionable_items row a run's turn card is. */
export function turnCardValues(card: AgentRunTurnCardInput) {
  return {
    id: card.id,
    source: 'agents',
    status: 'suggested',
    kind: card.kind,
    title: card.title,
    summary: card.summary,
    evidence: JSON.stringify([]),
    suggested_action: JSON.stringify(card.suggestedAction),
    owner_subject: card.ownerSubject,
    created_by: card.ownerSubject,
    created_by_agent_id: card.agentId,
    run_id: card.runId,
    step_id: card.stepId,
    iteration: 0,
    attempt: card.attempt,
  };
}
