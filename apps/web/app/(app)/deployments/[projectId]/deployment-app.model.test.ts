import type { DeploymentView } from '../deployments-page.model';
import {
  appReducer,
  environmentCards,
  historyRows,
  initialApp,
  mergeQuestion,
  mergeRequest,
  promoteRequest,
  promotions,
  type AppAction,
  type AppData,
  type AppState,
} from './deployment-app.model';

const NOW = Date.parse('2026-11-18T10:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const deploy = (overrides: Partial<DeploymentView>): DeploymentView => ({
  environment: 'dev',
  status: 'succeeded',
  commit: '8e41c2a0000',
  branch: 'develop',
  target: 'onprem-app',
  runId: 'bitbucket:387',
  runUrl: 'https://bitbucket.org/acme/portal-web/pipelines/results/387',
  detail: null,
  actor: null,
  startedAt: hoursAgo(2),
  finishedAt: hoursAgo(2),
  ...overrides,
});
const dev = deploy({});
const failed = deploy({
  status: 'failed',
  commit: '71c0b3e0000',
  runId: 'bitbucket:381',
  detail: 'exit code 1',
  startedAt: hoursAgo(18),
});
const prod = deploy({
  environment: 'production',
  commit: '3b07d9f0000',
  branch: 'main',
  runId: 'bitbucket:362',
  startedAt: hoursAgo(144),
});

const data: AppData = {
  projectId: 'p1',
  name: 'portal-web',
  repo: 'acme/portal-web',
  host: 'bitbucket',
  stack: 'Node',
  canEdit: true,
  environments: [
    { name: 'dev', branch: 'develop', latest: dev, running: dev },
    { name: 'production', branch: 'main', latest: prod, running: prod },
  ],
  promotions: [
    {
      from: 'dev',
      to: 'production',
      fromBranch: 'develop',
      toBranch: 'main',
      ahead: {
        count: 2,
        more: false,
        commits: [
          { sha: '8e41c2a0000', message: 'Show the intake status', author: 'Priya Shah' },
          { sha: '71c0b3e0000', message: 'Retry the address lookup', author: 'Jordan Lee' },
        ],
      },
      pullRequest: {
        number: 57,
        title: 'Promote dev to production',
        url: 'https://bitbucket.org/acme/portal-web/pull-requests/57',
        checks: 'SUCCESSFUL',
      },
      error: null,
    },
  ],
  history: [dev, failed, prod],
};

const run = (actions: AppAction[], start: AppState = initialApp) =>
  actions.reduce(appReducer, start);
const loaded = run([{ type: 'loaded', data }]);

describe('the environments', () => {
  it('say what runs, how the pipeline deploys it, and that production is behind', () => {
    expect(
      environmentCards(loaded, NOW).map((c) => [
        c.label,
        c.state,
        c.commit,
        c.when,
        c.how,
        c.note?.text ?? null,
      ])
    ).toEqual([
      [
        'Dev',
        'Healthy',
        '8e41c2a',
        '2h ago',
        'Deployed by the pipeline on every merge to develop · target onprem-app',
        null,
      ],
      [
        'Production',
        'Healthy',
        '3b07d9f',
        '6d ago',
        'Deployed by the pipeline on every merge to main · target onprem-app',
        'Behind Dev',
      ],
    ]);
  });
});

describe('promoting', () => {
  it('says what merging brings, the checks, and offers the merge', () => {
    expect(promotions(loaded, NOW)).toEqual([
      {
        key: 'dev-production',
        from: 'dev',
        to: 'production',
        title: 'Promote to Production: merge develop into main',
        summary:
          'Production runs 3b07d9f; merging brings 2 commits from develop, which Dev has run since 2h ago.',
        commits: [
          { sha: '8e41c2a', message: 'Show the intake status', author: 'Priya Shah' },
          { sha: '71c0b3e', message: 'Retry the address lookup', author: 'Jordan Lee' },
        ],
        moreCommits: false,
        checks: { text: 'Checks passed on the pull request', tone: 'good' },
        pullRequest: {
          number: 57,
          label: 'Pull request #57 on Bitbucket',
          url: 'https://bitbucket.org/acme/portal-web/pull-requests/57',
        },
        action: { kind: 'merge', label: 'Merge to main', number: 57 },
        error: null,
      },
    ]);
  });

  it('asks before merging, since a merge deploys; no means nothing is sent', () => {
    const asked = run([{ type: 'askMerge', from: 'dev', to: 'production', number: 57 }], loaded);
    expect(mergeQuestion(asked)).toBe(
      'Merge pull request #57 into main? The pipeline on main deploys Production when it does.'
    );
    expect(mergeRequest(asked)).toEqual({ from: 'dev', to: 'production', number: 57 });
    const cancelled = run([{ type: 'cancelMerge' }], asked);
    expect(mergeRequest(cancelled)).toBeNull();
  });

  it('offers to open the pull request when there is none, and nothing when there is nothing to bring', () => {
    const none = { ...data.promotions[0], pullRequest: null };
    const open = run([{ type: 'loaded', data: { ...data, promotions: [none] } }]);
    expect(promotions(open, NOW)[0].action).toEqual({
      kind: 'open',
      label: 'Open a pull request: develop → main',
    });
    expect(promoteRequest('dev', 'production')).toEqual({ from: 'dev', to: 'production' });
    const even = run([
      {
        type: 'loaded',
        data: { ...data, promotions: [{ ...none, ahead: { count: 0, more: false, commits: [] } }] },
      },
    ]);
    expect(promotions(even, NOW)[0]).toMatchObject({
      summary: 'main has everything develop has: nothing to promote.',
      action: { kind: 'none', why: 'Nothing to promote.' },
    });
  });

  it('lets a viewer see, and promote nothing', () => {
    const viewer = run([{ type: 'loaded', data: { ...data, canEdit: false } }]);
    expect(promotions(viewer, NOW)[0].action).toEqual({
      kind: 'none',
      why: 'Only the project’s editors promote it.',
    });
  });

  it('a refused merge keeps the page, with the host’s words; a done one reloads with a notice', () => {
    const refused = run(
      [
        { type: 'askMerge', from: 'dev', to: 'production', number: 57 },
        { type: 'sent', busy: 'merge' },
        { type: 'failed', error: 'Bitbucket refused: 1 approval required' },
      ],
      loaded
    );
    expect(refused).toMatchObject({ busy: null, error: 'Bitbucket refused: 1 approval required' });
    const done = run(
      [{ type: 'loaded', data, notice: 'Merged #57: the pipeline on main deploys Production.' }],
      refused
    );
    expect(done).toMatchObject({
      notice: 'Merged #57: the pipeline on main deploys Production.',
      confirming: null,
    });
  });
});

describe('the history', () => {
  it('lists each deployment with its run and outcome', () => {
    expect(
      historyRows(loaded).map((r) => [r.environment, r.commit, r.result, r.run, r.by])
    ).toEqual([
      ['Dev', '8e41c2a', 'Succeeded', 'Pipelines #387', 'a merge to develop'],
      ['Dev', '71c0b3e', 'Failed — exit code 1', 'Pipelines #381', 'a merge to develop'],
      ['Production', '3b07d9f', 'Succeeded', 'Pipelines #362', 'a merge to main'],
    ]);
  });
});
