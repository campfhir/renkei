import type { Selectable } from 'kysely';
import type { AgentActionBatches, AgentRunLog, AgentRunSteps } from '../../../db.types';
import type {
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
