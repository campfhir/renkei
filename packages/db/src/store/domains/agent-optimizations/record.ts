import type { Selectable } from 'kysely';
import type { AgentOptimizations, Json } from '../../../db.types';
import type { AgentOptimizationRecord, OptimizationOutcome } from './types';

export function optimizationFromRow(row: Selectable<AgentOptimizations>): AgentOptimizationRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    ownerSubject: row.owner_subject,
    status: row.status,
    request: row.request,
    result: row.result,
    error: row.error,
    errorDetail: row.error_detail,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    attempts: row.attempts,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    appliedAt: row.applied_at,
  };
}

export function outcomeColumns(outcome: OptimizationOutcome, now: Date) {
  return outcome.status === 'succeeded'
    ? {
        status: 'succeeded',
        result: JSON.stringify(outcome.result),
        input_tokens: outcome.inputTokens,
        output_tokens: outcome.outputTokens,
        error: null,
        error_detail: null,
        finished_at: now,
        updated_at: now,
      }
    : {
        status: 'failed',
        error: outcome.error,
        error_detail: outcome.detail,
        finished_at: now,
        updated_at: now,
      };
}

/** `COALESCE(value, '{}'::jsonb) || addition` for an object addition, as jsonb concatenates. */
export function jsonbConcat(value: Json | null, addition: { [key: string]: Json }): Json {
  if (value === null) return { ...addition };
  if (Array.isArray(value)) return [...value, addition];
  if (typeof value === 'object') return { ...value, ...addition };
  return [value, addition];
}
