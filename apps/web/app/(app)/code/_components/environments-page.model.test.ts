import {
  ago,
  assignChoices,
  assignLabel,
  assignQuestion,
  assignRequest,
  branchRows,
  canRemove,
  canSubmitForm,
  currentBranch,
  currentEnvironment,
  deploymentCard,
  environmentTabs,
  formProblem,
  formRequest,
  historyRows,
  initialPage,
  pageReducer,
  readTab,
  removeQuestion,
  removeRequest,
  runLabel,
  selectionQuery,
  unassignQuestion,
  unassignRequest,
  type DeploymentView,
  type EnvironmentsData,
  type PageAction,
  type PageState,
} from './environments-page.model';

const NOW = Date.parse('2026-11-24T12:00:00Z');

function deployment(patch: Partial<DeploymentView>): DeploymentView {
  return {
    environment: 'dev',
    status: 'succeeded',
    commit: '8e41c2a9f0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5',
    branch: 'develop',
    target: 'web-1',
    runId: 'bitbucket:101',
    runUrl: 'https://bitbucket.org/acme/app/pipelines/results/101',
    detail: null,
    actor: null,
    startedAt: '2026-11-24T10:00:00Z',
    finishedAt: '2026-11-24T10:03:00Z',
    ...patch,
  };
}

const devRun = deployment({});
const DATA: EnvironmentsData = {
  host: 'bitbucket',
  project: { name: 'Billing', repo: 'acme/app' },
  canEdit: true,
  environments: [
    {
      name: 'production',
      production: true,
      branches: [{ name: 'main', onRemote: true, pipeline: null }],
      latest: null,
      running: null,
    },
    {
      name: 'dev',
      production: false,
      branches: [
        {
          name: 'develop',
          onRemote: true,
          pipeline: {
            pullRequestUrl: 'https://bitbucket.org/acme/app/pull-requests/3',
            written: true,
          },
        },
        {
          name: 'feature/intake',
          onRemote: false,
          pipeline: { pullRequestUrl: null, written: false },
        },
      ],
      latest: devRun,
      running: devRun,
    },
    { name: 'staging', production: false, branches: [], latest: null, running: null },
  ],
  remoteBranches: ['main', 'develop', 'release/2.0', 'renkei/pipeline', 'hotfix'],
  branchesError: null,
  history: [devRun, deployment({ environment: 'production', runId: 'bitbucket:90' })],
};

function page(
  selection: Partial<PageState['selection']> = {},
  ...actions: PageAction[]
): PageState {
  const start = initialPage({ environment: null, branch: null, tab: 'pipeline', ...selection });
  const loaded: PageAction = { type: 'loaded', data: DATA };
  return [loaded, ...actions].reduce(pageReducer, start);
}

describe('what is picked', () => {
  it('opens on the production environment and its branch', () => {
    const state = page();
    expect(currentEnvironment(state)?.name).toBe('production');
    expect(currentBranch(state)?.name).toBe('main');
    expect(selectionQuery(state)).toBe('?env=production&branch=main');
  });

  it('opens on what the address names', () => {
    const state = page({ environment: 'DEV', branch: 'feature/intake', tab: 'variables' });
    expect(currentEnvironment(state)?.name).toBe('dev');
    expect(currentBranch(state)?.name).toBe('feature/intake');
    expect(selectionQuery(state)).toBe('?env=dev&branch=feature%2Fintake&tab=variables');
  });

  it('a branch the environment does not have falls back to its first', () => {
    expect(currentBranch(page({ environment: 'dev', branch: 'main' }))?.name).toBe('develop');
  });

  it('picking an environment shows its first branch; picking a tab keeps both', () => {
    const state = page(
      {},
      { type: 'environmentPicked', name: 'dev' },
      { type: 'tabPicked', tab: 'runs' }
    );
    expect(currentBranch(state)?.name).toBe('develop');
    expect(state.selection.tab).toBe('runs');
    const other = pageReducer(state, { type: 'branchPicked', branch: 'feature/intake' });
    expect(selectionQuery(other)).toBe('?env=dev&branch=feature%2Fintake&tab=runs');
  });

  it('an environment with no branch has no pipeline, runs or variables to show yet', () => {
    const state = page({ environment: 'staging' });
    expect(currentBranch(state)).toBeNull();
    expect(selectionQuery(state)).toBe('?env=staging');
  });

  it('reads a tab from the address, the pipeline when it names none', () => {
    expect(readTab('variables')).toBe('variables');
    expect(readTab('runs')).toBe('runs');
    expect(readTab('nonsense')).toBe('pipeline');
    expect(readTab(null)).toBe('pipeline');
  });
});

