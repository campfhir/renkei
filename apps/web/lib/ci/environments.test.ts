/**
 * A code project's environments on the server, on the memory store with
 * the host's branch list scripted: the list a project starts with and the
 * one it keeps; saving it against the branches the remote has (asked only
 * when a branch is newly assigned); and the Environments page's data —
 * each branch with what the builder keeps for it, and what the pipelines'
 * deploy steps last reported for each environment.
 */

jest.mock('@/lib/code/repo-host-github', () => ({ githubHostAdapter: jest.fn() }));
jest.mock('@/lib/code/repo-host-bitbucket', () => ({ bitbucketHostAdapter: jest.fn() }));

import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import type { ProjectEnvironment } from './environment-rules';
import {
  environmentChanges,
  environmentsPage,
  projectEnvironments,
  remoteBranches,
  saveEnvironments,
} from './environments';

const github = jest.requireMock<{ githubHostAdapter: jest.Mock }>('@/lib/code/repo-host-github');
const bitbucket = jest.requireMock<{ bitbucketHostAdapter: jest.Mock }>(
  '@/lib/code/repo-host-bitbucket'
);

const caller = { subject: 'auth0|ada', origin: 'https://renkei.example' };
const project = {
  id: '00000000-0000-4000-8000-000000000e01',
  name: 'sync-worker',
  repo: { fullName: 'acme/sync-worker', branch: 'main' },
};

/** The host lists these branches; answers the mock so a test can count the asks. */
function remoteHas(...names: string[]): jest.Mock {
  const listBranches = jest.fn(async () => ({
    ok: true,
    branches: names.map((name) => ({ name, headSha: `${name}-sha` })),
  }));
  github.githubHostAdapter.mockReturnValue({ listBranches });
  bitbucket.bitbucketHostAdapter.mockReturnValue({ listBranches });
  return listBranches;
}

function remoteFails(error: string): void {
  const listBranches = jest.fn(async () => ({ ok: false, error }));
  github.githubHostAdapter.mockReturnValue({ listBranches });
  bitbucket.bitbucketHostAdapter.mockReturnValue({ listBranches });
}

const stored = async (list: ProjectEnvironment[]) =>
  getDataStore().ciEnvironments.replace(project.id, list, caller.subject);

const usual: ProjectEnvironment[] = [
  { name: 'production', production: true, branches: ['main'] },
  { name: 'dev', production: false, branches: ['develop'] },
];

beforeEach(() => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
});
afterEach(() => resetDataStore());

describe('a project’s environments', () => {
  it('start as its production environment, with no branch', async () => {
    expect(await projectEnvironments(project.id)).toEqual([
      { name: 'production', production: true, branches: [] },
    ]);
  });

  it('are the list it saved, in its order', async () => {
    await stored([usual[1]!, usual[0]!]);
    expect(await projectEnvironments(project.id)).toEqual([usual[1], usual[0]]);
  });

  it('a stored list is held to the rules: one production environment, with one branch', async () => {
    await stored([
      { name: 'dev', production: false, branches: ['develop'] },
      { name: 'Production', production: false, branches: ['main'] },
    ]);
    expect((await projectEnvironments(project.id)).map((e) => [e.name, e.production])).toEqual([
      ['dev', false],
      ['Production', true],
    ]);
    await stored([{ name: 'live', production: true, branches: ['main', 'release'] }]);
    expect(await projectEnvironments(project.id)).toEqual([
      { name: 'live', production: true, branches: ['main'] },
    ]);
  });
});

describe('the repository’s branches', () => {
  it('are read from the project’s host, with the person’s grant', async () => {
    remoteHas('main', 'develop');
    expect(await remoteBranches('github', caller, 'acme/sync-worker')).toEqual({
      ok: true,
      branches: ['main', 'develop'],
    });
    expect(github.githubHostAdapter).toHaveBeenCalledWith(caller);
    expect(bitbucket.bitbucketHostAdapter).not.toHaveBeenCalled();
    await remoteBranches('bitbucket', caller, 'acme/sync-worker');
    expect(bitbucket.bitbucketHostAdapter).toHaveBeenCalledWith(caller);
  });
});

