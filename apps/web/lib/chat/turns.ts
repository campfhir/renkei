/**
 * chat_turns: one row per Send, and the liveness of the work.
 *
 * `createTurn` relies on the partial unique index (one running turn per
 * chat): the insert either succeeds or the database says another turn is
 * running, and nothing in between can race. `heartbeat` is what keeps a
 * turn alive for the janitor and what carries a cancel request across
 * replicas.
 */

import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '@renkei/db';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { isUuid } from '@/lib/uuid';
import type { TurnStatus, TurnView } from './views';

export interface TurnRow {
  id: string;
  chatId: string;
  status: TurnStatus;
  llmModelId: string | null;
  thinkingBudget: number | null;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  cancelRequestedAt: Date | null;
  error: string | null;
  startedAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

const TURN_COLUMNS = [
  'id',
  'chat_id',
  'status',
  'llm_model_id',
  'thinking_budget',
  'iterations',
  'input_tokens',
  'output_tokens',
  'cancel_requested_at',
  'error',
  'started_at',
  'updated_at',
  'finished_at',
] as const;

export function turnStatusOf(value: string): TurnStatus {
  return value === 'running' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'canceled' ||
    value === 'interrupted'
    ? value
    : 'failed';
}

export function isTurnSettled(status: TurnStatus): boolean {
  return status !== 'running';
}

function rowOf(raw: {
  id: string;
  chat_id: string;
  status: string;
  llm_model_id: string | null;
  thinking_budget: number | null;
  iterations: number;
  input_tokens: number;
  output_tokens: number;
  cancel_requested_at: Date | null;
  error: string | null;
  started_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}): TurnRow {
  return {
    id: raw.id,
    chatId: raw.chat_id,
    status: turnStatusOf(raw.status),
    llmModelId: raw.llm_model_id,
    thinkingBudget: raw.thinking_budget,
    iterations: raw.iterations,
    inputTokens: raw.input_tokens,
    outputTokens: raw.output_tokens,
    cancelRequestedAt: raw.cancel_requested_at,
    error: raw.error,
    startedAt: raw.started_at,
    updatedAt: raw.updated_at,
    finishedAt: raw.finished_at,
  };
}

export function toTurnView(turn: TurnRow): TurnView {
  return {
    id: turn.id,
    status: turn.status,
    error: turn.error,
    startedAt: turn.startedAt.toISOString(),
    finishedAt: turn.finishedAt ? turn.finishedAt.toISOString() : null,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

export async function createTurn(
  db: Kysely<DB> | Transaction<DB>,
  input: {
    tenantId: string;
    chatId: string;
    llmModelId: string | null;
    thinkingBudget: number | null;
  }
): Promise<Result<string, 'ALREADY_RUNNING' | 'DB_ERROR'>> {
  try {
    const inserted = await db
      .insertInto('chat_turns')
      .values({
        tenant_id: input.tenantId,
        chat_id: input.chatId,
        status: 'running',
        llm_model_id: input.llmModelId,
        thinking_budget: input.thinkingBudget,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return ok(inserted.id);
  } catch (error) {
    if (isUniqueViolation(error)) {
      return err('ALREADY_RUNNING' as const, { message: 'A reply is already in progress.' });
    }
    return err('DB_ERROR' as const, {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function getTurn(
  db: Kysely<DB>,
  tenantId: string,
  chatId: string,
  turnId: string
): Promise<TurnRow | null> {
  if (!isUuid(chatId) || !isUuid(turnId)) return null;
  const raw = await db
    .selectFrom('chat_turns')
    .select(TURN_COLUMNS)
    .where('tenant_id', '=', tenantId)
    .where('chat_id', '=', chatId)
    .where('id', '=', turnId)
    .executeTakeFirst();
  return raw ? rowOf(raw) : null;
}

export async function getActiveTurn(db: Kysely<DB>, chatId: string): Promise<TurnRow | null> {
  if (!isUuid(chatId)) return null;
  const raw = await db
    .selectFrom('chat_turns')
    .select(TURN_COLUMNS)
    .where('chat_id', '=', chatId)
    .where('status', '=', 'running')
    .executeTakeFirst();
  return raw ? rowOf(raw) : null;
}

/** Refreshes liveness; answers whether a cancel was requested meanwhile. */
export async function heartbeatTurn(
  db: Kysely<DB>,
  turnId: string,
  iterations: number
): Promise<boolean> {
  const row = await db
    .updateTable('chat_turns')
    .set({ updated_at: sql<Date>`NOW()`, iterations })
    .where('id', '=', turnId)
    .where('status', '=', 'running')
    .returning('cancel_requested_at')
    .executeTakeFirst();
  return row?.cancel_requested_at !== null && row?.cancel_requested_at !== undefined;
}

export async function finishTurn(
  db: Kysely<DB>,
  turnId: string,
  outcome: {
    status: Exclude<TurnStatus, 'running'>;
    error: string | null;
    iterations: number;
    inputTokens: number;
    outputTokens: number;
  }
): Promise<void> {
  await db
    .updateTable('chat_turns')
    .set({
      status: outcome.status,
      error: outcome.error,
      iterations: outcome.iterations,
      input_tokens: outcome.inputTokens,
      output_tokens: outcome.outputTokens,
      updated_at: sql<Date>`NOW()`,
      finished_at: sql<Date>`NOW()`,
    })
    .where('id', '=', turnId)
    .where('status', '=', 'running')
    .execute();
}

/** Marks the wish; the runner (any replica) honors it on its next heartbeat. */
export async function requestTurnCancel(
  db: Kysely<DB>,
  tenantId: string,
  chatId: string,
  turnId: string
): Promise<boolean> {
  if (!isUuid(chatId) || !isUuid(turnId)) return false;
  const result = await db
    .updateTable('chat_turns')
    .set({ cancel_requested_at: sql<Date>`NOW()` })
    .where('tenant_id', '=', tenantId)
    .where('chat_id', '=', chatId)
    .where('id', '=', turnId)
    .where('status', '=', 'running')
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}
