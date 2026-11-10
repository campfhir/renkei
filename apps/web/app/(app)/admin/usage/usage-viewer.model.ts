/**
 * Organization usage (usage-viewer.tsx): what the page holds, what each
 * press asks the server for, and what it derives from the report it shows.
 *
 * The page holds the report it last got, the chart's series and the top
 * users' "+ agents" toggle. A period button, the person picker, a name on
 * a board and the toggle each ask for a fresh report (`requestFor`); the
 * component runs it in a transition and dispatches what came back. The
 * series toggle is local: the chart redraws from the report it has.
 */

import type { OrgUsageReport } from './actions';
import {
  ORG_USAGE_PERIODS,
  activeSummary,
  activeUserPercent,
  formatTokens,
  type RankedUserRow,
  type UsagePeriod,
} from './window';

/** The chart's series (components/usage-chart.tsx's `UsageSeries`). */
export type UsageSeriesKey = 'tokens' | 'runs' | 'tools';

export interface UsageViewerState {
  report: OrgUsageReport;
  series: UsageSeriesKey;
  /** The top users board counts agent tokens too. */
  includeAgents: boolean;
}

export type UsageViewerAction =
  | { type: 'seriesPicked'; series: UsageSeriesKey }
  | { type: 'includeAgentsPicked'; includeAgents: boolean }
  | { type: 'reportArrived'; report: OrgUsageReport };

export function init(initial: OrgUsageReport): UsageViewerState {
  return { report: initial, series: 'tokens', includeAgents: initial.includeAgentsInTopUsers };
}

export function reducer(state: UsageViewerState, action: UsageViewerAction): UsageViewerState {
  switch (action.type) {
    case 'seriesPicked':
      return { ...state, series: action.series };
    case 'includeAgentsPicked':
      return { ...state, includeAgents: action.includeAgents };
    case 'reportArrived':
      return { ...state, report: action.report };
  }
}

/** What a press asks the server for: `getOrgUsageReport(periodKey, zone, includeAgents, subject)`. */
export interface UsageRequest {
  periodKey: string;
  includeAgents: boolean;
  subject: string | null;
}

export type UsageChange =
  | { kind: 'period'; periodKey: string }
  | { kind: 'person'; subject: string | null }
  | { kind: 'includeAgents'; includeAgents: boolean };

/**
 * The report a press asks for: what it changes, everything else as shown.
 * The picker's "Everyone" (an empty value) is no person at all.
 */
export function requestFor(state: UsageViewerState, change: UsageChange): UsageRequest {
  const current: UsageRequest = {
    periodKey: state.report.periodKey,
    includeAgents: state.includeAgents,
    subject: state.report.subject,
  };
  switch (change.kind) {
    case 'period':
      return { ...current, periodKey: change.periodKey };
    case 'person':
      return { ...current, subject: change.subject || null };
    case 'includeAgents':
      return { ...current, includeAgents: change.includeAgents };
  }
}

/** The address that links to this view: the period, and the person when there is one. */
export function addressFor(href: string, report: Pick<OrgUsageReport, 'periodKey' | 'subject'>) {
  const url = new URL(href);
  url.searchParams.set('period', report.periodKey);
  if (report.subject) url.searchParams.set('user', report.subject);
  else url.searchParams.delete('user');
  return url.toString();
}

/** Signed out or not an operator: the page shows only why. */
export function blocked(report: OrgUsageReport): { heading: string; message: string } | null {
  if (!report.forbidden && !report.signedOut) return null;
  return {
    heading: report.signedOut ? 'Sign in required' : 'Operator access required',
    message: report.error ?? '',
  };
}

/** The period the report covers; one the buttons do not list is named by its length. */
export function periodOf(report: Pick<OrgUsageReport, 'periodKey' | 'days'>): UsagePeriod {
  return (
    ORG_USAGE_PERIODS.find((candidate) => candidate.key === report.periodKey) ?? {
      key: report.periodKey,
      label: `${report.days} days`,
      days: report.days,
      endOffsetDays: 0,
    }
  );
}

/** A day or less is counted by the hour. */
export function isHourly(report: Pick<OrgUsageReport, 'days'>): boolean {
  return report.days <= 1;
}

/** The name the page uses for the person it is scoped to. */
export function personName(report: Pick<OrgUsageReport, 'person' | 'subject'>): string {
  return report.person?.name ?? report.subject ?? '';
}

const count = (value: number) => value.toLocaleString('en-US');

