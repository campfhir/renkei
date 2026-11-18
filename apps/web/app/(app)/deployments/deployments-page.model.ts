/**
 * The Deployments page (deployments-page.tsx): every code project whose
 * pipeline Renkei built, each environment's running commit with what the
 * last report adds (deploying, failed, behind the environment before it),
 * which apps are ready to promote, the newest deployments, and the targets.
 * Also the words both Deployments pages share (deployment-app.model.ts uses
 * them). Tested in deployments-page.model.test.ts. The clock is passed in.
 */

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

export interface EnvironmentView {
  name: string;
  branch: string;
  latest: DeploymentView | null;
  running: DeploymentView | null;
}

export interface AppView {
  projectId: string;
  name: string;
  repo: string;
  host: 'bitbucket' | 'github';
  stack: string | null;
  canEdit: boolean;
  environments: EnvironmentView[];
}

/** What GET /api/deployments answers. */
export interface OverviewData {
  apps: AppView[];
  /** Code projects the person can open whose pipeline is not built yet. */
  unbuilt: { projectId: string; name: string; repo: string; host: 'bitbucket' | 'github' }[];
  recent: (DeploymentView & { projectId: string; app: string })[];
  targets: { name: string; online: number; total: number }[];
}

export interface OverviewState {
  data: OverviewData | null;
  error: string | null;
  /** A project id, or null for every project. */
  project: string | null;
  /** Every environment, or only those that need someone. */
  show: 'all' | 'attention';
}

export type OverviewAction =
  | { type: 'loaded'; data: OverviewData }
  | { type: 'failed'; error: string }
  | { type: 'project'; project: string | null }
  | { type: 'show'; show: OverviewState['show'] };

export const initialOverview: OverviewState = {
  data: null,
  error: null,
  project: null,
  show: 'all',
};

export function overviewReducer(state: OverviewState, action: OverviewAction): OverviewState {
  switch (action.type) {
    case 'loaded':
      return { ...state, data: action.data, error: null };
    case 'failed':
      return { ...state, error: action.error };
    case 'project':
      return { ...state, project: action.project };
    case 'show':
      return { ...state, show: action.show };
  }
}

// ——— words both pages use ———

export const HOST_LABEL = { bitbucket: 'Bitbucket', github: 'GitHub' } as const;

