/**
 * Reads and writes for `agent_optimizations` — the durable half of an
 * optimization pass, shaped exactly like draft-store.ts and scoped the
 * same way: a pass belongs to the agent's OWNER, and every read here is
 * keyed by owner rather than filtered after the fact.
 */

import { getDataStore, type AgentOptimizationRecord, type Json } from '@renkei/db';
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

function viewOf(row: AgentOptimizationRecord): AgentOptimization {
  return {
    id: row.id,
    agentId: row.agentId,
    status: statusOf(row.status),
    request: requestOf(row.request),
    result: row.result === null ? null : parseOptimizationReport(row.result),
    error: row.error,
    errorDetail: row.errorDetail,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    appliedAt: row.appliedAt ? row.appliedAt.toISOString() : null,
  };
}

/** Start a pass. The queue job that does the work is enqueued by the caller. */
export async function createOptimization(params: {
  ownerSubject: string;
  agentId: string;
  request: OptimizationRequest;
}): Promise<string> {
  return getDataStore().agentOptimizations.create({
    ownerSubject: params.ownerSubject,
    agentId: params.agentId,
    request: { windowDays: params.request.windowDays },
  });
}

/** One pass, for its owner. Null for anyone else — the same answer as "none". */
export async function getOptimization(
  ownerSubject: string,
  optimizationId: string
): Promise<AgentOptimization | null> {
  if (!isUuid(optimizationId)) return null;
  const row = await getDataStore().agentOptimizations.find(ownerSubject, optimizationId);
  return row ? viewOf(row) : null;
}

/** The newest pass for an agent, whatever its status — what the page shows. */
export async function latestOptimization(
  ownerSubject: string,
  agentId: string
): Promise<AgentOptimization | null> {
  if (!isUuid(agentId)) return null;
  const row = await getDataStore().agentOptimizations.latest(ownerSubject, agentId);
  return row ? viewOf(row) : null;
}

/** A pass still queued or running for this agent — one at a time is plenty. */
export async function inFlightOptimization(agentId: string): Promise<{ id: string } | null> {
  if (!isUuid(agentId)) return null;
  return getDataStore().agentOptimizations.inFlight(agentId);
}

/**
 * Mark a pass as being worked on. The `queued` guard makes a redelivered
 * queue row a no-op rather than a second model call — the draft claim's
 * shape, for the same reason.
 */
export async function claimOptimization(optimizationId: string): Promise<boolean> {
  return getDataStore().agentOptimizations.claim(optimizationId);
}

export async function finishOptimization(
  optimizationId: string,
  outcome:
    | {
        status: 'succeeded';
        result: OptimizationReport;
        usage: { inputTokens: number; outputTokens: number };
      }
    | { status: 'failed'; error: string; detail?: string | null }
): Promise<void> {
  await getDataStore().agentOptimizations.finish(
    optimizationId,
    outcome.status === 'succeeded'
      ? {
          status: 'succeeded',
          result: reportJson(outcome.result),
          inputTokens: outcome.usage.inputTokens,
          outputTokens: outcome.usage.outputTokens,
        }
      : {
          status: 'failed',
          error: outcome.error.slice(0, 2000),
          detail: outcome.detail ? outcome.detail.slice(0, 4000) : null,
        }
  );
}

/** The report as the JSON it is stored as. */
function reportJson(report: OptimizationReport): Json {
  const json: Json = JSON.parse(JSON.stringify(report));
  return json;
}

/** Remove a pass whose job could not be queued. */
export async function deleteOptimization(optimizationId: string): Promise<void> {
  await getDataStore().agentOptimizations.delete(optimizationId);
}

/**
 * Record that the owner turned the report into a revision draft. The draft
 * id lands INSIDE the stored result so the page can link to it without a
 * second column, and `applied_at` says it happened.
 */
export async function markOptimizationApplied(
  ownerSubject: string,
  optimizationId: string,
  draftId: string
): Promise<void> {
  await getDataStore().agentOptimizations.markApplied(ownerSubject, optimizationId, draftId);
}