describe('saving the list', () => {
  it('assigns a branch the remote has, and says what was there before', async () => {
    remoteHas('main', 'develop');
    const saved = await saveEnvironments('github', caller, project, usual);
    expect(saved).toEqual({
      ok: true,
      environments: usual,
      before: [{ name: 'production', production: true, branches: [] }],
    });
    expect(await projectEnvironments(project.id)).toEqual(usual);
    expect((await getDataStore().ciEnvironments.list(project.id))[0]?.updatedBy).toBe(
      caller.subject
    );
  });

  it('refuses a branch the remote does not have, and saves nothing', async () => {
    remoteHas('main');
    const saved = await saveEnvironments('github', caller, project, usual);
    expect(saved).toEqual({
      ok: false,
      problems: [
        'The repository has no branch develop; an environment is assigned branches that exist on the remote.',
      ],
    });
    expect(await getDataStore().ciEnvironments.list(project.id)).toEqual([]);
  });

  it('refuses to assign while the host cannot list its branches', async () => {
    remoteFails('Connect GitHub on the Connectors page first.');
    expect(await saveEnvironments('github', caller, project, usual)).toEqual({
      ok: false,
      problems: [
        'The repository’s branches could not be listed, so none can be assigned: Connect GitHub on the Connectors page first.',
      ],
    });
    expect(await getDataStore().ciEnvironments.list(project.id)).toEqual([]);
  });

  it('asks the host only when a branch is newly assigned', async () => {
    await stored(usual);
    const asked = remoteHas('main', 'develop');
    // Renaming, adding an environment, taking a branch off, moving one: no branch is new.
    const next: ProjectEnvironment[] = [
      { name: 'live', production: true, branches: ['main'] },
      { name: 'dev', production: false, branches: [] },
      { name: 'staging', production: false, branches: ['develop'] },
    ];
    expect(await saveEnvironments('github', caller, project, next)).toMatchObject({ ok: true });
    expect(asked).not.toHaveBeenCalled();
    expect(await projectEnvironments(project.id)).toEqual(next);
  });

  it('keeps a branch assigned before that the remote has since dropped, so it can still be taken off', async () => {
    await stored([
      usual[0]!,
      { name: 'dev', production: false, branches: ['develop', 'feature/gone'] },
    ]);
    remoteHas('main', 'develop', 'release');
    const kept: ProjectEnvironment[] = [
      usual[0]!,
      { name: 'dev', production: false, branches: ['develop', 'feature/gone', 'release'] },
    ];
    expect(await saveEnvironments('github', caller, project, kept)).toMatchObject({ ok: true });
    const off: ProjectEnvironment[] = [
      usual[0]!,
      { name: 'dev', production: false, branches: ['develop', 'release'] },
    ];
    expect(await saveEnvironments('github', caller, project, off)).toMatchObject({ ok: true });
    expect((await projectEnvironments(project.id))[1]?.branches).toEqual(['develop', 'release']);
  });

  it('a list that breaks a rule comes back with each one, and what was saved stays', async () => {
    await stored(usual);
    remoteHas('main', 'develop', 'release');
    const saved = await saveEnvironments('github', caller, project, [
      { name: 'production', production: true, branches: ['main', 'release'] },
      { name: 'dev', production: false, branches: ['develop', 'main'] },
      { name: 'Dev', production: true, branches: [] },
    ]);
    expect(saved).toEqual({
      ok: false,
      problems: [
        'Two environments are named Dev.',
        'Only one environment is the production one; production and Dev are both marked so.',
        'production is the production environment and deploys from one branch; it was given main and release.',
        'main is assigned to both production and dev; a branch deploys one environment.',
      ],
    });
    expect(await projectEnvironments(project.id)).toEqual(usual);
  });

  it('a project cannot be left without its production environment', async () => {
    await stored(usual);
    expect(await saveEnvironments('github', caller, project, [usual[1]!])).toEqual({
      ok: false,
      problems: ['One environment is the production one; none is marked so.'],
    });
  });
});

