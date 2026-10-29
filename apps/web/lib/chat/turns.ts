/**
 * chat_turns: one row per Send, and the liveness of the work.
 *
 * `createTurn` relies on the partial unique index (one running turn per
 * chat): the insert either succeeds or the database says another turn is
 * running, and nothing in between can race. `heartbeat` is what keeps a
 * turn alive for the janitor and what carries a cancel request across
 * replicas.
 */

import { getDataStore, type ChatTurnInsert, type ChatTurnRecord } from '@renkei/db';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { isUuid } from '@/lib/uuid';
import { logger } from '@/lib/logger';
import type {
  PendingToolPermission,
  ToolPermissionDecision,
  TurnKind,
  TurnStatus,
  TurnView,
} from './views';

/**
 * The `tool_permission` document (migration 109): the ask, and once
 * answered, the answer alongside it. The runner writes the ask, the
 * decision route adds the answer, the runner reads it back and clears
 * the column. `decision` absent = still waiting.
 */
export interface ToolPermissionRecord extends PendingToolPermission {
  decision: ToolPermissionDecision | null;
  decidedAt: string | null;
}

export function isToolPermissionDecision(value: unknown): value is ToolPermissionDecision {
  return value === 'once' || value === 'always' || value === 'deny';
}

/** Whatever jsonb hands back, or null when it is not an ask at all. */
export function parseToolPermission(raw: unknown): ToolPermissionRecord | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record: Record<string, unknown> = { ...raw };
  if (typeof record.toolUseId !== 'string' || !record.toolUseId) return null;
  if (typeof record.messageId !== 'string' || !record.messageId) return null;
  if (typeof record.name !== 'string' || !record.name) return null;
  return {
    toolUseId: record.toolUseId,
    messageId: record.messageId,
    name: record.name,
    requestedAt:
      typeof record.requestedAt === 'string' ? record.requestedAt : new Date(0).toISOString(),
    decision: isToolPermissionDecision(record.decision) ? record.decision : null,
    decidedAt: typeof record.decidedAt === 'string' ? record.decidedAt : null,
  };
}

/**
 * What a process resuming a turn cannot read back off the rows (migration
 * 129's `runner`): the roles of the session that sent it — the tool
 * surface's token carries them — whether it came from voice mode, and the
 * person's browser zone.
 */
export interface TurnRunnerContext {
  roles: string[];
  voice: boolean;
  timeZone?: string | null;
}

export function parseTurnRunnerContext(raw: unknown): TurnRunnerContext | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record: Record<string, unknown> = { ...raw };
  if (!Array.isArray(record.roles)) return null;
  return {
    roles: record.roles.filter((role): role is string => typeof role === 'string'),
    voice: record.voice === true,
    timeZone: typeof record.timeZone === 'string' ? record.timeZone : null,
  };
}

export interface TurnRow {
  id: string;
  chatId: string;
  status: TurnStatus;
  kind: TurnKind;
  llmModelId: string | null;
  thinkingBudget: number | null;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  cancelRequestedAt: Date | null;
  error: string | null;
  /** What the runner was doing when it last heartbeat: 'model', 'tool:<name>', or null between rounds. */
  stage: string | null;
  /** When the current `stage` began — distinct from `updatedAt`, which refreshes every flush tick regardless. */
  stageAt: Date | null;
  /** The tool call the turn is parked behind, answered or not; null when none. */
  toolPermission: ToolPermissionRecord | null;
  /** Set by a runner that shut down mid-turn; cleared by the resume that claims it. */
  suspendedAt: Date | null;
  /** How many times a resuming process has picked this turn back up. */
  resumeCount: number;
  /** See TurnRunnerContext; null on a turn from before migration 129. */
  runner: TurnRunnerContext | null;
  startedAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

function turnKindOf(value: string): TurnKind {
  return value === 'compaction' ? 'compaction' : 'reply';
}

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
  kind: string;
  llm_model_id: string | null;
  thinking_budget: number | null;
  iterations: number;
  input_tokens: number;
  output_tokens: number;
  cancel_requested_at: Date | null;
  error: string | null;
  stage: string | null;
  stage_at: Date | null;
  tool_permission: unknown;
  suspended_at: Date | null;
  resume_count: number;
  runner: unknown;
  started_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}): TurnRow {
  return {
    id: raw.id,
    chatId: raw.chat_id,
    status: turnStatusOf(raw.status),
    kind: turnKindOf(raw.kind),
    llmModelId: raw.llm_model_id,
    thinkingBudget: raw.thinking_budget,
    iterations: raw.iterations,
    inputTokens: raw.input_tokens,
    outputTokens: raw.output_tokens,
    cancelRequestedAt: raw.cancel_requested_at,
    error: raw.error,
    stage: raw.stage,
    stageAt: raw.stage_at,
    toolPermission: parseToolPermission(raw.tool_permission),
    suspendedAt: raw.suspended_at,
    resumeCount: raw.resume_count,
    runner: parseTurnRunnerContext(raw.runner),
    startedAt: raw.started_at,
    updatedAt: raw.updated_at,
    finishedAt: raw.finished_at,
  };
}

