import type { Selectable } from 'kysely';
import type { ChatMessages, ChatSummaries, ChatTurns } from '../../../db.types';
import type { ChatMessageRecord, ChatSummaryRecord, ChatTurnRecord } from './types';

const date = (value: Date | string) => new Date(value);
const dateOrNull = (value: Date | string | null) => (value ? new Date(value) : null);

export function messageFromRow(row: Selectable<ChatMessages>): ChatMessageRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    turnId: row.turn_id,
    seq: row.seq,
    role: row.role,
    kind: row.kind,
    status: row.status,
    content: row.content,
    llmModelId: row.llm_model_id,
    provider: row.provider,
    model: row.model,
    stopReason: row.stop_reason,
    usage: row.usage ?? null,
    timing: row.timing ?? null,
    error: row.error,
    summaryId: row.summary_id,
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}

export function turnFromRow(row: Selectable<ChatTurns>): ChatTurnRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    status: row.status,
    kind: row.kind,
    llmModelId: row.llm_model_id,
    thinkingBudget: row.thinking_budget,
    iterations: row.iterations,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cancelRequestedAt: dateOrNull(row.cancel_requested_at),
    error: row.error,
    stage: row.stage,
    stageAt: dateOrNull(row.stage_at),
    toolPermission: row.tool_permission ?? null,
    suspendedAt: dateOrNull(row.suspended_at),
    resumeCount: row.resume_count,
    runner: row.runner ?? null,
    startedAt: date(row.started_at),
    updatedAt: date(row.updated_at),
    finishedAt: dateOrNull(row.finished_at),
  };
}

export function summaryFromRow(row: Selectable<ChatSummaries>): ChatSummaryRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    content: row.content,
    throughSeq: row.through_seq,
    foldedCount: row.folded_count,
    createdBy: row.created_by,
    createdAt: date(row.created_at),
  };
}