describe('the environments', () => {
  it('each says its branches, and which is the production one', () => {
    expect(environmentTabs(page({ environment: 'dev' }))).toEqual([
      { name: 'production', production: true, current: false, detail: 'main', tone: 'none' },
      { name: 'dev', production: false, current: true, detail: '2 branches', tone: 'good' },
      { name: 'staging', production: false, current: false, detail: 'No branch yet', tone: 'none' },
    ]);
  });

  it('a branch links to its pipeline’s pull request, and says when the remote has dropped it', () => {
    expect(branchRows(page({ environment: 'dev' }))).toEqual([
      {
        name: 'develop',
        current: true,
        pullRequestUrl: 'https://bitbucket.org/acme/app/pull-requests/3',
        gone: null,
      },
      {
        name: 'feature/intake',
        current: false,
        pullRequestUrl: null,
        gone: 'Bitbucket no longer has this branch; take it off, or push it again.',
      },
    ]);
    expect(branchRows(page())[0]?.pullRequestUrl).toBeNull();
  });
});

describe('assigning a branch', () => {
  it('offers the remote’s branches the environment does not have, saying where each is now', () => {
    expect(assignChoices(page({ environment: 'staging' }))).toEqual([
      { branch: 'main', label: 'main — now on production' },
      { branch: 'develop', label: 'develop — now on dev' },
      { branch: 'release/2.0', label: 'release/2.0' },
      { branch: 'hotfix', label: 'hotfix' },
    ]);
  });

  it('never offers the builder’s own branches', () => {
    expect(
      assignChoices(page({ environment: 'staging' })).map((choice) => choice.branch)
    ).not.toContain('renkei/pipeline');
  });

  it('adds to an environment, without a question', () => {
    const state = page({ environment: 'staging' });
    expect(assignLabel(state)).toBe('Assign the branch');
    expect(assignQuestion(state, 'hotfix')).toBeNull();
    expect(assignRequest(state, 'hotfix')?.environments[2]).toEqual({
      name: 'staging',
      production: false,
      branches: ['hotfix'],
    });
  });

  it('production deploys from one branch: another replaces it, after asking', () => {
    const state = page();
    expect(assignLabel(state)).toBe('Replace the branch');
    expect(assignQuestion(state, 'release/2.0')).toBe(
      'production is the production environment and deploys from one branch: release/2.0 replaces main. Go on?'
    );
    expect(assignRequest(state, 'release/2.0')?.environments[0]).toEqual({
      name: 'production',
      production: true,
      branches: ['release/2.0'],
    });
  });

  it('a branch another environment has moves, after asking', () => {
    const state = page({ environment: 'staging' });
    expect(assignQuestion(state, 'develop')).toBe(
      'develop is assigned to dev now; it moves to staging. Go on?'
    );
    const sent = assignRequest(state, 'develop')!.environments;
    expect(sent[1]?.branches).toEqual(['feature/intake']);
    expect(sent[2]?.branches).toEqual(['develop']);
  });

  it('taking production’s branch from another environment says both', () => {
    expect(assignQuestion(page(), 'develop')).toBe(
      'production is the production environment and deploys from one branch: develop replaces main. develop is assigned to dev now; it moves to production. Go on?'
    );
  });

  it('taking a branch off asks first, and leaves the rest', () => {
    const state = page({ environment: 'dev' });
    expect(unassignQuestion(state, 'develop')).toBe(
      'Take develop off dev? Its pipeline file stays on the branch; Renkei stops showing it here.'
    );
    expect(unassignRequest(state, 'develop')?.environments[1]?.branches).toEqual([
      'feature/intake',
    ]);
  });

  it('the pick in the list is kept until the save answers', () => {
    const picked = page({}, { type: 'assignPicked', branch: 'hotfix' });
    expect(picked.picked).toBe('hotfix');
    expect(pageReducer(picked, { type: 'saved', data: DATA }).picked).toBe('');
  });
});

