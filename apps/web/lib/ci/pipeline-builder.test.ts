/**
 * The pipeline builder's service against a scripted host: the page's data
 * (a pipeline suggested from the repository's files, what the host says
 * for the checks), and opening the pull request on each host — a branch
 * from the project's branch, the file committed there, a pull request
 * against it, the file recorded as written — then a second open adding a
 * commit to the same pull request, and a pipeline that cannot be written
 * refused with nothing sent.
 */

jest.mock('@/lib/code/github-browse', () => ({
  ...jest.requireActual('@/lib/code/github-browse'),
  githubAuthOf: jest.fn(),
}));
jest.mock('@/lib/code/bitbucket-browse', () => ({
  ...jest.requireActual('@/lib/code/bitbucket-browse'),
  bitbucketAuthOf: jest.fn(),
}));
jest.mock('./runners', () => ({ readBitbucketRunners: jest.fn(), readGithubRunners: jest.fn() }));

import { randomBytes } from 'node:crypto';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { invalidateConnectorConfigCache } from '@renkei/connector-config';
import { ATLASSIAN_BITBUCKET, GITHUB } from '@renkei/provider-grants';
import type { PipelineSpec } from '@renkei/ci-blocks';
import {
  builderPage,
  freshBranch,
  openPipelinePullRequest,
  pullRequestText,
  type CodeRepoProject,
} from './pipeline-builder';

const githubBrowse = jest.requireMock<{ githubAuthOf: jest.Mock }>('@/lib/code/github-browse');
const bitbucketBrowse = jest.requireMock<{ bitbucketAuthOf: jest.Mock }>(
  '@/lib/code/bitbucket-browse'
);

interface Call {
  method: string;
  path: string;
  json?: unknown;
  form?: Record<string, string>;
}

/** A scripted host: answers by method and path (no query), and records every call. */
function host(answers: Record<string, { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetch = jest.fn(
    async (
      _scopes: readonly string[],
      path: string,
      init?: { method?: string; json?: unknown; form?: URLSearchParams }
    ) => {
      const method = init?.method ?? 'GET';
      calls.push({
        method,
        path,
        ...(init?.json !== undefined ? { json: init.json } : {}),
        ...(init?.form ? { form: Object.fromEntries(init.form) } : {}),
      });
      const answer = answers[`${method} ${path.split('?')[0]}`];
      if (!answer) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
      return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
    }
  );
  return { fetch, calls, kind: 'oauth' as const };
}

const caller = { subject: 'auth0|ada', origin: 'https://renkei.example' };
const project = (provider: string): CodeRepoProject => ({
  id: '00000000-0000-4000-8000-000000000c0d',
  ownerSubject: caller.subject,
  kind: 'code',
  name: 'sync-worker',
  description: null,
  sealedInstructions: null,
  repo: { provider, fullName: 'acme/sync-worker', branch: 'main' },
  workspaceId: null,
  llmModelId: null,
  toolConfig: null,
  createdAt: new Date('2026-11-01T00:00:00Z'),
  updatedAt: new Date('2026-11-01T00:00:00Z'),
});

const goBuild = {
  kind: 'build',
  runsOn: { type: 'hosted', image: 'golang:1.23' },
  inputs: [],
  variables: [],
  consumes: [],
  produces: [{ name: 'dist', paths: ['dist'] }],
  caches: [],
  commands: 'go build -o dist/ ./...',
};
const systemd = {
  kind: 'deploy',
  runsOn: { type: 'target' },
  inputs: [{ name: 'service_name', type: 'text' }],
  variables: [{ name: 'HEALTH_URL', secured: false }],
  consumes: ['dist'],
  produces: [],
  caches: [],
  commands: 'sudo systemctl restart ${input.service_name}',
};

async function publish(key: string, name: string, kind: string, draft: unknown) {
  const blocks = getDataStore().ciBlocks;
  const id = await blocks.create({ key, name, description: null, kind, draft, createdBy: 'ada' });
  await blocks.publish(id, 'ada');
}

beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY ||= randomBytes(32).toString('base64');
});
beforeEach(async () => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
  invalidateConnectorConfigCache();
  await publish('go-test-build', 'Go: vet, test, build', 'build', goBuild);
  await publish('deploy-systemd', 'Deploy with systemd', 'deploy', systemd);
  await getDataStore().ciTargets.create({
    name: 'onprem-workers',
    description: null,
    kind: 'runners',
    labels: {
      bitbucket: ['self.hosted', 'onprem-workers'],
      github: ['self-hosted', 'onprem-workers'],
    },
    createdBy: 'ada',
  });
});
afterEach(() => resetDataStore());

