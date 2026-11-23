/**
 * The Deployments pages' data against a scripted GitHub: each project's
 * environments with what runs there (the newest success) beside the newest
 * report whatever came of it; only the projects a person can open; one
 * project's history and its promotion — the commits merging brings, the
 * open pull request — and promoting: opening that pull request, and
 * merging only the open one between the two environments' branches; the
 * branches, feature branches included, with their newest run; and starting
 * the pipeline by hand — the checks on any branch, an environment's deploy
 * only from its own.
 */

jest.mock('@/lib/code/github-browse', () => ({
  ...jest.requireActual('@/lib/code/github-browse'),
  githubAuthOf: jest.fn(),
}));
jest.mock('./runners', () => ({ readBitbucketRunners: jest.fn(), readGithubRunners: jest.fn() }));

import { randomBytes } from 'node:crypto';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { invalidateConnectorConfigCache } from '@renkei/connector-config';
import { GITHUB } from '@renkei/provider-grants';
import {
  deploymentDetail,
  deploymentsOverview,
  mergePromotion,
  openPromotion,
  startManualRun,
} from './deployments';

const githubBrowse = jest.requireMock<{ githubAuthOf: jest.Mock }>('@/lib/code/github-browse');

interface Call {
  method: string;
  path: string;
  json?: unknown;
}

function host(answers: Record<string, { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetch = jest.fn(
    async (
      _scopes: readonly string[],
      path: string,
      init?: { method?: string; json?: unknown }
    ) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, path, ...(init?.json !== undefined ? { json: init.json } : {}) });
      const answer = answers[`${method} ${path.split('?')[0]}`];
      if (!answer) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
      const status = answer.status ?? 200;
      return new Response(status === 204 ? null : JSON.stringify(answer.body), { status });
    }
  );
  return { fetch, calls, kind: 'oauth' as const };
}

const ADA = 'auth0|ada';
const caller = { subject: ADA, origin: 'https://renkei.example' };
const spec = {
  checks: [{ block: 'go-test-build', version: 1, inputs: {} }],
  environments: [
    { name: 'dev', branch: 'develop', steps: [] },
    { name: 'production', branch: 'main', steps: [] },
  ],
};
const at = (minute: number) => new Date(Date.UTC(2026, 10, 18, 9, minute));

async function project(owner: string, name: string): Promise<string> {
  const store = getDataStore();
  const id = await store.chatProjects.create({
    ownerSubject: owner,
    name,
    description: null,
    toolConfig: null,
    repo: { provider: GITHUB, fullName: `acme/${name}`, branch: 'main' },
  });
  await store.ciPipelines.save(id, { host: 'github', spec, updatedBy: owner });
  return id;
}

async function deployed(
  projectId: string,
  environment: string,
  run: number,
  minute: number,
  status: 'started' | 'succeeded' | 'failed',
  commit: string
) {
  await getDataStore().ciDeployments.record({
    projectId,
    environment,
    status,
    commitSha: commit,
    branch: environment === 'dev' ? 'develop' : 'main',
    target: 'onprem-workers',
    runId: `github:${run}.1`,
    runUrl: `https://github.com/acme/x/actions/runs/${run}`,
    detail: status === 'failed' ? 'failure' : null,
    actor: 'jordan',
    at: at(minute),
  });
}

beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY ||= randomBytes(32).toString('base64');
});
beforeEach(async () => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
  invalidateConnectorConfigCache();
  const blocks = getDataStore().ciBlocks;
  const id = await blocks.create({
    key: 'go-test-build',
    name: 'Go: vet, test, build',
    description: null,
    kind: 'build',
    draft: {},
    createdBy: ADA,
  });
  await blocks.publish(id, ADA);
});
afterEach(() => resetDataStore());

describe('what runs where', () => {
  it('shows each environment’s running commit beside its newest report, for the projects a person can open', async () => {
    const mine = await project(ADA, 'sync-worker');
    const theirs = await project('auth0|bob', 'private-thing');
    await deployed(mine, 'production', 1, 0, 'succeeded', '3b07d9f');
    await deployed(mine, 'dev', 2, 10, 'succeeded', '71c0b3e');
    await deployed(mine, 'dev', 3, 20, 'failed', '8e41c2a');
    await deployed(theirs, 'dev', 4, 30, 'succeeded', 'aaaaaaa');

    const overview = await deploymentsOverview(ADA);
    expect(overview.apps).toHaveLength(1);
    const [app] = overview.apps;
    expect(app).toMatchObject({ name: 'sync-worker', host: 'github', stack: 'Go', canEdit: true });
    expect(
      app.environments.map((e) => [e.name, e.branch, e.running?.commit, e.latest?.status])
    ).toEqual([
      ['dev', 'develop', '71c0b3e', 'failed'],
      ['production', 'main', '3b07d9f', 'succeeded'],
    ]);
    expect(overview.recent.map((d) => [d.app, d.environment, d.status])).toEqual([
      ['sync-worker', 'dev', 'failed'],
      ['sync-worker', 'dev', 'succeeded'],
      ['sync-worker', 'production', 'succeeded'],
    ]);
  });
});

