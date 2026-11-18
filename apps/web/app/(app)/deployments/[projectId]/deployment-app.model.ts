/**
 * One app's deployments (deployment-app.tsx): each environment's card —
 * what runs there, how the pipeline deploys it, whether it is behind —
 * each promotion — the commits merging brings, the pull request, and
 * opening it or merging it (a merge is asked twice: it deploys) — and the
 * history. Tested in deployment-app.model.test.ts. The clock is passed in.
 */

import {
  HOST_LABEL,
  ago,
  cellNote,
  cellTone,
  environmentLabel,
  runLabel,
  shortSha,
  type AppView,
  type CellNote,
  type DeploymentView,
  type Tone,
} from '../deployments-page.model';

export interface Promotion {
  from: string;
  to: string;
  fromBranch: string;
  toBranch: string;
  ahead: {
    commits: { sha: string; message: string; author: string }[];
    count: number;
    more: boolean;
  } | null;
  pullRequest: { number: number; title: string; url: string; checks: string | null } | null;
  error: string | null;
}

/** What GET /api/deployments/[projectId] answers. */
export interface AppData extends AppView {
  history: DeploymentView[];
  promotions: Promotion[];
}

export interface AppState {
  data: AppData | null;
  busy: 'load' | 'promote' | 'merge' | null;
  error: string | null;
  notice: string | null;
  /** The merge asked about, waiting for a yes. */
  confirming: { from: string; to: string; number: number } | null;
}

export type AppAction =
  | { type: 'loaded'; data: AppData; notice?: string }
  | { type: 'failed'; error: string }
  | { type: 'sent'; busy: 'promote' | 'merge' }
  | { type: 'askMerge'; from: string; to: string; number: number }
  | { type: 'cancelMerge' };

export const initialApp: AppState = {
  data: null,
  busy: 'load',
  error: null,
  notice: null,
  confirming: null,
};

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'loaded':
      return {
        ...state,
        data: action.data,
        busy: null,
        notice: action.notice ?? null,
        confirming: null,
      };
    case 'failed':
      return { ...state, busy: null, error: action.error };
    case 'sent':
      return { ...state, busy: action.busy, error: null, notice: null };
    case 'askMerge':
      return {
        ...state,
        confirming: { from: action.from, to: action.to, number: action.number },
        error: null,
      };
    case 'cancelMerge':
      return { ...state, confirming: null };
  }
}

// ——— what the page derives ———

export interface EnvironmentCard {
  name: string;
  label: string;
  state: string;
  tone: Tone;
  commit: string | null;
  when: string | null;
  how: string;
  note: CellNote | null;
  runUrl: string | null;
}

const STATE: Record<Tone, string> = {
  good: 'Healthy',
  running: 'Deploying',
  bad: 'Last deploy failed',
  none: 'Not deployed yet',
};

export function environmentCards(state: AppState, now: number): EnvironmentCard[] {
  const app = state.data;
  if (!app) return [];
  return app.environments.map((environment, index) => {
    const shown = environment.running ?? environment.latest;
    return {
      name: environment.name,
      label: environmentLabel(environment.name),
      state: STATE[cellTone(environment)],
      tone: cellTone(environment),
      commit: shown ? shortSha(shown.commit) : null,
      when: shown ? ago(shown.startedAt, now) : null,
      how: `Deployed by the pipeline on every merge to ${environment.branch}${shown?.target ? ` · target ${shown.target}` : ''}`,
      note: cellNote(environment, index > 0 ? app.environments[index - 1] : null),
      runUrl: shown?.runUrl ?? null,
    };
  });
}

export interface PromotionView {
  key: string;
  from: string;
  to: string;
  title: string;
  summary: string;
  commits: { sha: string; message: string; author: string }[];
  moreCommits: boolean;
  checks: { text: string; tone: Tone } | null;
  pullRequest: { number: number; label: string; url: string } | null;
  /** What the person can do: merge it, open it, or nothing (with why). */
  action:
    | { kind: 'merge'; label: string; number: number }
    | { kind: 'open'; label: string }
    | { kind: 'none'; why: string };
  error: string | null;
}

