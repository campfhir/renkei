/**
 * The operator's queue view: every live run in the organization (queued,
 * running, waiting), which agent and whose it is, and how long it has
 * waited — so a backlog can be seen and cleared. Pure: the page passes the
 * runs (ISO times) and the clock; the table holds the reducer for what the
 * operator picked and what halting them answered.
 *
 * Clearing is a halt (lib/agents/force-halt.ts): the run straight to
 * canceled and its queue jobs gone, whatever state it is in — the operator
 * override, not a cancel that waits for a worker to reach the run.
 */

import { isStuckRun } from '@/lib/agents/stuck';

/** A live run as the page hands it over. */
export interface OrgQueueRun {
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

export interface OrgQueueRow {
  id: string;
  agentId: string;
  agentName: string;
  /** The owner's email, or their subject when there is none. */
  owner: string;
  status: string;
  triggerKind: string;
  createdAt: string;
  /** "3 h in queue", "running 12 min", "waiting 2 d". */
  age: string;
  /** Queued or running past the stuck horizon (lib/agents/stuck.ts). */
  stuck: boolean;
  /** A cancel was asked for and has not landed. */
  cancelAsked: boolean;
}

/** The statuses the view's tabs filter by, in tab order. */
export const LIVE_TABS = ['queued', 'running', 'waiting'] as const;
export type LiveTab = (typeof LIVE_TABS)[number];

export function isLiveTab(value: unknown): value is LiveTab {
  return LIVE_TABS.some((tab) => tab === value);
}

/** "45 s", "12 min", "3 h", "4 d". */
export function span(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

function ageOf(run: OrgQueueRun, nowMs: number): string {
  const since = (iso: string | null) => nowMs - Date.parse(iso ?? run.createdAt);
  if (run.status === 'queued') return `${span(since(run.resumedAt))} in queue`;
  if (run.status === 'running') return `running ${span(since(run.startedAt))}`;
  return `waiting ${span(since(run.createdAt))}`;
}

/** The rows the table shows, in the order given (oldest first). */
export function queueRows(runs: readonly OrgQueueRun[], nowMs: number): OrgQueueRow[] {
  return runs.map((run) => ({
    id: run.id,
    agentId: run.agentId,
    agentName: run.agentName,
    owner: run.ownerEmail ?? run.ownerSubject,
    status: run.status,
    triggerKind: run.triggerKind,
    createdAt: run.createdAt,
    age: ageOf(run, nowMs),
    stuck: isStuckRun(run, nowMs),
    cancelAsked: run.cancelRequestedAt !== null,
  }));
}

/** The tabs' labels with their counts: "All 12", "Queued 9", … */
export function tabLabels(
  counts: readonly { status: string; count: number }[]
): { value: LiveTab | undefined; label: string }[] {
  const of = (status: string) => counts.find((c) => c.status === status)?.count ?? 0;
  const total = LIVE_TABS.reduce((sum, tab) => sum + of(tab), 0);
  return [
    { value: undefined, label: `All ${total}` },
    ...LIVE_TABS.map((tab) => ({
      value: tab,
      label: `${tab[0].toUpperCase()}${tab.slice(1)} ${of(tab)}`,
    })),
  ];
}

// ── The table: what is picked, and what halting it answered ──────────────

export interface OrgQueueState {
  /** Run ids picked for a halt. */
  selected: string[];
  /** Run ids a halt is in flight for. */
  halting: string[];
  /** Run ids halted since the page loaded (shown as Halted until it reloads). */
  halted: string[];
  /** Why the last halt did not go through, run by run or as a whole. */
  error: string | null;
  /**
   * Every run the tab matches is picked, not just this page's: "Halt all"
   * then halts them on the server in batches.
   */
  allMatching: boolean;
  /** While halting every matching run: how many so far, of how many. */
  progress: { halted: number; total: number } | null;
  /** When halting every matching run finished: what it did. */
  done: string | null;
}

export type OrgQueueAction =
  | { type: 'toggle'; runId: string }
  /** The select-all box over these ids: all picked → none, else all. */
  | { type: 'toggleAll'; runIds: readonly string[] }
  | { type: 'haltStarted'; runIds: readonly string[] }
  | {
      type: 'haltAnswered';
      halted: readonly string[];
      /** Runs that could not be halted, with why. */
      refused: readonly { runId: string; error: string }[];
    }
  | { type: 'haltFailed'; runIds: readonly string[]; error: string }
  /** "Pick all N" over every page of the tab, or back to this page's picks. */
  | { type: 'pickAllMatching' }
  | { type: 'clearAllMatching' }
  | { type: 'allHaltStarted'; total: number }
  /** One batch of the halt-everything answered; `remaining` still match. */
  | { type: 'allHaltBatch'; halted: number; remaining: number }
  | { type: 'allHaltFailed'; error: string };

export function initOrgQueue(): OrgQueueState {
  return {
    selected: [],
    halting: [],
    halted: [],
    error: null,
    allMatching: false,
    progress: null,
    done: null,
  };
}

const without = (list: readonly string[], drop: readonly string[]) =>
  list.filter((id) => !drop.includes(id));

export function orgQueueReducer(state: OrgQueueState, action: OrgQueueAction): OrgQueueState {
  switch (action.type) {
    case 'toggle':
      return {
        ...state,
        selected: state.selected.includes(action.runId)
          ? without(state.selected, [action.runId])
          : [...state.selected, action.runId],
      };
    case 'toggleAll': {
      const open = action.runIds.filter((id) => !state.halted.includes(id));
      const allPicked = open.length > 0 && open.every((id) => state.selected.includes(id));
      return {
        ...state,
        selected: allPicked
          ? without(state.selected, open)
          : [...state.selected, ...open.filter((id) => !state.selected.includes(id))],
        // Unticking the page's box lets go of every page too.
        allMatching: allPicked ? false : state.allMatching,
      };
    }
    case 'pickAllMatching':
      return { ...state, allMatching: true, done: null };
    case 'clearAllMatching':
      return { ...state, allMatching: false, selected: [] };
    case 'allHaltStarted':
      return { ...state, progress: { halted: 0, total: action.total }, error: null, done: null };
    case 'allHaltBatch': {
      if (!state.progress) return state;
      const halted = state.progress.halted + action.halted;
      // Finished when nothing is left, or a batch halted nothing (what is
      // left could not be halted — it would only go round again).
      const finished = action.remaining === 0 || action.halted === 0;
      if (!finished) return { ...state, progress: { ...state.progress, halted } };
      return {
        ...state,
        progress: null,
        allMatching: false,
        selected: [],
        done:
          action.remaining === 0
            ? `Halted ${halted} ${halted === 1 ? 'run' : 'runs'}.`
            : `Halted ${halted}; ${action.remaining} could not be halted.`,
      };
    }
    case 'allHaltFailed': {
      const halted = state.progress?.halted ?? 0;
      return {
        ...state,
        progress: null,
        error:
          halted > 0 ? `${action.error} (${halted} were halted before it stopped.)` : action.error,
      };
    }
    case 'haltStarted':
      return {
        ...state,
        halting: [...state.halting, ...action.runIds],
        error: null,
      };
    case 'haltAnswered': {
      const done = [...action.halted, ...action.refused.map((r) => r.runId)];
      return {
        ...state,
        selected: without(state.selected, action.halted),
        halting: without(state.halting, done),
        halted: [...state.halted, ...action.halted.filter((id) => !state.halted.includes(id))],
        error:
          action.refused.length === 0
            ? null
            : action.refused.length === 1
              ? `Run ${action.refused[0].runId.slice(0, 8)} was not halted: ${action.refused[0].error}`
              : `${action.refused.length} runs were not halted (they had already finished, or are gone).`,
      };
    }
    case 'haltFailed':
      return {
        ...state,
        halting: without(state.halting, action.runIds),
        error: action.error,
      };
  }
}

/** The select-all box: every open row picked, some, or none. */
export function selectAllState(
  state: OrgQueueState,
  runIds: readonly string[]
): 'all' | 'some' | 'none' {
  const open = runIds.filter((id) => !state.halted.includes(id));
  const picked = open.filter((id) => state.selected.includes(id)).length;
  if (picked === 0) return 'none';
  return picked === open.length ? 'all' : 'some';
}

/** What "Halt selected" sends for these rows: the picked ones not yet halted. */
export function haltRequest(
  state: OrgQueueState,
  rows: readonly OrgQueueRow[]
): { runs: { agentId: string; runId: string }[] } {
  return {
    runs: rows
      .filter(
        (row) =>
          state.selected.includes(row.id) &&
          !state.halted.includes(row.id) &&
          !state.halting.includes(row.id)
      )
      .map((row) => ({ agentId: row.agentId, runId: row.id })),
  };
}

/**
 * The offer under a fully picked page when the tab has more runs than the
 * page: "All 50 on this page are picked. Pick all 1,078?" — or, once taken,
 * the way back. Null when there is nothing more to offer.
 */
export function pickAllOffer(
  state: OrgQueueState,
  runIds: readonly string[],
  total: number
): { text: string; action: 'pick' | 'clear' } | null {
  if (state.progress) return null;
  if (state.allMatching) {
    return { text: `All ${total.toLocaleString('en-US')} runs are picked.`, action: 'clear' };
  }
  const open = runIds.filter((id) => !state.halted.includes(id));
  if (selectAllState(state, runIds) !== 'all' || total <= open.length) return null;
  return {
    text: `All ${open.length} on this page are picked.`,
    action: 'pick',
  };
}

/**
 * The bulk button's label: "Halt 3 selected", "Halt all 1,078", "Halting…
 * 200 of 1,078", or null when none are picked. `total` is how many runs
 * the tab matches.
 */
export function haltSelectedLabel(
  state: OrgQueueState,
  rows: readonly OrgQueueRow[],
  total = 0
): string | null {
  if (state.progress) {
    return `Halting… ${state.progress.halted.toLocaleString('en-US')} of ${state.progress.total.toLocaleString('en-US')}`;
  }
  if (state.allMatching) return `Halt all ${total.toLocaleString('en-US')}`;
  const count = haltRequest(state, rows).runs.length;
  if (state.halting.length > 0 && count === 0) return 'Halting…';
  return count > 0 ? `Halt ${count} selected` : null;
}