const spec: PipelineSpec = {
  checks: [{ block: 'go-test-build', version: 1, inputs: {} }],
  environments: [
    {
      name: 'production',
      branch: 'main',
      steps: [
        { block: 'go-test-build', version: 1, inputs: {} },
        {
          block: 'deploy-systemd',
          version: 1,
          inputs: { service_name: 'sync-worker' },
          target: 'onprem-workers',
        },
      ],
    },
  ],
};

describe('on GitHub', () => {
  const repo = '/repos/acme/sync-worker';
  const answers = {
    [`GET ${repo}/branches`]: {
      body: [
        { name: 'main', commit: { sha: 'base-sha' } },
        { name: 'develop', commit: { sha: 'dev-sha' } },
      ],
    },
    [`GET ${repo}/contents/`]: {
      body: [
        { path: 'go.mod', type: 'file' },
        { path: 'cmd', type: 'dir' },
      ],
    },
    [`GET ${repo}/actions/variables`]: {
      body: { variables: [{ name: 'HEALTH_URL', value: 'x' }] },
    },
    [`GET ${repo}/actions/secrets`]: { body: { secrets: [] } },
    [`GET ${repo}/environments`]: { body: { environments: [{ name: 'production' }] } },
    [`GET ${repo}/environments/production/variables`]: { body: { variables: [] } },
    [`GET ${repo}/environments/production/secrets`]: { body: { secrets: [] } },
    [`GET ${repo}/pulls`]: { body: [] },
    [`POST ${repo}/git/refs`]: { status: 201, body: { ref: 'refs/heads/renkei/pipeline' } },
    [`PUT ${repo}/contents/.github/workflows/pipeline.yml`]: {
      status: 201,
      body: { commit: { sha: 'c1' } },
    },
    [`POST ${repo}/pulls`]: {
      status: 201,
      body: { number: 7, html_url: 'https://github.com/acme/sync-worker/pull/7' },
    },
  };

  it('suggests a pipeline from the repository’s files, with what the host says for the checks', async () => {
    githubBrowse.githubAuthOf.mockReturnValue(host(answers));
    const page = await builderPage(caller, project(GITHUB));
    expect(page).toMatchObject({
      host: 'github',
      file: '.github/workflows/pipeline.yml',
      suggested: true,
      found: ['Go · go.mod'],
      pullRequestUrl: null,
    });
    expect(page.spec.environments.map((e) => [e.name, e.branch])).toEqual([
      ['dev', 'develop'],
      ['production', 'main'],
    ]);
    expect(page.facts).toMatchObject({
      repoVariables: ['HEALTH_URL'],
      environments: [{ name: 'production', variables: [] }],
      branches: ['main', 'develop'],
      existingFile: null,
      lastWritten: null,
    });
  });

  it('opens a pull request from a new branch, then adds to it while it is open', async () => {
    const github = host(answers);
    githubBrowse.githubAuthOf.mockReturnValue(github);
    const now = new Date('2026-11-18T10:00:00Z');
    const opened = await openPipelinePullRequest(caller, project(GITHUB), spec, now);
    expect(opened).toMatchObject({
      ok: true,
      url: 'https://github.com/acme/sync-worker/pull/7',
      branch: 'renkei/pipeline',
      updated: false,
    });
    const writes = github.calls.filter((c) => c.method !== 'GET');
    expect(writes.map((c) => `${c.method} ${c.path.split('?')[0]}`)).toEqual([
      `POST ${repo}/git/refs`,
      `PUT ${repo}/contents/.github/workflows/pipeline.yml`,
      `POST ${repo}/pulls`,
    ]);
    expect(writes[0].json).toEqual({ ref: 'refs/heads/renkei/pipeline', sha: 'base-sha' });
    expect(writes[1].json).toMatchObject({ branch: 'renkei/pipeline' });
    expect(writes[2].json).toMatchObject({
      title: 'Add the pipeline built from blocks',
      head: 'renkei/pipeline',
      base: 'main',
    });
    const saved = await getDataStore().ciPipelines.get(project(GITHUB).id);
    expect(saved?.pullRequestUrl).toBe('https://github.com/acme/sync-worker/pull/7');
    expect(saved?.writtenText).toContain('production-deploy-systemd:');
    expect(saved?.writtenText).toContain('https://renkei.example/api/deployments/report');

    // While it is open, opening again adds a commit to it and opens nothing new.
    const again = host({
      ...answers,
      [`GET ${repo}/pulls`]: {
        body: [
          {
            number: 7,
            title: 'Add the pipeline built from blocks',
            state: 'open',
            head: { ref: 'renkei/pipeline' },
            base: { ref: 'main' },
          },
        ],
      },
    });
    githubBrowse.githubAuthOf.mockReturnValue(again);
    const updated = await openPipelinePullRequest(caller, project(GITHUB), spec, now);
    expect(updated).toMatchObject({ ok: true, updated: true, branch: 'renkei/pipeline' });
    expect(
      again.calls
        .filter((c) => c.method !== 'GET')
        .map((c) => `${c.method} ${c.path.split('?')[0]}`)
    ).toEqual([`PUT ${repo}/contents/.github/workflows/pipeline.yml`]);
  });

  it('refuses a pipeline that cannot be written, and sends nothing', async () => {
    const github = host(answers);
    githubBrowse.githubAuthOf.mockReturnValue(github);
    const unfilled: PipelineSpec = {
      ...spec,
      environments: [
        { ...spec.environments[0], steps: [{ block: 'deploy-systemd', version: 1, inputs: {} }] },
      ],
    };
    const outcome = await openPipelinePullRequest(caller, project(GITHUB), unfilled, new Date());
    expect(outcome).toEqual({
      ok: false,
      status: 400,
      error: 'The file cannot be written yet.',
      problems: [
        'production, step 1: “Deploy with systemd” runs on a target: pick one.',
        'production, step 1: Fill in “service_name”.',
      ],
    });
    expect(github.calls).toEqual([]);
    expect(await getDataStore().ciPipelines.get(project(GITHUB).id)).toBeNull();
  });
});