const CHECKS: Record<string, { text: string; tone: Tone }> = {
  success: { text: 'Checks passed on the pull request', tone: 'good' },
  successful: { text: 'Checks passed on the pull request', tone: 'good' },
  failure: { text: 'Checks failed on the pull request', tone: 'bad' },
  failed: { text: 'Checks failed on the pull request', tone: 'bad' },
  error: { text: 'Checks failed on the pull request', tone: 'bad' },
  pending: { text: 'Checks are still running on the pull request', tone: 'running' },
  inprogress: { text: 'Checks are still running on the pull request', tone: 'running' },
};

export function promotions(state: AppState, now: number): PromotionView[] {
  const app = state.data;
  if (!app) return [];
  const hostName = HOST_LABEL[app.host];
  return app.promotions.map((p) => {
    const toEnv = app.environments.find((e) => e.name === p.to);
    const fromEnv = app.environments.find((e) => e.name === p.from);
    const runsTo = toEnv?.running ? shortSha(toEnv.running.commit) : null;
    const runsFrom = fromEnv?.running ?? null;
    const count = p.ahead?.count ?? null;
    const summary =
      count === null
        ? `${hostName} did not say what ${p.fromBranch} has that ${p.toBranch} lacks.`
        : count === 0
          ? `${p.toBranch} has everything ${p.fromBranch} has: nothing to promote.`
          : `${environmentLabel(p.to)} runs ${runsTo ?? 'nothing yet'}; merging brings ${count}${p.ahead?.more ? '+' : ''} commit${count === 1 ? '' : 's'} from ${p.fromBranch}${
              runsFrom
                ? `, which ${environmentLabel(p.from)} has run since ${ago(runsFrom.startedAt, now)}`
                : ''
            }.`;
    const checks = p.pullRequest?.checks
      ? (CHECKS[p.pullRequest.checks.toLowerCase().replace(/_/g, '')] ?? null)
      : null;
    const action: PromotionView['action'] = !app.canEdit
      ? { kind: 'none', why: 'Only the project’s editors promote it.' }
      : p.pullRequest
        ? { kind: 'merge', label: `Merge to ${p.toBranch}`, number: p.pullRequest.number }
        : count === 0
          ? { kind: 'none', why: '' }
          : { kind: 'open', label: `Open a pull request: ${p.fromBranch} → ${p.toBranch}` };
    return {
      key: `${p.from}-${p.to}`,
      from: p.from,
      to: p.to,
      title: `Promote to ${environmentLabel(p.to)}: merge ${p.fromBranch} into ${p.toBranch}`,
      summary,
      commits: (p.ahead?.commits ?? []).map((c) => ({ ...c, sha: shortSha(c.sha) })),
      moreCommits: p.ahead?.more ?? false,
      checks,
      pullRequest: p.pullRequest
        ? {
            number: p.pullRequest.number,
            label: `Pull request #${p.pullRequest.number} on ${hostName}`,
            url: p.pullRequest.url,
          }
        : null,
      action,
      error: p.error,
    };
  });
}

/** The question before a merge, which deploys. */
export function mergeQuestion(state: AppState): string | null {
  const c = state.confirming;
  const p = state.data?.promotions.find((x) => x.from === c?.from && x.to === c?.to);
  if (!c || !p) return null;
  return `Merge pull request #${c.number} into ${p.toBranch}? The pipeline on ${p.toBranch} deploys ${environmentLabel(p.to)} when it does.`;
}

export function promoteRequest(from: string, to: string): { from: string; to: string } {
  return { from, to };
}

export function mergeRequest(state: AppState): { from: string; to: string; number: number } | null {
  return state.confirming;
}

export interface HistoryRow {
  key: string;
  at: string;
  environment: string;
  commit: string;
  result: string;
  tone: Tone;
  run: string;
  runUrl: string | null;
  by: string;
}

export function historyRows(state: AppState): HistoryRow[] {
  return (state.data?.history ?? []).map((d) => ({
    key: `${d.runId}:${d.environment}`,
    at: d.startedAt,
    environment: environmentLabel(d.environment),
    commit: shortSha(d.commit),
    result:
      d.status === 'succeeded'
        ? 'Succeeded'
        : d.status === 'failed'
          ? `Failed${d.detail ? ` — ${d.detail}` : ''}`
          : 'Deploying',
    tone: d.status === 'succeeded' ? 'good' : d.status === 'failed' ? 'bad' : 'running',
    run: runLabel(d.runId),
    runUrl: d.runUrl,
    by: d.actor ? `${d.actor}, from ${d.branch ?? '?'}` : d.branch ? `a merge to ${d.branch}` : '',
  }));
}
