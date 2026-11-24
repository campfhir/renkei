/**
 * A code project's Environments page (environments-page.tsx): the
 * project's environments — production and whatever else it names — the
 * branches of the repository assigned to each, and, for the environment
 * and branch picked, that branch's pipeline, runs and variables (each its
 * own component). Here: what is picked, the forms that add and rename an
 * environment, what each change sends, the questions asked before one
 * that takes something away, and how a deployment reads.
 *
 * The rules of the list are lib/ci/environment-rules.ts, shared with the
 * route that saves it. Tested in environments-page.model.test.ts. The
 * clock is passed in.
 */

import {
  environmentNameProblem,
  environmentOfBranch,
  renamed,
  withBranch,
  withEnvironment,
  withoutBranch,
  withoutEnvironment,
  type ProjectEnvironment,
} from '@/lib/ci/environment-rules';

export interface DeploymentView {
  environment: string;
  status: string;
  commit: string;
  branch: string | null;
  target: string | null;
  runId: string;
  runUrl: string | null;
  detail: string | null;
  actor: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface BranchView {
  name: string;
  onRemote: boolean | null;
  pipeline: { pullRequestUrl: string | null; written: boolean } | null;
}

export interface EnvironmentView {
  name: string;
  production: boolean;
  branches: BranchView[];
  latest: DeploymentView | null;
  running: DeploymentView | null;
}

/** What GET and PUT /api/code/projects/[id]/environments answer. */
export interface EnvironmentsData {
  host: 'bitbucket' | 'github';
  project: { name: string; repo: string };
  canEdit: boolean;
  environments: EnvironmentView[];
  remoteBranches: string[] | null;
  branchesError: string | null;
  history: DeploymentView[];
}

export type Tab = 'pipeline' | 'runs' | 'variables';
export const TABS: { id: Tab; label: string }[] = [
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'runs', label: 'Runs' },
  { id: 'variables', label: 'Variables' },
];

export interface Selection {
  environment: string | null;
  branch: string | null;
  tab: Tab;
}

export interface PageState {
  data: EnvironmentsData | null;
  loadError: string | null;
  busy: boolean;
  /** The change the route refused, and each rule it broke. */
  error: string | null;
  problems: string[];
  selection: Selection;
  /** The open form: a new environment's name, or the picked one's new name. */
  form: { kind: 'add' | 'rename'; name: string } | null;
  /** The branch picked in "Assign a branch". */
  picked: string;
}

export type PageAction =
  | { type: 'loaded'; data: EnvironmentsData }
  | { type: 'loadFailed'; error: string }
  | { type: 'environmentPicked'; name: string }
  | { type: 'branchPicked'; branch: string }
  | { type: 'tabPicked'; tab: Tab }
  | { type: 'formOpened'; kind: 'add' | 'rename' }
  | { type: 'formChanged'; name: string }
  | { type: 'formClosed' }
  | { type: 'assignPicked'; branch: string }
  | { type: 'sent' }
  | { type: 'failed'; error: string; problems?: string[] }
  /** A change was saved; `select` is what to show after it. */
  | { type: 'saved'; data: EnvironmentsData; select?: Partial<Selection> };

export function readTab(value: string | null | undefined): Tab {
  return value === 'runs' || value === 'variables' ? value : 'pipeline';
}