describe('adding, renaming and removing', () => {
  it('a new environment is named as the project likes and shown once saved', () => {
    const state = page(
      {},
      { type: 'formOpened', kind: 'add' },
      { type: 'formChanged', name: ' test ' }
    );
    expect(canSubmitForm(state)).toBe(true);
    const request = formRequest(state)!;
    expect(request.select).toBe('test');
    expect(request.environments.at(-1)).toEqual({ name: 'test', production: false, branches: [] });
  });

  it('a name already taken, or not a name, cannot be sent', () => {
    const taken = page(
      {},
      { type: 'formOpened', kind: 'add' },
      { type: 'formChanged', name: 'Dev' }
    );
    expect(formProblem(taken)).toBe('There is already an environment named Dev.');
    expect(canSubmitForm(taken)).toBe(false);
    expect(formRequest(taken)).toBeNull();
    const empty = page({}, { type: 'formOpened', kind: 'add' });
    expect(formProblem(empty)).toBeNull();
    expect(canSubmitForm(empty)).toBe(false);
  });

  it('renaming starts from the name it has, and keeps its branches and its being production', () => {
    const state = page({}, { type: 'formOpened', kind: 'rename' });
    expect(state.form).toEqual({ kind: 'rename', name: 'production' });
    const typed = pageReducer(state, { type: 'formChanged', name: 'live' });
    expect(formRequest(typed)?.environments[0]).toEqual({
      name: 'live',
      production: true,
      branches: ['main'],
    });
    // Its own name in another case is not "taken".
    expect(formProblem(pageReducer(state, { type: 'formChanged', name: 'Production' }))).toBeNull();
  });

  it('the production environment stays; another can go, after asking', () => {
    expect(canRemove(page())).toBe(false);
    expect(removeRequest(page())).toBeNull();
    const dev = page({ environment: 'dev' });
    expect(canRemove(dev)).toBe(true);
    expect(removeQuestion(dev)).toBe(
      'Remove the environment dev? develop, feature/intake will no longer be assigned to an environment. Nothing on the host changes.'
    );
    expect(removeRequest(dev)?.environments.map((e) => e.name)).toEqual(['production', 'staging']);
  });

  it('a viewer removes nothing', () => {
    const viewer = pageReducer(initialPage({ environment: 'dev', branch: null, tab: 'pipeline' }), {
      type: 'loaded',
      data: { ...DATA, canEdit: false },
    });
    expect(canRemove(viewer)).toBe(false);
  });
});

describe('a change on its way', () => {
  it('is busy until it answers; a refusal says each rule broken and keeps the form', () => {
    const typed = page(
      {},
      { type: 'formOpened', kind: 'add' },
      { type: 'formChanged', name: 'qa' }
    );
    const sent = pageReducer(typed, { type: 'sent' });
    expect(sent.busy).toBe(true);
    expect(canSubmitForm(sent)).toBe(false);
    const failed = pageReducer(sent, {
      type: 'failed',
      error: 'The repository has no branch made-up.',
      problems: ['The repository has no branch made-up.', 'Another rule.'],
    });
    expect(failed).toMatchObject({ busy: false, error: 'The repository has no branch made-up.' });
    expect(failed.problems).toHaveLength(2);
    expect(failed.form?.name).toBe('qa');
  });

  it('once saved, shows what the server has, on what was asked to be picked', () => {
    const typed = page(
      {},
      { type: 'formOpened', kind: 'add' },
      { type: 'formChanged', name: 'qa' }
    );
    const after: EnvironmentsData = {
      ...DATA,
      environments: [
        ...DATA.environments,
        { name: 'qa', production: false, branches: [], latest: null, running: null },
      ],
    };
    const saved = pageReducer(pageReducer(typed, { type: 'sent' }), {
      type: 'saved',
      data: after,
      select: { environment: 'qa', branch: null },
    });
    expect(saved.form).toBeNull();
    expect(saved.busy).toBe(false);
    expect(currentEnvironment(saved)?.name).toBe('qa');
  });

  it('a removed environment falls back to production', () => {
    const removed = pageReducer(page({ environment: 'staging' }), {
      type: 'saved',
      data: { ...DATA, environments: DATA.environments.slice(0, 2) },
      select: { environment: null, branch: null },
    });
    expect(currentEnvironment(removed)?.name).toBe('production');
  });

  it('a read that fails says so', () => {
    const failed = pageReducer(initialPage({ environment: null, branch: null, tab: 'pipeline' }), {
      type: 'loadFailed',
      error: 'Connect Bitbucket first.',
    });
    expect(failed.loadError).toBe('Connect Bitbucket first.');
  });
});

