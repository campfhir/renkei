import type { Selectable } from 'kysely';
import type { AgentDrafts } from '../../../db.types';
import type { AgentDraftRecord, DraftOutcome } from './types';

export function draftFromRow(row: Selectable<AgentDrafts>): AgentDraftRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    ownerSubject: row.owner_subject,
    status: row.status,
    request: row.request,
    result: row.result,
    error: row.error,
    errorDetail: row.error_detail,
    attempts: row.attempts,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    consumedAt: row.consumed_at,
  };
}

export function outcomeColumns(outcome: DraftOutcome, now: Date) {
  return outcome.status === 'succeeded'
    ? {
        status: 'succeeded',
        result: JSON.stringify(outcome.result),
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
