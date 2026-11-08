/**
 * The agents page's "In flight" overview: for every agent the viewer can
 * see, what it has queued, running and waiting right now, and whether any
 * of it looks stuck. A pure projection of the agents and their live-run
 * counts (runs-view.ts listLiveRunCounts); the page passes the clock in.
 *
 * Stuck means a run has sat queued or running longer than STUCK_AFTER_MS —
 * the stuck-run janitor's horizon (worker-agents/maintenance.ts): a healthy
 * agent's run has started and finished well inside it. A waiting run is
 * not stuck, it is waiting on the owner (an approval or a question), so it
 * reads "needs you" instead.
 */

import type { LiveRunCount } from '@/lib/agents/runs-view';

/** Queued or running longer than this, a run reads as stuck. */
export const STUCK_AFTER_MS = 2 * 60 * 60_000;

export type OverviewState = 'stuck' | 'needs-you' | 'busy' | 'idle';

export interface OverviewAgent {
  id: string;
  name: string;
  enabled: boolean;
  /** Shared with the viewer by its owner, rather than the viewer's own. */
  shared: boolean;
}

export interface OverviewRow {
  agentId: string;
  name: string;
  enabled: boolean;
  shared: boolean;
  queued: number;
  running: number;
  waiting: number;
  state: OverviewState;
  /** What it has in flight, in words: "3 queued · 1 running", or "Nothing in flight". */
  inFlight: string;
  /** How long the oldest live run has existed ("2 d"), or null when idle. */
  oldestAge: string | null;
  /** The runs list to open, filtered to what the state is about. */
  href: string;
}

export interface Overview {
  rows: OverviewRow[];
  /** Agents with something stuck. */
  stuck: number;
  /** Agents with a run waiting on the viewer. */
  needsYou: number;
  /** Live runs across every agent. */
  live: number;
}

const ORDER: Record<OverviewState, number> = { stuck: 0, 'needs-you': 1, busy: 2, idle: 3 };

/** "45 s", "12 min", "3 h", "4 d": the largest whole unit, rounded down. */
export function ageWords(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

function rowFor(agent: OverviewAgent, counts: LiveRunCount[], nowMs: number): OverviewRow {
  const of = (status: LiveRunCount['status']) => counts.find((c) => c.status === status);
  const queued = of('queued');
  const running = of('running');
  const waiting = of('waiting');
  const ageOf = (count: LiveRunCount | undefined) =>
    count ? nowMs - Date.parse(count.oldestCreatedAt) : null;

  const stuckQueued = (ageOf(queued) ?? 0) > STUCK_AFTER_MS;
  const stuckRunning = (ageOf(running) ?? 0) > STUCK_AFTER_MS;
  const state: OverviewState =
    stuckQueued || stuckRunning
      ? 'stuck'
      : waiting
        ? 'needs-you'
        : queued || running
          ? 'busy'
          : 'idle';

  const parts = [
    queued ? `${queued.count} queued` : null,
    running ? `${running.count} running` : null,
    waiting ? `${waiting.count} waiting` : null,
  ].filter((part): part is string => part !== null);

  const ages = [ageOf(queued), ageOf(running), ageOf(waiting)].filter(
    (age): age is number => age !== null
  );
  const runs = `/agents/${agent.id}/runs`;
  // Open the runs behind the state: the stuck ones (running before queued,
  // since a stuck running run is what holds the queue), or the waiting ones.
  const href =
    state === 'stuck'
      ? `${runs}?status=${stuckRunning ? 'running' : 'queued'}`
      : state === 'needs-you'
        ? `${runs}?status=waiting`
        : runs;

  return {
    agentId: agent.id,
    name: agent.name,
    enabled: agent.enabled,
    shared: agent.shared,
    queued: queued?.count ?? 0,
    running: running?.count ?? 0,
    waiting: waiting?.count ?? 0,
    state,
    inFlight: parts.length > 0 ? parts.join(' · ') : 'Nothing in flight',
    oldestAge: ages.length > 0 ? ageWords(Math.max(...ages)) : null,
    href,
  };
}

/**
 * One row per agent, the ones needing attention first — stuck, then
 * waiting on the viewer, then busy, then idle — and by name within each.
 */
export function overviewOf(
  agents: readonly OverviewAgent[],
  counts: readonly LiveRunCount[],
  nowMs: number
): Overview {
  const rows = agents
    .map((agent) =>
      rowFor(
        agent,
        counts.filter((count) => count.agentId === agent.id),
        nowMs
      )
    )
    .sort(
      (a, b) =>
        ORDER[a.state] - ORDER[b.state] ||
        a.name.localeCompare(b.name) ||
        a.agentId.localeCompare(b.agentId)
    );
  return {
    rows,
    stuck: rows.filter((row) => row.state === 'stuck').length,
    needsYou: rows.filter((row) => row.state === 'needs-you').length,
    live: rows.reduce((sum, row) => sum + row.queued + row.running + row.waiting, 0),
  };
}

/** The line under the heading: what needs attention, or that nothing does. */
export function overviewHeadline(overview: Overview): string {
  if (overview.live === 0) return 'Nothing in flight right now.';
  const parts = [
    overview.stuck > 0 ? `${overview.stuck} stuck` : null,
    overview.needsYou > 0 ? `${overview.needsYou} waiting on you` : null,
  ].filter((part): part is string => part !== null);
  const runs = `${overview.live} run${overview.live === 1 ? '' : 's'} in flight`;
  return parts.length > 0 ? `${runs} — ${parts.join(', ')}.` : `${runs}.`;
}
