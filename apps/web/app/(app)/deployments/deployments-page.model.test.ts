import {
  ago,
  initialOverview,
  overviewReducer,
  readyToPromote,
  recentItems,
  rows,
  runLabel,
  targetLines,
  type DeploymentView,
  type OverviewAction,
  type OverviewData,
  type OverviewState,
} from './deployments-page.model';

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

const devGood = deploy({});
const prodGood = deploy({
  environment: 'production',
  commit: '3b07d9f0000',
  branch: 'main',
  runId: 'bitbucket:362',
  startedAt: hoursAgo(144),
});
const data: OverviewData = {
  apps: [
    {
      projectId: 'p1',
      name: 'portal-web',
      repo: 'acme/portal-web',
      host: 'bitbucket',
      stack: 'Node',
      canEdit: true,
      environments: [
        { name: 'dev', branch: 'develop', latest: devGood, running: devGood },
        { name: 'production', branch: 'main', latest: prodGood, running: prodGood },
      ],
    },
    {
      projectId: 'p2',
      name: 'sync-worker',
      repo: 'acme/sync-worker',
      host: 'github',
      stack: 'Go',
      canEdit: false,
      environments: [
        {
          name: 'dev',
          branch: 'develop',
          latest: deploy({
            status: 'started',
            commit: 'c19e5b00000',
            runId: 'github:2231.1',
            startedAt: hoursAgo(0.4),
          }),
          running: deploy({
            commit: '5d2a8c10000',
            runId: 'github:2229.1',
            startedAt: hoursAgo(3),
          }),
        },
        {
          name: 'production',
          branch: 'main',
          latest: deploy({
            environment: 'production',
            status: 'failed',
            detail: 'exit code 1',
            runId: 'github:2230.1',
            startedAt: hoursAgo(1),
          }),
          running: null,
        },
      ],
    },
  ],
  recent: [
    {
      ...deploy({
        status: 'started',
        runId: 'github:2231.1',
        actor: 'jordan',
        startedAt: hoursAgo(0.4),
      }),
      projectId: 'p2',
      app: 'sync-worker',
    },
    { ...devGood, projectId: 'p1', app: 'portal-web' },
  ],
  targets: [
    { name: 'onprem-app', online: 3, total: 3 },
    { name: 'onprem-workers', online: 1, total: 2 },
    { name: 'azure-later', online: 0, total: 0 },
  ],
};

const run = (actions: OverviewAction[], start: OverviewState = initialOverview) =>
  actions.reduce(overviewReducer, start);
const loaded = run([{ type: 'loaded', data }]);

describe('what runs where', () => {
  it('shows each environment’s running commit, its age and target, and what the last report adds', () => {
    expect(
      rows(loaded, NOW).map((r) => [
        r.name,
        r.detail,
        r.cells.map((c) => [c.label, c.commit, c.when, c.tone, c.note?.text ?? null]),
      ])
    ).toEqual([
      [
        'portal-web',
        'Node · Bitbucket',
        [
          ['Dev · develop', '8e41c2a', '2h ago', 'good', null],
          ['Production · main', '3b07d9f', '6d ago', 'good', 'Behind Dev'],
        ],
      ],
      [
        'sync-worker',
        'Go · GitHub',
        [
          ['Dev · develop', '5d2a8c1', '3h ago', 'running', 'Deploying'],
          [
            'Production · main',
            '8e41c2a',
            '1h ago',
            'bad',
            'Failed: exit code 1; nothing runs yet',
          ],
        ],
      ],
    ]);
  });

  it('filters to one project, or to the environments that need someone', () => {
    expect(rows(run([{ type: 'project', project: 'p2' }], loaded), NOW).map((r) => r.name)).toEqual(
      ['sync-worker']
    );
    // A deploy under way needs nobody; a failure or being behind does.
    expect(
      rows(run([{ type: 'show', show: 'attention' }], loaded), NOW).map((r) => r.name)
    ).toEqual(['portal-web', 'sync-worker']);
  });

  it('names what is a merge away from promoting', () => {
    expect(readyToPromote(loaded)).toEqual([
      {
        projectId: 'p1',
        from: 'dev',
        to: 'production',
        text: 'portal-web: Production runs 3b07d9f, Dev runs 8e41c2a. Merging develop into main is what deploys it.',
      },
    ]);
  });
});

describe('the rest of the page', () => {
  it('lists the newest deployments in words', () => {
    expect(recentItems(loaded, NOW).map((i) => [i.line, i.result, i.detail, i.when])).toEqual([
      [
        'sync-worker 8e41c2a → Dev',
        'deploying',
        'Actions run 2231 · target onprem-app · by jordan',
        '24m ago',
      ],
      [
        'portal-web 8e41c2a → Dev',
        'succeeded',
        'Pipelines #387 · target onprem-app · from develop',
        '2h ago',
      ],
    ]);
  });

  it('says how each target’s runners are', () => {
    expect(targetLines(loaded)).toEqual([
      { name: 'onprem-app', text: '3 of 3 online', tone: 'good' },
      { name: 'onprem-workers', text: '1 of 2 online', tone: 'running' },
      { name: 'azure-later', text: 'no runners read', tone: 'none' },
    ]);
  });

  it('tells times and runs as people say them', () => {
    expect([ago(hoursAgo(0), NOW), ago(hoursAgo(50), NOW), ago(hoursAgo(24 * 20), NOW)]).toEqual([
      'just now',
      '2d ago',
      '3w ago',
    ]);
    expect([runLabel('bitbucket:412'), runLabel('github:2231.2'), runLabel('github:at-1')]).toEqual(
      ['Pipelines #412', 'Actions run 2231', 'GitHub Actions']
    );
  });
});