/** “dev” → “Dev”, “production” → “Production”. */
export function environmentLabel(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

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

export type Tone = 'good' | 'running' | 'bad' | 'none';

export interface CellNote {
  text: string;
  tone: 'warn' | 'bad' | 'info';
}

/** What a report adds to what runs: a deploy under way, one that failed, or being behind the environment before. */
export function cellNote(
  environment: EnvironmentView,
  before: EnvironmentView | null
): CellNote | null {
  const { latest, running } = environment;
  if (latest && latest.status === 'started' && latest !== running) {
    return { text: 'Deploying', tone: 'info' };
  }
  if (latest && latest.status === 'failed') {
    return {
      text: `Failed${latest.detail ? `: ${latest.detail}` : ''}; ${running ? `${shortSha(running.commit)} still runs` : 'nothing runs yet'}`,
      tone: 'bad',
    };
  }
  if (
    before?.running &&
    running &&
    before.running.commit !== running.commit &&
    Date.parse(before.running.startedAt) > Date.parse(running.startedAt)
  ) {
    return { text: `Behind ${environmentLabel(before.name)}`, tone: 'warn' };
  }
  return null;
}

export function cellTone(environment: EnvironmentView): Tone {
  const latest = environment.latest;
  if (!latest) return 'none';
  if (latest.status === 'started') return 'running';
  if (latest.status === 'failed') return 'bad';
  return 'good';
}

// ——— what the page derives ———

export interface Cell {
  name: string;
  label: string;
  branch: string;
  commit: string | null;
  when: string | null;
  target: string | null;
  tone: Tone;
  note: CellNote | null;
}

export interface Row {
  projectId: string;
  name: string;
  detail: string;
  cells: Cell[];
}

export function rows(state: OverviewState, now: number): Row[] {
  const apps = (state.data?.apps ?? []).filter(
    (app) => state.project === null || app.projectId === state.project
  );
  return apps
    .map((app) => ({
      projectId: app.projectId,
      name: app.name,
      detail: [app.stack, HOST_LABEL[app.host]].filter(Boolean).join(' · '),
      cells: app.environments.map((environment, index) => {
        const shown = environment.running ?? environment.latest;
        return {
          name: environment.name,
          label: `${environmentLabel(environment.name)} · ${environment.branch}`,
          branch: environment.branch,
          commit: shown ? shortSha(shown.commit) : null,
          when: shown ? ago(shown.startedAt, now) : null,
          target: shown?.target ?? null,
          tone: cellTone(environment),
          note: cellNote(environment, index > 0 ? app.environments[index - 1] : null),
        };
      }),
    }))
    .filter(
      (row) =>
        state.show === 'all' || row.cells.some((cell) => cell.note && cell.note.tone !== 'info')
    );
}

/** Apps whose later environment runs an older commit than the one before: a merge away from promoting. */
export function readyToPromote(
  state: OverviewState
): { projectId: string; text: string; from: string; to: string }[] {
  return (state.data?.apps ?? []).flatMap((app) =>
    app.environments.slice(1).flatMap((environment, i) => {
      const before = app.environments[i];
      const note = cellNote(environment, before);
      if (!note || !note.text.startsWith('Behind')) return [];
      return [
        {
          projectId: app.projectId,
          from: before.name,
          to: environment.name,
          text: `${app.name}: ${environmentLabel(environment.name)} runs ${shortSha(environment.running!.commit)}, ${environmentLabel(before.name)} runs ${shortSha(before.running!.commit)}. Merging ${before.branch} into ${environment.branch} is what deploys it.`,
        },
      ];
    })
  );
}

export interface RecentItem {
  key: string;
  projectId: string;
  line: string;
  result: string;
  tone: Tone;
  detail: string;
  when: string;
  runUrl: string | null;
}

const RESULT: Record<string, { word: string; tone: Tone }> = {
  started: { word: 'deploying', tone: 'running' },
  succeeded: { word: 'succeeded', tone: 'good' },
  failed: { word: 'failed', tone: 'bad' },
};

export function recentItems(state: OverviewState, now: number): RecentItem[] {
  return (state.data?.recent ?? [])
    .filter((d) => state.project === null || d.projectId === state.project)
    .map((d) => {
      const result = RESULT[d.status] ?? { word: d.status, tone: 'none' as const };
      return {
        key: `${d.projectId}:${d.runId}:${d.environment}`,
        projectId: d.projectId,
        line: `${d.app} ${shortSha(d.commit)} → ${environmentLabel(d.environment)}`,
        result: result.word,
        tone: result.tone,
        detail: [
          runLabel(d.runId),
          d.target ? `target ${d.target}` : null,
          d.status === 'failed' && d.detail ? d.detail : null,
          d.actor ? `by ${d.actor}` : d.branch ? `from ${d.branch}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
        when: ago(d.startedAt, now),
        runUrl: d.runUrl,
      };
    });
}

export function targetLines(state: OverviewState): { name: string; text: string; tone: Tone }[] {
  return (state.data?.targets ?? []).map((t) => ({
    name: t.name,
    text: t.total === 0 ? 'no runners read' : `${t.online} of ${t.total} online`,
    tone:
      t.total === 0 ? 'none' : t.online === t.total ? 'good' : t.online === 0 ? 'bad' : 'running',
  }));
}

export function projectChoices(state: OverviewState): { id: string; name: string }[] {
  return (state.data?.apps ?? []).map((app) => ({ id: app.projectId, name: app.name }));
}

/** The code projects with no pipeline yet, each a link to building one. */
export function unbuiltApps(
  state: OverviewState
): { projectId: string; name: string; detail: string; href: string }[] {
  return (state.data?.unbuilt ?? []).map((p) => ({
    projectId: p.projectId,
    name: p.name,
    detail: `${HOST_LABEL[p.host]} · ${p.repo}`,
    href: `/deployments/${p.projectId}/pipeline`,
  }));
}