describe('projects without a pipeline', () => {
  it('are offered for building one, and their app opens empty', async () => {
    const id = await getDataStore().chatProjects.create({
      ownerSubject: ADA,
      name: 'intake-api',
      description: null,
      toolConfig: null,
      repo: { provider: GITHUB, fullName: 'acme/intake-api', branch: 'main' },
    });
    await project(ADA, 'sync-worker');
    const overview = await deploymentsOverview(ADA);
    expect(overview.apps.map((a) => a.name)).toEqual(['sync-worker']);
    expect(overview.unbuilt).toEqual([
      { projectId: id, name: 'intake-api', repo: 'acme/intake-api', host: 'github' },
    ]);
    expect(await deploymentDetail(caller, id)).toMatchObject({
      name: 'intake-api',
      hasPipeline: false,
      environments: [],
      promotions: [],
      history: [],
    });
  });
});

describe('promoting', () => {
  const repo = '/repos/acme/sync-worker';
  const compare = {
    [`GET ${repo}/compare/main...develop`]: {
      body: {
        ahead_by: 2,
        commits: [
          {
            sha: '71c0b3e',
            commit: { message: 'Retry the lookup\n\nbody', author: { name: 'J' } },
            author: { login: 'jordan' },
          },
          {
            sha: '8e41c2a',
            commit: { message: 'Show the status', author: { name: 'P' } },
            author: { login: 'priya' },
          },
        ],
      },
    },
  };
  const openPr = {
    number: 57,
    title: 'Promote dev to production',
    state: 'open',
    head: { ref: 'develop', sha: '8e41c2a' },
    base: { ref: 'main' },
  };

  it('says what merging brings, newest first, and finds the open pull request', async () => {
    const id = await project(ADA, 'sync-worker');
    githubBrowse.githubAuthOf.mockReturnValue(
      host({
        ...compare,
        [`GET ${repo}/pulls`]: { body: [openPr] },
        [`GET ${repo}/pulls/57`]: { body: openPr },
        [`GET ${repo}/pulls/57/reviews`]: { body: [] },
        [`GET ${repo}/commits/8e41c2a/status`]: { body: { state: 'success' } },
      })
    );
    const detail = await deploymentDetail(caller, id);
    expect(detail?.promotions).toEqual([
      {
        from: 'dev',
        to: 'production',
        fromBranch: 'develop',
        toBranch: 'main',
        ahead: {
          count: 2,
          more: false,
          commits: [
            { sha: '8e41c2a', message: 'Show the status', author: 'priya' },
            { sha: '71c0b3e', message: 'Retry the lookup', author: 'jordan' },
          ],
        },
        pullRequest: {
          number: 57,
          title: 'Promote dev to production',
          url: 'https://github.com/acme/sync-worker/pull/57',
          checks: expect.any(String),
        },
        error: null,
      },
    ]);
  });

  it('opens the pull request from one environment’s branch into the next’s', async () => {
    const id = await project(ADA, 'sync-worker');
    const github = host({
      [`POST ${repo}/pulls`]: {
        status: 201,
        body: { number: 58, html_url: 'https://github.com/acme/sync-worker/pull/58' },
      },
    });
    githubBrowse.githubAuthOf.mockReturnValue(github);
    expect(await openPromotion(caller, id, 'dev', 'production')).toMatchObject({
      ok: true,
      number: 58,
      url: 'https://github.com/acme/sync-worker/pull/58',
    });
    expect(github.calls[0].json).toMatchObject({
      title: 'Promote dev to production',
      head: 'develop',
      base: 'main',
    });
    expect(await openPromotion(caller, id, 'production', 'dev')).toEqual({
      ok: false,
      status: 400,
      error: 'The pipeline does not promote production to dev.',
    });
  });

  it('merges only the open pull request between the two branches', async () => {
    const id = await project(ADA, 'sync-worker');
    const other = { ...openPr, number: 12, head: { ref: 'feature/x', sha: 'f' } };
    const github = host({
      [`GET ${repo}/pulls/57`]: { body: openPr },
      [`GET ${repo}/pulls/12`]: { body: other },
      [`PUT ${repo}/pulls/57/merge`]: { body: { merged: true } },
    });
    githubBrowse.githubAuthOf.mockReturnValue(github);
    expect(await mergePromotion(caller, id, 'dev', 'production', 12)).toEqual({
      ok: false,
      status: 409,
      error: 'Pull request #12 is not the open one from develop to main.',
    });
    expect(github.calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(await mergePromotion(caller, id, 'dev', 'production', 57)).toMatchObject({
      ok: true,
      number: 57,
    });
    expect(github.calls.filter((c) => c.method === 'PUT').map((c) => c.path)).toEqual([
      `${repo}/pulls/57/merge`,
    ]);
  });

  it('is not anyone’s who cannot open the project', async () => {
    const theirs = await project('auth0|bob', 'private-thing');
    expect(await deploymentDetail(caller, theirs)).toBeNull();
    expect(await openPromotion(caller, theirs, 'dev', 'production')).toMatchObject({
      ok: false,
      status: 404,
    });
  });
});

describe('branches and starting the pipeline by hand', () => {
  const repo = '/repos/acme/sync-worker';
  const build = { block: 'go-test-build', version: 1, inputs: {} };

  async function runnable(owner: string): Promise<string> {
    const id = await project(owner, 'sync-worker');
    await getDataStore().ciPipelines.save(id, {
      host: 'github',
      spec: {
        checks: [build],
        environments: [
          { name: 'dev', branch: 'develop', steps: [build] },
          { name: 'production', branch: 'main', steps: [build] },
        ],
      },
      updatedBy: owner,
    });
    return id;
  }

  it('lists every branch, feature branches too: environments first, then the most recently run', async () => {
    const id = await runnable(ADA);
    const run = (
      n: number,
      branch: string,
      status: string,
      conclusion: string | null,
      at: string
    ) => ({
      id: n,
      status,
      conclusion,
      head_branch: branch,
      run_started_at: at,
    });
    githubBrowse.githubAuthOf.mockReturnValue(
      host({
        [`GET ${repo}/branches`]: {
          body: ['feature/a', 'main', 'feature/b', 'develop', 'chore/c'].map((name) => ({
            name,
            commit: { sha: `${name}-sha` },
          })),
        },
        [`GET ${repo}/actions/runs`]: {
          body: {
            workflow_runs: [
              run(9, 'feature/b', 'in_progress', null, '2026-11-20T10:00:00Z'),
              run(8, 'feature/a', 'completed', 'failure', '2026-11-20T09:00:00Z'),
              run(7, 'feature/b', 'completed', 'success', '2026-11-19T09:00:00Z'),
              run(6, 'main', 'completed', 'success', '2026-11-18T09:00:00Z'),
            ],
          },
        },
      })
    );
    const detail = await deploymentDetail(caller, id);
    expect(detail?.hasChecks).toBe(true);
    expect(detail?.branchesError).toBeNull();
    expect(detail?.branches?.map((b) => [b.name, b.environment, b.run?.state ?? null])).toEqual([
      ['develop', 'dev', null],
      ['main', 'production', 'success'],
      ['feature/b', null, 'running'],
      ['feature/a', null, 'failure'],
      ['chore/c', null, null],
    ]);
    expect(detail?.branches?.[2].run?.url).toBe(
      'https://github.com/acme/sync-worker/actions/runs/9'
    );
  });

  it('starts the checks on a feature branch, and an environment’s deploy only from its own branch', async () => {
    const id = await runnable(ADA);
    const github = host({
      [`POST ${repo}/actions/workflows/pipeline.yml/dispatches`]: { status: 204, body: {} },
    });
    githubBrowse.githubAuthOf.mockReturnValue(github);
    expect(await startManualRun(caller, id, 'feature/a', 'checks')).toMatchObject({ ok: true });
    expect(github.calls.at(-1)?.json).toEqual({ ref: 'feature/a', inputs: { run: 'checks' } });

    expect(await startManualRun(caller, id, 'feature/a', 'production')).toEqual({
      ok: false,
      status: 409,
      error: 'production deploys only from main, not feature/a.',
    });
    expect(await startManualRun(caller, id, 'main', 'production')).toMatchObject({ ok: true });
    expect(github.calls.at(-1)?.json).toEqual({ ref: 'main', inputs: { run: 'production' } });
    expect(github.calls.filter((c) => c.method === 'POST')).toHaveLength(2);
  });

  it('says to update the file when the branch’s pipeline cannot be started by hand', async () => {
    const id = await runnable(ADA);
    githubBrowse.githubAuthOf.mockReturnValue(
      host({
        [`POST ${repo}/actions/workflows/pipeline.yml/dispatches`]: {
          status: 422,
          body: { message: "Workflow does not have 'workflow_dispatch' trigger" },
        },
      })
    );
    const refused = await startManualRun(caller, id, 'develop', 'dev');
    expect(refused).toMatchObject({ ok: false, status: 502 });
    expect(refused.ok ? '' : refused.error).toContain(
      'If .github/workflows/pipeline.yml on develop was written before runs could be started from Renkei, update it from the Pipeline tab.'
    );
  });

  it('is only an editor’s', async () => {
    const theirs = await runnable('auth0|bob');
    expect(await startManualRun(caller, theirs, 'main', 'checks')).toMatchObject({
      ok: false,
      status: 404,
    });
  });
});
