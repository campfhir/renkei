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
  /**
   * Picking runs, after Select: the boxes show and a press on a row picks
   * it. Otherwise a press on a row opens the run.
   */
  selecting: boolean;
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
  | { type: 'startSelecting' }
  /** Done picking: the boxes go and every pick is let go. */
  | { type: 'stopSelecting' }
  /** Pick or unpick one run of `pageIds` (this page's runs). */
  | { type: 'toggle'; runId: string; pageIds: readonly string[] }
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
  /** "Select all N": every run of the tab, on every page; or none again. */
  | { type: 'pickAllMatching' }
  | { type: 'clearAllMatching' }
  | { type: 'allHaltStarted'; total: number }
  /** One batch of the halt-everything answered; `remaining` still match. */
  | { type: 'allHaltBatch'; halted: number; remaining: number }
  | { type: 'allHaltFailed'; error: string };

export function initOrgQueue(): OrgQueueState {
  return {
    selecting: false,
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
    case 'startSelecting':
      return { ...state, selecting: true, done: null };
    case 'stopSelecting':
      return { ...state, selecting: false, selected: [], allMatching: false };
    case 'toggle': {
      if (state.halted.includes(action.runId)) return state;
      // Unpicking one run out of "all": the rest of this page stays picked.
      if (state.allMatching) {
        return {
          ...state,
          allMatching: false,
          selected: action.pageIds.filter(
            (id) => id !== action.runId && !state.halted.includes(id)
          ),
        };
      }
      return {
        ...state,
        selected: state.selected.includes(action.runId)
          ? without(state.selected, [action.runId])
          : [...state.selected, action.runId],
      };
    }
    case 'toggleAll': {
      if (state.allMatching) return { ...state, allMatching: false, selected: [] };
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
      return { ...state, selecting: true, allMatching: true, done: null };
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
        selecting: false,
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
  if (state.allMatching && open.length > 0) return 'all';
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

/** Whether the run shows as picked: picked by hand, or under "Select all". */
export function isPicked(state: OrgQueueState, runId: string): boolean {
  if (state.halted.includes(runId)) return false;
  return state.allMatching || state.selected.includes(runId);
}

/**
 * The Select all button, always there while selecting: "Select all 1,078",
 * or "Unselect all" once taken. Null while a halt-everything is running.
 */
export function selectAllLabel(state: OrgQueueState, total: number): string | null {
  if (state.progress) return null;
  return state.allMatching ? 'Unselect all' : `Select all ${total.toLocaleString('en-US')}`;
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