describe('on Bitbucket', () => {
  const repo = '/repositories/acme/sync-worker';
  it('commits the file on a new branch from the project’s branch, and opens the pull request', async () => {
    const bitbucket = host({
      [`GET ${repo}/refs/branches`]: {
        body: {
          values: [
            { name: 'main', target: { hash: 'base-sha' } },
            { name: 'renkei/pipeline', target: { hash: 'old' } },
          ],
        },
      },
      [`GET ${repo}/pullrequests`]: { body: { values: [] } },
      [`POST ${repo}/src`]: { status: 201, body: {} },
      [`POST ${repo}/pullrequests`]: {
        status: 201,
        body: {
          id: 12,
          links: { html: { href: 'https://bitbucket.org/acme/sync-worker/pull-requests/12' } },
        },
      },
    });
    bitbucketBrowse.bitbucketAuthOf.mockReturnValue(bitbucket);
    const now = new Date('2026-11-18T10:04:00Z');
    const opened = await openPipelinePullRequest(caller, project(ATLASSIAN_BITBUCKET), spec, now);
    // renkei/pipeline is taken by an old branch with no open pull request: a fresh one.
    expect(opened).toMatchObject({
      ok: true,
      url: 'https://bitbucket.org/acme/sync-worker/pull-requests/12',
      branch: 'renkei/pipeline-202611181004',
    });
    const commit = bitbucket.calls.find((c) => c.method === 'POST' && c.path.endsWith('/src'));
    expect(commit?.form).toMatchObject({
      branch: 'renkei/pipeline-202611181004',
      parents: 'base-sha',
      message: 'Add the pipeline built from blocks (Renkei)',
    });
    expect(commit?.form?.['bitbucket-pipelines.yml']).toContain('deployment: production');
    const pr = bitbucket.calls.find((c) => c.method === 'POST' && c.path.endsWith('/pullrequests'));
    expect(pr?.json).toMatchObject({
      source: { branch: { name: 'renkei/pipeline-202611181004' } },
      destination: { branch: { name: 'main' } },
      close_source_branch: true,
    });
  });
});

describe('the pull request’s words', () => {
  it('say what deploys where once it merges', () => {
    const names: Record<string, string> = {
      'go-test-build': 'Go: vet, test, build',
      'deploy-systemd': 'Deploy with systemd',
    };
    expect(pullRequestText(spec, (key) => names[key] ?? key, 'github', true)).toEqual({
      title: 'Update the pipeline built from blocks',
      description: [
        'This replaces .github/workflows/pipeline.yml, built in Renkei from the organization’s blocks.',
        '',
        '- **Pull requests:** Go: vet, test, build',
        '- **production**, on merge to `main`: Go: vet, test, build → Deploy with systemd on onprem-workers',
        '',
        'Once merged, GitHub runs it: merging to an environment’s branch deploys that environment.',
      ].join('\n'),
    });
  });

  it('takes renkei/pipeline, or a fresh branch when that is taken', () => {
    const now = new Date('2026-11-18T10:04:00Z');
    expect(freshBranch(['main'], now)).toBe('renkei/pipeline');
    expect(freshBranch(['main', 'renkei/pipeline'], now)).toBe('renkei/pipeline-202611181004');
  });
});
