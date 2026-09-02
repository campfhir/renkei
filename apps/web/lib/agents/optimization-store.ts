/**
 * Reads and writes for `agent_optimizations` — the durable half of an
 * optimization pass, shaped exactly like draft-store.ts and scoped the
 * same way: a pass belongs to the agent's OWNER, and every read here is
 * keyed by owner rather than filtered after the fact.
 */

import { sql, type Kysely } from 'kysely';
import type { DB, Json } from '@renkei/db';
import { isUuid } from '@/lib/uuid';
import { parseOptimizationReport, type OptimizationReport } from './optimization-report';

export type OptimizationStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface OptimizationRequest {
  /** How far back the pass looked, in days. */
  windowDays: number;
}

export interface AgentOptimization {
  id: string;
  agentId: string;
  status: OptimizationStatus;
  request: OptimizationRequest;
  result: OptimizationReport | null;
  error: string | null;
  errorDetail: string | null;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
  finishedAt: string | null;
  appliedAt: string | null;
}

function statusOf(value: string): OptimizationStatus {
  return value === 'running' || value === 'succeeded' || value === 'failed' ? value : 'queued';
}

function requestOf(value: Json): OptimizationRequest {
  const record: { [key: string]: Json | undefined } =
    typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
  return {
    windowDays:
      typeof record.windowDays === 'number' && record.windowDays > 0 ? record.windowDays : 30,
  };
}

interface Row {
  id: string;
  agent_id: string;
  status: string;
  request: Json;
  result: Json | null;
  error: string | null;
  error_detail: string | null;
  input_tokens: number;
  output_tokens: number;
  created_at: Date;
  finished_at: Date | null;
  applied_at: Date | null;
}

function viewOf(row: Row): AgentOptimization {
  return {
    id: row.id,
    agentId: row.agent_id,
    status: statusOf(row.status),
    request: requestOf(row.request),
    result: row.result === null ? null : parseOptimizationReport(row.result),
    error: row.error,
    errorDetail: row.error_detail,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
    appliedAt: row.applied_at ? row.applied_at.toISOString() : null,
  };
}

const COLUMNS = [
  'id',
  'agent_id',
  'status',
  'request',
  'result',
  'error',
  'error_detail',
  'input_tokens',
  'output_tokens',
  'created_at',
  'finished_at',
  'applied_at',
] as const;

/** Start a pass. The queue job that does the work is enqueued by the caller. */
export async function createOptimization(
  db: Kysely<DB>,
  params: { tenantId: string; ownerSubject: string; agentId: string; request: OptimizationRequest }
): Promise<string> {
  const row = await db
    .insertInto('agent_optimizations')
    .values({
      tenant_id: params.tenantId,
      owner_subject: params.ownerSubject,
      agent_id: params.agentId,
      status: 'queued',
      request: JSON.stringify(params.request),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** One pass, for its owner. Null for anyone else — the same answer as "none". */
export async function getOptimization(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string,
  optimizationId: string
): Promise<AgentOptimization | null> {
  if (!isUuid(optimizationId)) return null;
  const row = await db
    .selectFrom('agent_optimizations')
    .select(COLUMNS)
    .where('tenant_id', '=', tenantId)
    .where('owner_subject', '=', ownerSubject)
    .where('id', '=', optimizationId)
    .executeTakeFirst();
  return row ? viewOf(row) : null;
}

/** The newest pass for an agent, whatever its status — what the page shows. */
export async function latestOptimization(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string,
  agentId: string
): Promise<AgentOptimization | null> {
  if (!isUuid(agentId)) return null;
  const row = await db
    .selectFrom('agent_optimizations')
    .select(COLUMNS)
    .where('tenant_id', '=', tenantId)
    .where('owner_subject', '=', ownerSubject)
    .where('agent_id', '=', agentId)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row ? viewOf(row) : null;
}

/** A pass still queued or running for this agent — one at a time is plenty. */
export async function inFlightOptimization(
  db: Kysely<DB>,
  tenantId: string,
  agentId: string
): Promise<{ id: string } | null> {
  const row = await db
    .selectFrom('agent_optimizations')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('agent_id', '=', agentId)
    .where('status', 'in', ['queued', 'running'])
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  return row ?? null;
}

/**
 * Mark a pass as being worked on. The `queued` guard makes a redelivered
 * queue row a no-op rather than a second model call — the draft claim's
 * shape, for the same reason.
 */
export async function claimOptimization(db: Kysely<DB>, optimizationId: string): Promise<boolean> {
  const result = await db
    .updateTable('agent_optimizations')
    .set({ status: 'running', attempts: (eb) => eb('attempts', '+', 1), updated_at: new Date() })
    .where('id', '=', optimizationId)
    .where('status', '=', 'queued')
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

export async function finishOptimization(
  db: Kysely<DB>,
  optimizationId: string,
  outcome:
    | {
        status: 'succeeded';
        result: OptimizationReport;
        usage: { inputTokens: number; outputTokens: number };
      }
    | { status: 'failed'; error: string; detail?: string | null }
): Promise<void> {
  await db
    .updateTable('agent_optimizations')
    .set(
      outcome.status === 'succeeded'
        ? {
            status: 'succeeded',
            result: JSON.stringify(outcome.result),
            input_tokens: outcome.usage.inputTokens,
            output_tokens: outcome.usage.outputTokens,
            error: null,
            error_detail: null,
            finished_at: new Date(),
            updated_at: new Date(),
          }
        : {
            status: 'failed',
            error: outcome.error.slice(0, 2000),
            error_detail: outcome.detail ? outcome.detail.slice(0, 4000) : null,
            finished_at: new Date(),
            updated_at: new Date(),
          }
    )
    .where('id', '=', optimizationId)
    .execute();
}

/**
 * Record that the owner turned the report into a revision draft. The draft
 * id lands INSIDE the stored result so the page can link to it without a
 * second column, and `applied_at` says it happened.
 */
export async function markOptimizationApplied(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string,
  optimizationId: string,
  draftId: string
): Promise<void> {
  await db
    .updateTable('agent_optimizations')
    .set({
      result: sql`COALESCE(result, '{}'::jsonb) || ${JSON.stringify({ draftId })}::jsonb`,
      applied_at: new Date(),
      updated_at: new Date(),
    })
    .where('tenant_id', '=', tenantId)
    .where('owner_subject', '=', ownerSubject)
    .where('id', '=', optimizationId)
    .execute();
}