export interface StatTile {
  label: string;
  value: string;
  hint?: string;
}

/** The four headline tiles. Scoped to a person, active users become their active days (or hours). */
export function statTiles(report: OrgUsageReport): StatTile[] {
  const { tokens, activity } = report;
  const totalTokens = (
    ['chat', 'chatProjects', 'codeProjects', 'agents', 'images'] as const
  ).reduce((sum, key) => sum + tokens[key].input + tokens[key].output, 0);
  const hourly = isHourly(report);
  const active = activeSummary(report.cells);
  const failureRate = activity.runs > 0 ? (activity.failures / activity.runs) * 100 : 0;
  const toolErrorRate =
    activity.toolCalls > 0 ? (activity.toolErrors / activity.toolCalls) * 100 : 0;

  return [
    {
      label: 'Tokens',
      value: formatTokens(totalTokens),
      hint: `${formatTokens(tokens.agents.input + tokens.agents.output)} in agents`,
    },
    report.subject !== null
      ? {
          label: hourly ? 'Active hours' : 'Active days',
          value: `${count(active.active)} / ${count(active.total)}`,
          hint:
            active.active > 0
              ? `${hourly ? 'hours' : 'days'} with a token, a run or a tool call`
              : `nothing in this period`,
        }
      : {
          label: 'Active users',
          value: `${count(activity.activeUsers)} / ${count(activity.totalUsers)}`,
          hint: `${activeUserPercent(activity.activeUsers, activity.totalUsers)}% used at least one token`,
        },
    {
      label: 'Agent runs',
      value: count(activity.runs),
      hint:
        activity.failures > 0
          ? `${count(activity.failures)} failed (${failureRate.toFixed(0)}%)`
          : activity.runs > 0
            ? 'none failed'
            : undefined,
    },
    {
      label: 'Tool calls',
      value: count(activity.toolCalls),
      hint:
        activity.toolErrors > 0
          ? `${count(activity.toolErrors)} failed (${toolErrorRate.toFixed(1)}%)`
          : activity.toolCalls > 0
            ? 'none failed'
            : undefined,
    },
  ];
}

/**
 * The top users board: the top few, then — below a gap — the selected
 * person's own row when they rank outside them. Inside the top they are
 * simply highlighted. The gap shows only when ranks are actually skipped:
 * #6 straight after #5 needs none.
 */
export function topUsersBoard(report: Pick<OrgUsageReport, 'topUsers' | 'selectedUser'>): {
  rows: RankedUserRow[];
  gapAtRank: number | null;
} {
  const selected = report.selectedUser;
  if (selected === null || report.topUsers.some((row) => row.rank === selected.rank)) {
    return { rows: report.topUsers, gapAtRank: null };
  }
  return {
    rows: [...report.topUsers, selected],
    gapAtRank: selected.rank > report.topUsers.length + 1 ? selected.rank : null,
  };
}

/** What the top users board says it counts, with the toggle and the person in view. */
export function topUsersHint(state: UsageViewerState): string {
  const { report, includeAgents } = state;
  const counts = includeAgents
    ? 'Chat, chat-project, code-project and agent tokens combined.'
    : 'Chat, chat-project and code-project tokens — toggle above to fold in their agents.';
  if (report.subject !== null && report.selectedUser === null) {
    return `${personName(report)} spent no tokens in this period. ${counts}`;
  }
  return `${counts} Pick a name to scope the page to that person.`;
}

/**
 * The people the picker lists. It knows everyone who signed in; a subject
 * reached by link may not be among them (a grant or agent owner who never
 * did), so it is listed first rather than snapping the picker back to
 * "Everyone".
 */
export function pickerPeople(
  report: Pick<OrgUsageReport, 'people' | 'subject' | 'person'>
): OrgUsageReport['people'] {
  const { subject, people } = report;
  if (!subject || people.some((person) => person.subject === subject)) return people;
  return [{ subject, label: personName(report) }, ...people];
}

/** Each model's line on "Tokens by model": its tokens, its share of all of them, its calls. */
export function modelLine(
  row: OrgUsageReport['byModel'][number],
  byModel: OrgUsageReport['byModel']
): string {
  const modelTotal = byModel.reduce(
    (sum, model) => sum + model.inputTokens + model.outputTokens,
    0
  );
  const total = row.inputTokens + row.outputTokens;
  const share = modelTotal > 0 ? Math.round((total / modelTotal) * 100) : 0;
  return `${formatTokens(total)} · ${share}% · ${count(row.calls)} calls`;
}
