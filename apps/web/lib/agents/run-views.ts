/**
 * The run list's quick filters: each run status, plus the "meta statuses"
 * a run's status alone does not say — Stuck (queued or running past the
 * stuck horizon), Halted (canceled because it was halted while stuck) and
 * Paused (waiting on its owner's sign-in, not on a decision). Canceled and
 * Waiting leave out the runs those meta views own, so no run shows in two
 * of them.
 *
 * One list for the runs page's tabs, the In flight overview's links and
 * the chat's agent_runs_list, so a view added here reaches all three.
 * Pure: the clock comes in as `nowMs`.
 */

import { statusLabel } from './run-labels';
import { STUCK_AFTER_MS } from './stuck';

/** The error kind a halted run carries (force-halt.ts). */
const HALTED = ['force_halted'];
/** The error kind a run parked for its owner's sign-in carries (engine.ts). */
const PAUSED = ['needs-sign-in'];

/** Every quick filter, in the order the tabs show them. */
export const RUN_VIEWS = [
  'succeeded',
  'failed',
  'stopped',
  'waiting',
  'paused',
  'running',
  'queued',
  'stuck',
  'canceled',
  'halted',
] as const;
export type RunView = (typeof RUN_VIEWS)[number];

export function isRunView(value: unknown): value is RunView {
  return RUN_VIEWS.some((view) => view === value);
}

/** What a filter asks the run list for (agentRuns.list's options). */
export interface RunViewFilter {
  status?: string;
  statuses?: readonly string[];
  errorKinds?: readonly string[];
  excludeErrorKinds?: readonly string[];
  clockStartedBefore?: Date;
}

/** The tab's words. */
export function runViewLabel(view: RunView): string {
  switch (view) {
    case 'stuck':
      return 'Stuck';
    case 'halted':
      return statusLabel('canceled', HALTED[0]);
    case 'paused':
      return statusLabel('waiting', PAUSED[0]);
    default:
      return statusLabel(view);
  }
}

/** The run list filter behind `view` at `nowMs`. */
export function runViewFilter(view: RunView, nowMs: number): RunViewFilter {
  switch (view) {
    case 'stuck':
      return {
        statuses: ['queued', 'running'],
        clockStartedBefore: new Date(nowMs - STUCK_AFTER_MS),
      };
    case 'halted':
      return { status: 'canceled', errorKinds: HALTED };
    case 'canceled':
      return { status: 'canceled', excludeErrorKinds: HALTED };
    case 'paused':
      return { status: 'waiting', errorKinds: PAUSED };
    case 'waiting':
      return { status: 'waiting', excludeErrorKinds: PAUSED };
    default:
      return { status: view };
  }
}