describe('the Environments page', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 18, 10, minute));
  const report = (
    environment: string,
    status: 'started' | 'succeeded' | 'failed',
    commitSha: string,
    run: string,
    when: Date,
    branch = 'develop'
  ) =>
    getDataStore().ciDeployments.record({
      projectId: project.id,
      environment,
      status,
      commitSha,
      branch,
      target: 'onprem-app',
      runId: `github:${run}`,
      runUrl: `https://github.com/acme/sync-worker/actions/runs/${run}`,
      detail: status === 'failed' ? 'health check' : null,
      actor: 'jordan',
      at: when,
    });

  it('a project that set nothing up shows its production environment and the remote’s branches', async () => {
    remoteHas('main', 'develop');
    expect(await environmentsPage('github', caller, project, true)).toEqual({
      host: 'github',
      project: { name: 'sync-worker', repo: 'acme/sync-worker' },
      canEdit: true,
      environments: [
        { name: 'production', production: true, branches: [], latest: null, running: null },
      ],
      remoteBranches: ['main', 'develop'],
      branchesError: null,
      history: [],
    });
  });

  it('shows each branch: whether the remote still has it, and what the builder keeps for it', async () => {
    await stored([
      usual[0]!,
      { name: 'dev', production: false, branches: ['develop', 'feature/gone'] },
    ]);
    const pipelines = getDataStore().ciPipelines;
    const spec = { checks: [], environments: [] };
    await pipelines.save(project.id, 'main', { host: 'github', spec, updatedBy: caller.subject });
    await pipelines.markWritten(project.id, 'main', {
      text: 'name: Pipeline\n',
      pullRequestUrl: 'https://github.com/acme/sync-worker/pull/7',
    });
    await pipelines.save(project.id, 'develop', {
      host: 'github',
      spec,
      updatedBy: caller.subject,
    });
    // One built for the other host (the repository moved) is not this host's.
    await pipelines.save(project.id, 'feature/gone', {
      host: 'bitbucket',
      spec,
      updatedBy: caller.subject,
    });
    remoteHas('main', 'develop');
    const page = await environmentsPage('github', caller, project, false);
    expect(page.canEdit).toBe(false);
    expect(page.environments.map((e) => [e.name, e.branches])).toEqual([
      [
        'production',
        [
          {
            name: 'main',
            onRemote: true,
            pipeline: {
              pullRequestUrl: 'https://github.com/acme/sync-worker/pull/7',
              written: true,
            },
          },
        ],
      ],
      [
        'dev',
        [
          { name: 'develop', onRemote: true, pipeline: { pullRequestUrl: null, written: false } },
          { name: 'feature/gone', onRemote: false, pipeline: null },
        ],
      ],
    ]);
  });

  it('says why the branches could not be listed, and does not guess which are gone', async () => {
    await stored(usual);
    remoteFails('GitHub answered 502.');
    const page = await environmentsPage('github', caller, project, true);
    expect(page.remoteBranches).toBeNull();
    expect(page.branchesError).toBe('GitHub answered 502.');
    expect(page.environments.flatMap((e) => e.branches.map((b) => b.onRemote))).toEqual([
      null,
      null,
    ]);
  });

  it('shows what each environment’s pipelines last reported, and what runs there', async () => {
    await stored(usual);
    remoteHas('main', 'develop');
    await report('production', 'succeeded', 'aaa1111', '90', at(0), 'main');
    await report('dev', 'succeeded', 'bbb2222', '101', at(5));
    await report('dev', 'failed', 'ccc3333', '102', at(9));
    const page = await environmentsPage('github', caller, project, true);
    const [production, dev] = page.environments;
    expect(production?.latest).toMatchObject({ commit: 'aaa1111', status: 'succeeded' });
    expect(production?.running).toEqual(production?.latest);
    // The newest failed: it is the latest, and the one before still runs.
    expect(dev?.latest).toMatchObject({
      environment: 'dev',
      commit: 'ccc3333',
      status: 'failed',
      detail: 'health check',
      branch: 'develop',
      target: 'onprem-app',
      runId: 'github:102',
      runUrl: 'https://github.com/acme/sync-worker/actions/runs/102',
      actor: 'jordan',
      startedAt: at(9).toISOString(),
      finishedAt: at(9).toISOString(),
    });
    expect(dev?.running).toMatchObject({ commit: 'bbb2222', status: 'succeeded' });
    // The history is every environment's, newest first.
    expect(page.history.map((d) => [d.environment, d.commit])).toEqual([
      ['dev', 'ccc3333'],
      ['dev', 'bbb2222'],
      ['production', 'aaa1111'],
    ]);
  });

  it('a deploy under way is the latest; nothing runs until one succeeds', async () => {
    await stored(usual);
    remoteHas('main', 'develop');
    await report('dev', 'started', 'bbb2222', '101', at(5));
    const page = await environmentsPage('github', caller, project, true);
    expect(page.environments[1]?.latest).toMatchObject({ status: 'started', finishedAt: null });
    expect(page.environments[1]?.running).toBeNull();
  });

  it('a report under another spelling of the environment’s name is still its', async () => {
    await stored(usual);
    remoteHas('main', 'develop');
    await report('Dev', 'succeeded', 'bbb2222', '101', at(5));
    const page = await environmentsPage('github', caller, project, true);
    expect(page.environments[1]?.running).toMatchObject({ commit: 'bbb2222' });
  });
});

describe('what a save changed, for the audit log', () => {
  it('names what was added, removed, assigned and taken off', () => {
    expect(
      environmentChanges(
        [
          { name: 'production', production: true, branches: ['main'] },
          { name: 'dev', production: false, branches: ['develop', 'feature/intake'] },
          { name: 'qa', production: false, branches: [] },
        ],
        [
          { name: 'production', production: true, branches: ['release'] },
          { name: 'Dev', production: false, branches: ['develop'] },
          { name: 'staging', production: false, branches: ['feature/intake'] },
        ]
      )
    ).toEqual([
      'added staging',
      'removed qa',
      'production ← release',
      'production no longer ← main',
      'Dev no longer ← feature/intake',
      'staging ← feature/intake',
    ]);
  });

  it('is nothing when the list is as it was', () => {
    expect(environmentChanges(usual, usual)).toEqual([]);
  });

  it('a rename reads as one removed and one added, with its branches', () => {
    expect(
      environmentChanges(
        [{ name: 'production', production: true, branches: ['main'] }],
        [{ name: 'live', production: true, branches: ['main'] }]
      )
    ).toEqual(['added live', 'removed production', 'live ← main']);
  });
});
