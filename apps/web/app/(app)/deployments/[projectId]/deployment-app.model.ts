/**
 * One app's deployments (deployment-app.tsx): each environment's card —
 * what runs there, how the pipeline deploys it, whether it is behind —
 * each promotion — the commits merging brings, the pull request, and
 * opening it or merging it (a merge is asked twice: it deploys) — and the
 * history — and the repository's branches, feature branches too, with their
 * newest run, where an editor starts the checks on any branch or redeploys
 * an environment from its own (asked twice: it deploys). Tested in
 * deployment-app.model.test.ts. The clock is passed in.
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

export type RunState = 'success' | 'failure' | 'running' | 'pending' | 'other';

/** One of the repository's branches, as GET /api/deployments/[projectId] lists it. */
export interface Branch {
  name: string;
  commit: { sha: string; message: string | null; date: string | null };
  run: { state: RunState; url: string; startedAt: string } | null;
  /** The environment it deploys, if one does. */
  environment: string | null;
}

/** What GET /api/deployments/[projectId] answers. */
export interface AppData extends AppView {
  /** False until the project's pipeline is built in Renkei. */
  hasPipeline: boolean;
  history: DeploymentView[];
  promotions: Promotion[];
  /** Null when the host could not list them (branchesError says why). */
  branches: Branch[] | null;
  branchesError: string | null;
  /** Whether the pipeline has checks to start by hand. */
  hasChecks: boolean;
}

/** What a manual start runs on a branch: the checks, or an environment's deploy. */
export type ManualRun = { branch: string; run: 'checks' } | { branch: string; run: string };

export interface AppState {
  data: AppData | null;
  busy: 'load' | 'promote' | 'merge' | 'run' | null;
  error: string | null;
  notice: string | null;
  /** The merge asked about, waiting for a yes. */
  confirming: { from: string; to: string; number: number } | null;
  /** The redeploy asked about, waiting for a yes. */
  confirmingRun: { branch: string; environment: string } | null;
  /** The run just started from here, linked until the next change. */
  started: { text: string; url: string } | null;
  /** What the Branches list is narrowed to. */
  branchQuery: string;
}

export type AppAction =
  | { type: 'loaded'; data: AppData; notice?: string }
  | { type: 'failed'; error: string }
  | { type: 'sent'; busy: 'promote' | 'merge' | 'run' }
  | { type: 'askMerge'; from: string; to: string; number: number }
  | { type: 'cancelMerge' }
  | { type: 'askRedeploy'; branch: string; environment: string }
  | { type: 'cancelRedeploy' }
  /** A manual run started on the host; `url` is the run or where its runs are listed. */
  | { type: 'runStarted'; request: ManualRun; url: string }
  | { type: 'branchQuery'; query: string };

export const initialApp: AppState = {
  data: null,
  busy: 'load',
  error: null,
  notice: null,
  confirming: null,
  confirmingRun: null,
  started: null,
  branchQuery: '',
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
      return { ...state, busy: action.busy, error: null, notice: null, started: null };
    case 'askMerge':
      return {
        ...state,
        confirming: { from: action.from, to: action.to, number: action.number },
        error: null,
      };
    case 'cancelMerge':
      return { ...state, confirming: null };
    case 'askRedeploy':
      return {
        ...state,
        confirmingRun: { branch: action.branch, environment: action.environment },
        error: null,
      };
    case 'cancelRedeploy':
      return { ...state, confirmingRun: null };
    case 'runStarted':
      return {
        ...state,
        busy: null,
        confirmingRun: null,
        started: { text: startedText(action.request), url: action.url },
      };
    case 'branchQuery':
      return { ...state, branchQuery: action.query.slice(0, 200) };
  }
}

function startedText(request: ManualRun): string {
  return request.run === 'checks'
    ? `Started the checks on ${request.branch}.`
    : `Started redeploying ${environmentLabel(request.run)} from ${request.branch}.`;
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

// ——— branches ———

export interface BranchRow {
  name: string;
  /** “deploys Production”, when an environment's branch. */
  deploys: string | null;
  commit: string;
  message: string | null;
  when: string | null;
  run: { label: string; tone: Tone; url: string; when: string } | null;
  /** What an editor can start on it; empty for a viewer. */
  actions: (
    { kind: 'checks'; label: string } | { kind: 'redeploy'; label: string; environment: string }
  )[];
}

const RUN: Record<RunState, { label: string; tone: Tone }> = {
  success: { label: 'Passed', tone: 'good' },
  failure: { label: 'Failed', tone: 'bad' },
  running: { label: 'Running', tone: 'running' },
  pending: { label: 'Waiting', tone: 'running' },
  other: { label: 'Stopped', tone: 'none' },
};

/** The Branches list: every branch the host listed, narrowed by the query. */
export function branchRows(state: AppState, now: number): BranchRow[] {
  const app = state.data;
  if (!app?.branches) return [];
  const query = state.branchQuery.trim().toLowerCase();
  return app.branches
    .filter((b) => !query || b.name.toLowerCase().includes(query))
    .map((b) => {
      const actions: BranchRow['actions'] = [];
      if (app.canEdit && app.hasChecks) actions.push({ kind: 'checks', label: 'Run checks' });
      if (app.canEdit && b.environment) {
        actions.push({
          kind: 'redeploy',
          label: `Redeploy ${environmentLabel(b.environment)}`,
          environment: b.environment,
        });
      }
      return {
        name: b.name,
        deploys: b.environment ? `deploys ${environmentLabel(b.environment)}` : null,
        commit: shortSha(b.commit.sha),
        message: b.commit.message,
        when: b.commit.date ? ago(b.commit.date, now) : null,
        run: b.run
          ? { ...RUN[b.run.state], url: b.run.url, when: ago(b.run.startedAt, now) }
          : null,
        actions,
      };
    });
}

/** Under the Branches heading: how many, and what the host could not say. */
export function branchesNote(state: AppState): string | null {
  const app = state.data;
  if (!app) return null;
  if (!app.branches) {
    return `${HOST_LABEL[app.host]} did not list the branches${app.branchesError ? `: ${app.branchesError}` : '.'}`;
  }
  if (app.branchesError) return app.branchesError;
  if (!app.canEdit) return 'Only the project’s editors start its pipeline.';
  return app.hasChecks
    ? 'Run the checks on any branch; an environment redeploys only from its own branch.'
    : 'An environment redeploys only from its own branch; the pipeline has no checks to run.';
}

/** What a start sends (POST /api/deployments/[projectId]/run). */
export function runRequest(branch: string, run: 'checks' | string): ManualRun {
  return { branch, run };
}

/** The question before a redeploy, which deploys. */
export function redeployQuestion(state: AppState): string | null {
  const c = state.confirmingRun;
  if (!c) return null;
  return `Redeploy ${environmentLabel(c.environment)} from ${c.branch}? The pipeline deploys what ${c.branch} has now.`;
}
