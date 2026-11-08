/**
 * Terminating stuck runs — the owner side of force-halt.ts.
 *
 * A cancel only asks (run-cancellation.ts): it sets a flag the engine acts
 * on the next time a worker reaches the run. A run that is stuck — queued
 * behind a job that never finishes, or "running" with no worker left — is
 * never reached, so its cancel never lands. Terminating closes it out
 * directly, the way the operator's force-halt does, and clears its queue
 * jobs so nothing resumes it afterwards.
 *
 * Because it bypasses the engine, only a run that is actually stuck may be
 * terminated (lib/agents/stuck.ts: queued or running for over two hours);
 * anything younger still has a live path, and Cancel is the way to stop it.
 *
 * The caller has resolved access to the agent (owner, or a grantee through
 * an unexpired grant — the grant exists to troubleshoot, as with cancel).
 */

import { getDataStore } from '@renkei/db';
import { forceHaltRun } from './force-halt';
import { isStuckRun, stuckRunIds, type StuckCandidate } from './stuck';
import { isUuid } from '@/lib/uuid';

/** Read this many runs at a time when gathering an agent's stuck ones. */
const SCAN_PAGE = 200;
/** The most one request terminates; a bigger backlog takes another press. */
export const MAX_TERMINATED_PER_REQUEST = 500;

export type TerminateResult =
  | { outcome: 'terminated'; runIds: string[] }
  /** The one run asked for is not stuck (too young, waiting, or finished). */
  | { outcome: 'not-stuck'; status: string }
  | { outcome: 'not-found' };

function candidateOf(row: {
  id: string;
  status: string;
  createdAt: Date;
  resumedAt: Date | null;
}): StuckCandidate {
  return {
    id: row.id,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    resumedAt: row.resumedAt ? row.resumedAt.toISOString() : null,
  };
}

/** The agent's queued and running runs, oldest last, up to the request's cap. */
async function liveRuns(agentId: string, ownerSubject: string): Promise<StuckCandidate[]> {
  const runs = getDataStore().agentRuns;
  const found: StuckCandidate[] = [];
  for (const status of ['running', 'queued'] as const) {
    for (let offset = 0; ; offset += SCAN_PAGE) {
      const page = await runs.list({
        agentId,
        ownerSubject,
        audience: 'owner',
        status,
        limit: SCAN_PAGE,
        offset,
      });
      found.push(...page.map(candidateOf));
      if (page.length < SCAN_PAGE || found.length >= MAX_TERMINATED_PER_REQUEST * 2) break;
    }
  }
  return found;
}

async function haltEach(
  agentId: string,
  runIds: readonly string[],
  bySubject: string
): Promise<string[]> {
  const halted: string[] = [];
  for (const runId of runIds) {
    const result = await forceHaltRun({ agentId, runId, haltedBySubject: bySubject, by: 'owner' });
    if (result.outcome === 'halted') halted.push(runId);
  }
  return halted;
}

/**
 * Terminate `runId` if it is stuck, or — without one — every stuck run of
 * the agent (up to MAX_TERMINATED_PER_REQUEST). `nowMs` is the caller's
 * clock, so a test can say when "now" is.
 */
export async function terminateStuckRuns(input: {
  agentId: string;
  /** The agent's owner: whose runs these are. */
  ownerSubject: string;
  /** Who pressed it: the owner, or a grantee. */
  bySubject: string;
  runId?: string;
  nowMs: number;
}): Promise<TerminateResult> {
  if (!isUuid(input.agentId)) return { outcome: 'not-found' };

  if (input.runId !== undefined) {
    if (!isUuid(input.runId)) return { outcome: 'not-found' };
    // The id search matches the run itself, and any run whose text happens
    // to quote that id: pick the run out by id.
    const wanted = input.runId;
    const rows = await getDataStore().agentRuns.list({
      agentId: input.agentId,
      ownerSubject: input.ownerSubject,
      audience: 'owner',
      q: wanted,
      matchId: wanted,
      limit: 50,
    });
    const row = rows.find((candidate) => candidate.id === wanted);
    const run = row ? candidateOf(row) : null;
    if (!run) return { outcome: 'not-found' };
    if (!isStuckRun(run, input.nowMs)) return { outcome: 'not-stuck', status: run.status };
    return {
      outcome: 'terminated',
      runIds: await haltEach(input.agentId, [run.id], input.bySubject),
    };
  }

  const stuck = stuckRunIds(await liveRuns(input.agentId, input.ownerSubject), input.nowMs).slice(
    0,
    MAX_TERMINATED_PER_REQUEST
  );
  return {
    outcome: 'terminated',
    runIds: await haltEach(input.agentId, stuck, input.bySubject),
  };
}
