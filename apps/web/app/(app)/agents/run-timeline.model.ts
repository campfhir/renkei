/**
 * What a run's timeline (run-timeline.tsx) says: how a turn finished, what
 * became of a staged batch and why it needed a person, where each batch is
 * drawn, the run's times line, and when a long detail is clamped behind
 * "Show all". Pure functions of the runs-view projection; tested in
 * run-timeline.model.test.ts. The component is a server render of these.
 */

import type { ActionBatchView, RunDetail } from '@/lib/agents/runs-view';
import { formatDurationMs } from '@/lib/duration';

/** Details longer than this render clamped behind a "Show all" toggle. */
export const CLAMP_CHARS = 280;

/** A long detail's preview and toggle wording, or null when it shows whole. */
export function clampOf(text: string): { preview: string; showAll: string } | null {
  if (text.length <= CLAMP_CHARS) return null;
  return {
    preview: `${text.slice(0, CLAMP_CHARS)}…`,
    showAll: `Show all (${text.length.toLocaleString()} characters)`,
  };
}

/** How a finishing turn said the run ended. */
export function finishWording(finish: unknown): string | null {
  switch (finish) {
    case 'done':
      return 'Finished — the goal was met.';
    case 'nothing_to_do':
      return 'Finished — there was nothing to do for this input.';
    case 'failed':
      return 'Gave up — the agent could not reach its goal.';
    default:
      return null;
  }
}

/** A batch's heading: "Proposed 2 changes". */
export function batchHeading(batch: Pick<ActionBatchView, 'actionCount'>): string {
  return `Proposed ${batch.actionCount} change${batch.actionCount === 1 ? '' : 's'}`;
}

/** Who (or what) let a batch through, or why it never ran. */
export function batchVerdict(batch: Pick<ActionBatchView, 'status' | 'acceptedBy'>): string {
  switch (batch.status) {
    case 'proposed':
      return 'Waiting for your go-ahead.';
    case 'declined':
      return 'Declined — none of these were made.';
    case 'expired':
      return 'Nobody accepted it in time — none of these were made.';
    case 'accepted':
    case 'executing':
      return batch.acceptedBy === 'auto'
        ? 'Accepted automatically — being carried out.'
        : 'Accepted — being carried out.';
    case 'completed':
      return batch.acceptedBy === 'auto'
        ? 'Accepted automatically and carried out.'
        : 'Accepted and carried out.';
    default:
      return batch.status;
  }
}

/** Why a batch waited for a person, when the reason is worth saying. */
export function reviewReasonWording(reason: string | null): string | null {
  switch (reason) {
    case 'high-risk':
      return 'Needed a person: it includes a high-risk action.';
    case 'policy':
      return 'Needed a person: your organization requires it for this run.';
    default:
      return null;
  }
}

/**
 * Batches by the turn that staged them. One whose turn this audience cannot
 * see still shows there (its status is content-free).
 */
export function batchesByTurn(batches: ActionBatchView[]): Map<number, ActionBatchView[]> {
  const byTurn = new Map<number, ActionBatchView[]>();
  for (const batch of batches) {
    byTurn.set(batch.turn, [...(byTurn.get(batch.turn) ?? []), batch]);
  }
  return byTurn;
}

/** The line over the turns: how many, active time, wall time once it has finished. */
export function runTimesLine(
  run: Pick<RunDetail, 'attempts' | 'activeMs' | 'startedAt' | 'finishedAt'>
): string {
  const wallMs =
    run.startedAt && run.finishedAt
      ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
      : null;
  const turns = run.attempts.length;
  return (
    `${turns} turn${turns === 1 ? '' : 's'} · active time ${formatDurationMs(run.activeMs)}` +
    (wallMs !== null ? ` · wall time ${formatDurationMs(wallMs)}` : '') +
    ' — time spent waiting on you is not counted against the run.'
  );
}

/** The compaction note's heading: which turns were folded into notes. */
export function compactionHeading(through: number): string {
  return `${through === 1 ? 'Turn 1' : `Turns 1–${through}`} folded into notes to fit the model’s context`;
}