export function toTurnView(turn: TurnRow): TurnView {
  const pending =
    turn.status === 'running' && turn.toolPermission && turn.toolPermission.decision === null
      ? turn.toolPermission
      : null;
  return {
    id: turn.id,
    status: turn.status,
    kind: turn.kind,
    error: turn.error,
    startedAt: turn.startedAt.toISOString(),
    finishedAt: turn.finishedAt ? turn.finishedAt.toISOString() : null,
    pendingPermission: pending
      ? {
          toolUseId: pending.toolUseId,
          messageId: pending.messageId,
          name: pending.name,
          requestedAt: pending.requestedAt,
        }
      : null,
  };
}

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

/** What a new turn row carries, as the store takes it. */
export function turnInsertOf(input: {
  chatId: string;
  llmModelId: string | null;
  thinkingBudget: number | null;
  kind?: TurnKind;
  runner?: TurnRunnerContext;
}): ChatTurnInsert {
  return {
    chatId: input.chatId,
    kind: input.kind ?? 'reply',
    llmModelId: input.llmModelId,
    thinkingBudget: input.thinkingBudget,
    runner: input.runner ?? null,
  };
}

export async function createTurn(input: {
  chatId: string;
  llmModelId: string | null;
  thinkingBudget: number | null;
  kind?: TurnKind;
  /** Kept for a resume (turn-recovery.ts); a compaction turn has none. */
  runner?: TurnRunnerContext;
}): Promise<Result<string, 'ALREADY_RUNNING' | 'DB_ERROR'>> {
  try {
    return ok(await getDataStore().chatThreads.createTurn(turnInsertOf(input)));
  } catch (error) {
    if (isUniqueViolation(error)) {
      return err('ALREADY_RUNNING' as const, { message: 'A reply is already in progress.' });
    }
    logger.error('chat turn could not be created: {error}', {
      component: 'chat/turns',
      chatId: input.chatId,
      error: error instanceof Error ? error.message : String(error),
    });
    return err('DB_ERROR' as const, {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** A turn as the store returns it, read the way rowOf reads a raw row. */
export function rowOfRecord(turn: ChatTurnRecord): TurnRow {
  return rowOf({
    id: turn.id,
    chat_id: turn.chatId,
    status: turn.status,
    kind: turn.kind,
    llm_model_id: turn.llmModelId,
    thinking_budget: turn.thinkingBudget,
    iterations: turn.iterations,
    input_tokens: turn.inputTokens,
    output_tokens: turn.outputTokens,
    cancel_requested_at: turn.cancelRequestedAt,
    error: turn.error,
    stage: turn.stage,
    stage_at: turn.stageAt,
    tool_permission: turn.toolPermission,
    suspended_at: turn.suspendedAt,
    resume_count: turn.resumeCount,
    runner: turn.runner,
    started_at: turn.startedAt,
    updated_at: turn.updatedAt,
    finished_at: turn.finishedAt,
  });
}

export async function getTurn(chatId: string, turnId: string): Promise<TurnRow | null> {
  if (!isUuid(chatId) || !isUuid(turnId)) return null;
  const turn = await getDataStore().chatThreads.getTurn(chatId, turnId);
  return turn ? rowOfRecord(turn) : null;
}

export async function getActiveTurn(chatId: string): Promise<TurnRow | null> {
  if (!isUuid(chatId)) return null;
  const turn = await getDataStore().chatThreads.getActiveTurn(chatId);
  return turn ? rowOfRecord(turn) : null;
}

/**
 * Refreshes liveness; answers whether a cancel was requested meanwhile.
 *
 * `stage` names what the loop is doing right now (or null between rounds).
 * `updated_at` always advances — it is the flush-timer heartbeat the
 * janitor's staleness check reads. `stage_at` only advances when `stage`
 * itself changes, so a turn stuck in one stage leaves behind how long it
 * has been stuck there, not just that the process was still alive.
 */
export async function heartbeatTurn(
  turnId: string,
  iterations: number,
  stage: string | null
): Promise<boolean> {
  return getDataStore().chatThreads.heartbeatTurn(turnId, iterations, stage);
}

export async function finishTurn(
  turnId: string,
  outcome: {
    status: Exclude<TurnStatus, 'running'>;
    error: string | null;
    iterations: number;
    inputTokens: number;
    outputTokens: number;
  }
): Promise<void> {
  // A turn that ends mid-ask (a crash, a cancel) leaves no ask behind.
  await getDataStore().chatThreads.finishTurn(turnId, outcome);
}

/**
 * A runner leaving a turn it has not finished (shutdown): the row stays
 * `running`, with no stage and a mark that nobody is executing it, for
 * `claimResumableTurns` to hand to another process at once.
 */
export async function suspendTurn(turnId: string, iterations: number): Promise<void> {
  await getDataStore().chatThreads.suspendTurn(turnId, iterations);
}

/**
 * Turns that are running with nobody running them, claimed for this
 * process: suspended by a runner that shut down, or with a heartbeat
 * older than `staleSeconds` (the runner heartbeats every couple of
 * seconds, while it prepares and while it works, so that is a process
 * that died). On Postgres the claim is the UPDATE itself — row-locked,
 * skipping rows another replica's sweep holds — so two replicas never
 * resume one turn. Only `reply` turns: a compaction pass has no rows to
 * resume from and is the janitor's. A turn resumed `maxResumes` times
 * already is left for `interruptExhaustedTurns`.
 */
export async function claimResumableTurns(options: {
  staleSeconds: number;
  maxResumes: number;
  limit: number;
}): Promise<TurnRow[]> {
  return (await getDataStore().chatThreads.claimResumableTurns(options)).map(rowOfRecord);
}

/**
 * The bound on resuming: a reply turn picked up `maxResumes` times that
 * is orphaned yet again is a process that dies on it, not a restart to
 * ride out. Ended as interrupted, with its streaming rows, the way the
 * janitor ends a turn nobody came back for. Returns the ids it ended.
 */
export async function interruptExhaustedTurns(options: {
  staleSeconds: number;
  maxResumes: number;
  error: string;
}): Promise<string[]> {
  return getDataStore().chatThreads.interruptExhaustedTurns(options);
}

/** Marks the wish; the runner (any replica) honors it on its next heartbeat. */
export async function requestTurnCancel(chatId: string, turnId: string): Promise<boolean> {
  if (!isUuid(chatId) || !isUuid(turnId)) return false;
  return getDataStore().chatThreads.requestTurnCancel(chatId, turnId);
}

/** The runner parks the turn behind this call; the row is what a reload or another replica reads. */
export async function requestToolPermission(
  turnId: string,
  ask: PendingToolPermission
): Promise<void> {
  const record: ToolPermissionRecord = { ...ask, decision: null, decidedAt: null };
  await getDataStore().chatThreads.setToolPermission(turnId, record);
}

/**
 * The owner's answer, written into the pending ask — and only into THAT
 * ask: a decision for a call the turn is no longer waiting on (answered
 * already, or a stale page) updates nothing and says so.
 */
export async function decideToolPermission(
  chatId: string,
  turnId: string,
  toolUseId: string,
  decision: ToolPermissionDecision
): Promise<boolean> {
  if (!isUuid(chatId) || !isUuid(turnId)) return false;
  return getDataStore().chatThreads.decideToolPermission(chatId, turnId, toolUseId, {
    decision,
    decidedAt: new Date().toISOString(),
  });
}

/** What the row says about one ask right now — the runner's poll while it waits. */
export async function readToolPermission(
  turnId: string,
  toolUseId: string
): Promise<ToolPermissionRecord | null> {
  const record = parseToolPermission(await getDataStore().chatThreads.getToolPermission(turnId));
  return record && record.toolUseId === toolUseId ? record : null;
}

/** The ask is over (answered, timed out, or the turn is ending): nothing pending. */
export async function clearToolPermission(turnId: string): Promise<void> {
  await getDataStore().chatThreads.clearToolPermission(turnId);
}
