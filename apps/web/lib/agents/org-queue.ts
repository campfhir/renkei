/**
 * The operator's view of every agent's queue at once
 * (app/(app)/admin/agents/queue): the organization's live runs, oldest
 * first, with the agent's name and the owner; and halting a batch of them
 * to clear a backlog. Content-free reads; both callers gate on
 * ROLE_OPERATOR.
 */

import { getDataStore } from '@renkei/db';
import { forceHaltRun } from './force-halt';
import { isUuid } from '@/lib/uuid';

/** Rows per page of the queue view. */
export const ORG_QUEUE_PAGE_SIZE = 50;
/** The most runs one halt request takes (two pages' worth). */
export const MAX_ORG_HALT = 100;

export interface OrgQueueRunView {
  id: string;
  agentId: string;
  agentName: string;
  ownerSubject: string;
  ownerEmail: string | null;
  status: string;
  triggerKind: string;
  createdAt: string;
  startedAt: string | null;
  resumedAt: string | null;
  cancelRequestedAt: string | null;
}

const iso = (date: Date | null) => (date ? date.toISOString() : null);

/** One page of the organization's live runs (`limit` rows from `offset`). */
export async function listOrgQueue(options: {
  statuses?: readonly string[];
  limit: number;
  offset: number;
}): Promise<OrgQueueRunView[]> {
  const rows = await getDataStore().agentRuns.listLiveForOrg(options);
  return rows.map((row) => ({
    id: row.id,
    agentId: row.agentId,
    agentName: row.agentName,
    ownerSubject: row.ownerSubject,
    ownerEmail: row.ownerEmail,
    status: row.status,
    triggerKind: row.triggerKind,
    createdAt: row.createdAt.toISOString(),
    startedAt: iso(row.startedAt),
    resumedAt: iso(row.resumedAt),
    cancelRequestedAt: iso(row.cancelRequestedAt),
  }));
}

/** How many live runs the organization has in each live status. */
export async function countOrgQueue(): Promise<{ status: string; count: number }[]> {
  return getDataStore().agentRuns.countLiveForOrg();
}

export interface OrgHaltResult {
  halted: string[];
  refused: { runId: string; error: string }[];
}

/**
 * Halt each of these runs as the operator (force-halt.ts), one at a time;
 * a run that already finished or is gone is reported, not fatal.
 */
export async function haltRunsAsOperator(
  runs: readonly { agentId: string; runId: string }[],
  bySubject: string
): Promise<OrgHaltResult> {
  const result: OrgHaltResult = { halted: [], refused: [] };
  for (const { agentId, runId } of runs) {
    if (!isUuid(agentId) || !isUuid(runId)) {
      result.refused.push({ runId, error: 'Not found.' });
      continue;
    }
    const outcome = await forceHaltRun({ agentId, runId, haltedBySubject: bySubject });
    if (outcome.outcome === 'halted') result.halted.push(runId);
    else if (outcome.outcome === 'not-found') result.refused.push({ runId, error: 'Not found.' });
    else {
      result.refused.push({
        runId,
        error: `This run already ${outcome.status === 'canceled' ? 'was canceled' : outcome.status}.`,
      });
    }
  }
  return result;
}
