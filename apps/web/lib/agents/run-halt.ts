/**
 * Halting stuck runs — the owner side of force-halt.ts.
 *
 * A cancel only asks (run-cancellation.ts): it sets a flag the engine acts
 * on the next time a worker reaches the run. A run that is stuck — queued
 * behind a job that never finishes, or "running" with no worker left — is
 * never reached, so its cancel never lands. Halting closes it out
 * directly, the way the operator's force-halt does, and clears its queue
 * jobs so nothing resumes it afterwards.
 *
 * Because it bypasses the engine, only a run that is actually stuck may be
 * halted (lib/agents/stuck.ts: queued or running for over two hours);
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
/** The most one request halts; a bigger backlog takes another press. */
export const MAX_HALTED_PER_REQUEST = 500;

export type HaltResult =
  | { outcome: 'halted'; runIds: string[] }
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

/**
 * One run of the agent with what the stuck rule reads (status, created,
 * latest resume), or null. For halting it, and for telling a caller whose
 * cancel will never land that halting is the way (agent_run_cancel).
 */
export async function findHaltCandidate(
  agentId: string,
  ownerSubject: string,
  runId: string
): Promise<StuckCandidate | null> {
  if (!isUuid(agentId) || !isUuid(runId)) return null;
  // The id search matches the run itself, and any run whose text happens to
  // quote that id: pick the run out by id.
  const rows = await getDataStore().agentRuns.list({
    agentId,
    ownerSubject,
    audience: 'owner',
    q: runId,
    matchId: runId,
    limit: 50,
  });
  const row = rows.find((candidate) => candidate.id === runId);
  return row ? candidateOf(row) : null;
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
      if (page.length < SCAN_PAGE || found.length >= MAX_HALTED_PER_REQUEST * 2) break;
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
    const result = await forceHaltRun({ agentId, runId, haltedBySubject: bySubject });
    if (result.outcome === 'halted') halted.push(runId);
  }
  return halted;
}

/**
 * Halt `runId` if it is stuck, or — without one — every stuck run of
 * the agent (up to MAX_HALTED_PER_REQUEST). `nowMs` is the caller's
 * clock, so a test can say when "now" is.
 */
export async function haltStuckRuns(input: {
  agentId: string;
  /** The agent's owner: whose runs these are. */
  ownerSubject: string;
  /** Who pressed it: the owner, or a grantee. */
  bySubject: string;
  runId?: string;
  nowMs: number;
}): Promise<HaltResult> {
  if (!isUuid(input.agentId)) return { outcome: 'not-found' };

  if (input.runId !== undefined) {
    const run = await findHaltCandidate(input.agentId, input.ownerSubject, input.runId);
    if (!run) return { outcome: 'not-found' };
    if (!isStuckRun(run, input.nowMs)) return { outcome: 'not-stuck', status: run.status };
    return {
      outcome: 'halted',
      runIds: await haltEach(input.agentId, [run.id], input.bySubject),
    };
  }

  const stuck = stuckRunIds(await liveRuns(input.agentId, input.ownerSubject), input.nowMs).slice(
    0,
    MAX_HALTED_PER_REQUEST
  );
  return {
    outcome: 'halted',
    runIds: await haltEach(input.agentId, stuck, input.bySubject),
  };
}
