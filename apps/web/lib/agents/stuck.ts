/**
 * When a run counts as stuck — one rule for the Agents page's overview
 * (which flags it) and for halting it (which only a stuck run allows
 * its owner). Pure: importable from models, pages and routes alike.
 *
 * A run is stuck when it has been queued or running longer than
 * STUCK_AFTER_MS — the stuck-run janitor's horizon
 * (worker-agents/maintenance.ts): a healthy run has started and finished
 * well inside it. Waiting runs are never stuck; they wait on a person, and
 * their own deadline ends them. The clock starts at the run's latest
 * resume when there was one, so a run picked back up today is not stuck
 * for having first started last week.
 */

/** Queued or running longer than this, a run is stuck. */
export const STUCK_AFTER_MS = 2 * 60 * 60_000;

export interface StuckCandidate {
  id: string;
  status: string;
  /** ISO timestamps, as the runs views hand them out. */
  createdAt: string;
  resumedAt?: string | null;
}

/** Whether `run` is stuck at `nowMs`. */
export function isStuckRun(run: StuckCandidate, nowMs: number): boolean {
  if (run.status !== 'queued' && run.status !== 'running') return false;
  const since = Date.parse(run.resumedAt ?? run.createdAt);
  return Number.isFinite(since) && nowMs - since > STUCK_AFTER_MS;
}

/** The ids of the stuck runs among `runs`, in the order given. */
export function stuckRunIds(runs: readonly StuckCandidate[], nowMs: number): string[] {
  return runs.filter((run) => isStuckRun(run, nowMs)).map((run) => run.id);
}