export function initialPage(selection: Selection): PageState {
  return {
    data: null,
    loadError: null,
    busy: false,
    error: null,
    problems: [],
    selection,
    form: null,
    picked: '',
  };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function pageReducer(state: PageState, action: PageAction): PageState {
  switch (action.type) {
    case 'loaded':
      return { ...state, data: action.data, loadError: null };
    case 'loadFailed':
      return { ...state, loadError: action.error };
    case 'environmentPicked':
      return {
        ...state,
        selection: { ...state.selection, environment: action.name, branch: null },
        form: null,
        picked: '',
        error: null,
        problems: [],
      };
    case 'branchPicked':
      return { ...state, selection: { ...state.selection, branch: action.branch } };
    case 'tabPicked':
      return { ...state, selection: { ...state.selection, tab: action.tab } };
    case 'formOpened':
      return {
        ...state,
        form: {
          kind: action.kind,
          name: action.kind === 'rename' ? (currentEnvironment(state)?.name ?? '') : '',
        },
        error: null,
        problems: [],
      };
    case 'formChanged':
      return state.form ? { ...state, form: { ...state.form, name: action.name } } : state;
    case 'formClosed':
      return { ...state, form: null };
    case 'assignPicked':
      return { ...state, picked: action.branch };
    case 'sent':
      return { ...state, busy: true, error: null, problems: [] };
    case 'failed':
      return { ...state, busy: false, error: action.error, problems: action.problems ?? [] };
    case 'saved':
      return {
        ...state,
        data: action.data,
        busy: false,
        form: null,
        picked: '',
        selection: { ...state.selection, ...action.select },
      };
  }
}

// ——— what is picked ———

/** The environment shown: the one picked, else the production one. */
export function currentEnvironment(state: PageState): EnvironmentView | null {
  const list = state.data?.environments ?? [];
  const picked = state.selection.environment;
  return (
    (picked ? list.find((e) => same(e.name, picked)) : undefined) ??
    list.find((e) => e.production) ??
    list[0] ??
    null
  );
}

/** The branch shown: the one picked when the environment has it, else its first. */
export function currentBranch(state: PageState): BranchView | null {
  const environment = currentEnvironment(state);
  if (!environment) return null;
  return (
    environment.branches.find((b) => b.name === state.selection.branch) ??
    environment.branches[0] ??
    null
  );
}

/** The page's address for what is picked, so a reload or a shared link lands on it. */
export function selectionQuery(state: PageState): string {
  const environment = currentEnvironment(state);
  const branch = currentBranch(state);
  const query = new URLSearchParams();
  if (environment) query.set('env', environment.name);
  if (branch) query.set('branch', branch.name);
  if (state.selection.tab !== 'pipeline') query.set('tab', state.selection.tab);
  const text = query.toString();
  return text ? `?${text}` : '';
}

export type Tone = 'good' | 'running' | 'bad' | 'none';

export function toneOf(environment: Pick<EnvironmentView, 'latest'>): Tone {
  const latest = environment.latest;
  if (!latest) return 'none';
  if (latest.status === 'started') return 'running';
  if (latest.status === 'failed') return 'bad';
  return 'good';
}

export interface EnvironmentTab {
  name: string;
  production: boolean;
  current: boolean;
  /** "main", "2 branches", "No branch yet". */
  detail: string;
  tone: Tone;
}

export function environmentTabs(state: PageState): EnvironmentTab[] {
  const current = currentEnvironment(state);
  return (state.data?.environments ?? []).map((environment) => ({
    name: environment.name,
    production: environment.production,
    current: environment === current,
    detail:
      environment.branches.length === 0
        ? 'No branch yet'
        : environment.branches.length === 1
          ? environment.branches[0]!.name
          : `${environment.branches.length} branches`,
    tone: toneOf(environment),
  }));
}

// ——— the environment's branches ———

export interface BranchRow {
  name: string;
  current: boolean;
  /** What the builder keeps for it, in a few words. */
  pipeline: string;
  pullRequestUrl: string | null;
  /** Set when the host no longer lists the branch. */
  gone: string | null;
}

export function branchRows(state: PageState): BranchRow[] {
  const environment = currentEnvironment(state);
  const current = currentBranch(state);
  const host = state.data?.host === 'github' ? 'GitHub' : 'Bitbucket';
  return (environment?.branches ?? []).map((branch) => ({
    name: branch.name,
    current: branch === current,
    pipeline: !branch.pipeline
      ? 'No pipeline built here yet'
      : branch.pipeline.written
        ? 'Pipeline built here, in a pull request'
        : 'Pipeline saved here, not in a pull request yet',
    pullRequestUrl: branch.pipeline?.pullRequestUrl ?? null,
    gone:
      branch.onRemote === false
        ? `${host} no longer has this branch; take it off, or push it again.`
        : null,
  }));
}

function listOf(state: PageState): ProjectEnvironment[] {
  return (state.data?.environments ?? []).map((e) => ({
    name: e.name,
    production: e.production,
    branches: e.branches.map((b) => b.name),
  }));
}

/** The builder's own branches are not ones to deploy from. */
const isBuilderBranch = (branch: string) => /^renkei\//.test(branch);

export interface AssignChoice {
  branch: string;
  /** "develop", or "develop — now on dev" when another environment has it. */
  label: string;
}

/** The remote's branches this environment does not have, each saying where it is now. */
export function assignChoices(state: PageState): AssignChoice[] {
  const environment = currentEnvironment(state);
  if (!environment || !state.data?.remoteBranches) return [];
  const list = listOf(state);
  const mine = new Set(environment.branches.map((b) => b.name));
  return state.data.remoteBranches
    .filter((branch) => !mine.has(branch) && !isBuilderBranch(branch))
    .map((branch) => {
      const owner = environmentOfBranch(list, branch);
      return { branch, label: owner ? `${branch} — now on ${owner.name}` : branch };
    });
}

/** The words on the assign button: production's one branch is replaced, not added to. */
export function assignLabel(state: PageState): string {
  const environment = currentEnvironment(state);
  return environment?.production && environment.branches.length > 0
    ? 'Replace the branch'
    : 'Assign the branch';
}

/**
 * What assigning the branch takes away, asked first: production's branch
 * replaced, or a branch moved off another environment. Null when it only adds.
 */
export function assignQuestion(state: PageState, branch: string): string | null {
  const environment = currentEnvironment(state);
  if (!environment) return null;
  const owner = environmentOfBranch(listOf(state), branch);
  const was = environment.production ? environment.branches[0]?.name : undefined;
  const parts = [
    was && was !== branch
      ? `${environment.name} is the production environment and deploys from one branch: ${branch} replaces ${was}.`
      : '',
    owner && !same(owner.name, environment.name)
      ? `${branch} is assigned to ${owner.name} now; it moves to ${environment.name}.`
      : '',
  ].filter(Boolean);
  return parts.length ? `${parts.join(' ')} Go on?` : null;
}

export interface SaveRequest {
  environments: ProjectEnvironment[];
}

export function assignRequest(state: PageState, branch: string): SaveRequest | null {
  const environment = currentEnvironment(state);
  if (!environment || !branch) return null;
  return { environments: withBranch(listOf(state), environment.name, branch) };
}

export function unassignQuestion(state: PageState, branch: string): string {
  const environment = currentEnvironment(state);
  return `Take ${branch} off ${environment?.name ?? 'the environment'}? Its pipeline file stays on the branch; Renkei stops showing it here.`;
}

export function unassignRequest(state: PageState, branch: string): SaveRequest | null {
  const environment = currentEnvironment(state);
  if (!environment) return null;
  return { environments: withoutBranch(listOf(state), environment.name, branch) };
}

// ——— adding, renaming and removing an environment ———

/** Why the form's name cannot be used; null when it can (or nothing is typed yet). */
export function formProblem(state: PageState): string | null {
  const form = state.form;
  if (!form || !form.name.trim()) return null;
  const except = form.kind === 'rename' ? currentEnvironment(state)?.name : undefined;
  return environmentNameProblem(listOf(state), form.name, except);
}

export function canSubmitForm(state: PageState): boolean {
  return (
    !state.busy && state.form !== null && !!state.form.name.trim() && formProblem(state) === null
  );
}

/** What the form sends, and the environment to show after it. */
export function formRequest(state: PageState): (SaveRequest & { select: string }) | null {
  const form = state.form;
  if (!form || !canSubmitForm(state)) return null;
  const name = form.name.trim();
  if (form.kind === 'add') {
    return { environments: withEnvironment(listOf(state), name), select: name };
  }
  const environment = currentEnvironment(state);
  if (!environment) return null;
  return { environments: renamed(listOf(state), environment.name, name), select: name };
}

/** The production environment stays; any other can go. */
export function canRemove(state: PageState): boolean {
  const environment = currentEnvironment(state);
  return Boolean(state.data?.canEdit && environment && !environment.production);
}

export function removeQuestion(state: PageState): string {
  const environment = currentEnvironment(state);
  const branches = environment?.branches.map((b) => b.name) ?? [];
  return `Remove the environment ${environment?.name ?? ''}?${
    branches.length ? ` ${branches.join(', ')} will no longer be assigned to an environment.` : ''
  } Nothing on the host changes.`;
}

export function removeRequest(state: PageState): SaveRequest | null {
  const environment = currentEnvironment(state);
  if (!environment || environment.production) return null;
  return { environments: withoutEnvironment(listOf(state), environment.name) };
}

// ——— what its pipelines last reported ———

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** “2h ago”, “6d ago”, from the clock the component passes. */
export function ago(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  return `${Math.round(days / 7)}w ago`;
}

/** The host's run as people say it: “Pipelines #412”, “Actions run 2231”. */
export function runLabel(runId: string): string {
  const [host, run = ''] = runId.split(':');
  if (!run || run.startsWith('at-'))
    return host === 'github' ? 'GitHub Actions' : 'Bitbucket Pipelines';
  return host === 'github' ? `Actions run ${run.split('.')[0]}` : `Pipelines #${run}`;
}

const STATE: Record<Tone, string> = {
  good: 'Healthy',
  running: 'Deploying',
  bad: 'Last deploy failed',
  none: 'Not deployed yet',
};

export interface DeploymentCard {
  state: string;
  tone: Tone;
  /** "8e41c2a · 2h ago · from develop", or what to do when nothing has deployed. */
  line: string;
  /** A failed deploy's reason, and what still runs. */
  note: string | null;
  runUrl: string | null;
}

export function deploymentCard(state: PageState, now: number): DeploymentCard | null {
  const environment = currentEnvironment(state);
  if (!environment) return null;
  const tone = toneOf(environment);
  const { latest, running } = environment;
  const shown = running ?? latest;
  return {
    state: STATE[tone],
    tone,
    line: shown
      ? [
          shortSha(shown.commit),
          ago(shown.startedAt, now),
          shown.branch ? `from ${shown.branch}` : '',
          shown.target ? `target ${shown.target}` : '',
        ]
          .filter(Boolean)
          .join(' · ')
      : 'Its pipelines report here when a deploy step runs.',
    note:
      latest && latest.status === 'failed'
        ? `Failed${latest.detail ? `: ${latest.detail}` : ''}; ${running ? `${shortSha(running.commit)} still runs` : 'nothing runs yet'}`
        : null,
    runUrl: shown?.runUrl ?? null,
  };
}

export interface HistoryRow {
  key: string;
  at: string;
  commit: string;
  result: string;
  tone: Tone;
  run: string;
  runUrl: string | null;
  by: string;
}

/** The picked environment's deployments, newest first. */
export function historyRows(state: PageState): HistoryRow[] {
  const environment = currentEnvironment(state);
  if (!environment) return [];
  return (state.data?.history ?? [])
    .filter((d) => same(d.environment, environment.name))
    .map((d) => ({
      key: `${d.runId}:${d.environment}`,
      at: d.startedAt,
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
      by: d.actor
        ? `${d.actor}, from ${d.branch ?? '?'}`
        : d.branch
          ? `a merge to ${d.branch}`
          : '',
    }));
}