describe('what its pipelines last reported', () => {
  it('a healthy environment says what runs, since when, from which branch and where', () => {
    expect(deploymentCard(page({ environment: 'dev' }), NOW)).toEqual({
      state: 'Healthy',
      tone: 'good',
      line: '8e41c2a · 2h ago · from develop · target web-1',
      note: null,
      runUrl: 'https://bitbucket.org/acme/app/pipelines/results/101',
    });
  });

  it('one never deployed says how reports get here', () => {
    expect(deploymentCard(page(), NOW)).toMatchObject({
      state: 'Not deployed yet',
      tone: 'none',
      line: 'Its pipelines report here when a deploy step runs.',
    });
  });

  it('a failed deploy says why, and what still runs', () => {
    const failed = deployment({
      status: 'failed',
      commit: 'ffffffff00000000',
      detail: 'health check',
      startedAt: '2026-11-24T11:30:00Z',
    });
    const data: EnvironmentsData = {
      ...DATA,
      environments: DATA.environments.map((e) =>
        e.name === 'dev' ? { ...e, latest: failed, running: devRun } : e
      ),
    };
    const state = pageReducer(initialPage({ environment: 'dev', branch: null, tab: 'pipeline' }), {
      type: 'loaded',
      data,
    });
    expect(deploymentCard(state, NOW)).toMatchObject({
      state: 'Last deploy failed',
      tone: 'bad',
      note: 'Failed: health check; 8e41c2a still runs',
    });
  });

  it('a deploy under way reads as deploying', () => {
    const started = deployment({ status: 'started', finishedAt: null });
    const data: EnvironmentsData = {
      ...DATA,
      environments: DATA.environments.map((e) =>
        e.name === 'dev' ? { ...e, latest: started, running: null } : e
      ),
    };
    const state = pageReducer(initialPage({ environment: 'dev', branch: null, tab: 'pipeline' }), {
      type: 'loaded',
      data,
    });
    expect(deploymentCard(state, NOW)?.state).toBe('Deploying');
  });

  it('the history is the picked environment’s alone', () => {
    expect(historyRows(page({ environment: 'dev' }))).toEqual([
      {
        key: 'bitbucket:101:dev',
        at: '2026-11-24T10:00:00Z',
        commit: '8e41c2a',
        result: 'Succeeded',
        tone: 'good',
        run: 'Pipelines #101',
        runUrl: 'https://bitbucket.org/acme/app/pipelines/results/101',
        by: 'a merge to develop',
      },
    ]);
    expect(historyRows(page()).map((row) => row.run)).toEqual(['Pipelines #90']);
    expect(historyRows(page({ environment: 'staging' }))).toEqual([]);
  });

  it('names a run as its host does, and a time as people say it', () => {
    expect(runLabel('github:2231.1')).toBe('Actions run 2231');
    expect(runLabel('github:at-1700000000')).toBe('GitHub Actions');
    expect(runLabel('bitbucket:')).toBe('Bitbucket Pipelines');
    expect(ago('2026-11-24T11:59:40Z', NOW)).toBe('just now');
    expect(ago('2026-11-24T11:15:00Z', NOW)).toBe('45m ago');
    expect(ago('2026-11-18T12:00:00Z', NOW)).toBe('6d ago');
    expect(ago('2026-10-20T12:00:00Z', NOW)).toBe('5w ago');
  });
});
