/**
 * Deployment reports from pipeline steps, with tokens signed here as each
 * host signs them: a GitHub job's token (Renkei as its audience) and a
 * Bitbucket step's (its repository's UUID) land on the code project whose
 * builder wrote one of that repository's pipelines (there is one a
 * branch) — a start, then its outcome on the same row — and everything
 * else is refused with nothing recorded: no token, a token another issuer
 * or key signed, one for another audience or repository, an environment
 * the project does not have. Each report that changes a deployment's
 * status is raised as a change, for the project's people and their agents.
 */

jest.mock('./deployment-changes', () => ({ raiseChange: jest.fn(async () => true) }));

import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload } from 'jose';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { ATLASSIAN_BITBUCKET, GITHUB } from '@renkei/provider-grants';
import { readReportBody, recordDeploymentReport } from './deployment-reports';
import type { KeysFor } from './oidc';

const { raiseChange } = jest.requireMock<{ raiseChange: jest.Mock }>('./deployment-changes');

const ORIGIN = 'https://renkei.example';
const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
const BITBUCKET_ISSUER =
  'https://api.bitbucket.org/2.0/workspaces/acme/pipelines-config/identity/oidc';
const NOW = new Date('2026-11-18T10:00:00.000Z');

let signing: CryptoKey;
let keysFor: KeysFor;
let asked: string[];

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  signing = pair.privateKey;
  const jwks = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' }],
  });
  keysFor = (url) => {
    asked.push(url);
    return jwks;
  };
});

async function token(claims: JWTPayload, key: CryptoKey = signing): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);
}

/** A branch's pipeline, as the builder keeps it: the checks and the one environment it deploys. */
const specFor = (environment: string, branch: string) => ({
  checks: [],
  environments: [{ name: environment, branch, steps: [] }],
});

/**
 * A code project with dev on develop and production on main: its
 * environments, and a pipeline for each branch — main's in a pull request,
 * so the host's name for the repository is known.
 */
async function codeProject(provider: string, fullName: string, repoKey: string): Promise<string> {
  const store = getDataStore();
  const host = provider === GITHUB ? 'github' : 'bitbucket';
  const id = await store.chatProjects.create({
    ownerSubject: 'auth0|ada',
    name: fullName.split('/')[1],
    description: null,
    toolConfig: null,
    repo: { provider, fullName, branch: 'main' },
  });
  await store.ciEnvironments.replace(
    id,
    [
      { name: 'dev', production: false, branches: ['develop'] },
      { name: 'production', production: true, branches: ['main'] },
    ],
    'auth0|ada'
  );
  await store.ciPipelines.save(id, 'main', {
    host,
    spec: specFor('production', 'main'),
    updatedBy: 'auth0|ada',
  });
  await store.ciPipelines.save(id, 'develop', {
    host,
    spec: specFor('dev', 'develop'),
    updatedBy: 'auth0|ada',
  });
  await store.ciPipelines.setRepoKey(id, repoKey);
  await store.ciPipelines.markWritten(id, 'main', { text: 'pipelines: {}', pullRequestUrl: null });
  return id;
}

const body = (overrides: Record<string, unknown> = {}) => ({
  environment: 'production',
  status: 'started',
  commit: 'abc1234def',
  branch: 'main',
  run: '412',
  target: 'onprem-app',
  detail: '',
  ...overrides,
});

const report = async (bearer: string | null, sent: unknown, at = NOW) =>
  recordDeploymentReport({
    authorization: bearer === null ? null : `Bearer ${bearer}`,
    body: sent,
    origin: ORIGIN,
    now: at,
    keysFor,
  });

beforeEach(() => {
  asked = [];
  raiseChange.mockClear();
  registerDataStore(createMemoryDataStore());
});
afterEach(() => resetDataStore());

describe('a GitHub job’s report', () => {
  const claims = {
    iss: GITHUB_ISSUER,
    aud: ORIGIN,
    repository: 'Acme/Sync-Worker',
    ref: 'refs/heads/main',
    sha: 'f04b6e9aa1',
    run_id: '2231',
    run_attempt: '1',
    actor: 'jordan',
  };

  it('lands on the project, the token’s commit and run winning; its outcome updates the same row', async () => {
    const projectId = await codeProject(GITHUB, 'acme/sync-worker', 'acme/sync-worker');
    const started = await report(await token(claims), body());
    expect(started).toMatchObject({
      ok: true,
      projectId,
      environment: 'production',
      status: 'started',
    });
    expect(asked).toEqual([`${GITHUB_ISSUER}/.well-known/jwks`]);
    await report(
      await token(claims),
      body({ status: 'failed', detail: 'failure' }),
      new Date('2026-11-18T10:03:00.000Z')
    );
    const rows = await getDataStore().ciDeployments.recent([projectId], 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      environment: 'production',
      status: 'failed',
      commitSha: 'f04b6e9aa1',
      branch: 'main',
      target: 'onprem-app',
      runId: 'github:2231.1',
      runUrl: 'https://github.com/acme/sync-worker/actions/runs/2231',
      detail: 'failure',
      actor: 'jordan',
      startedAt: NOW,
      finishedAt: new Date('2026-11-18T10:03:00.000Z'),
    });
  });

  it('is refused when asked for another audience, or signed by another key', async () => {
    await codeProject(GITHUB, 'acme/sync-worker', 'acme/sync-worker');
    expect(await report(await token({ ...claims, aud: 'https://elsewhere.test' }), body())).toEqual(
      {
        ok: false,
        status: 401,
        error: 'The token’s aud is not one Renkei takes.',
      }
    );
    const other = await generateKeyPair('RS256');
    expect(await report(await token(claims, other.privateKey), body())).toEqual({
      ok: false,
      status: 401,
      error: 'The token’s signature does not match the host’s keys.',
    });
  });
});

describe('a report as a change', () => {
  const claims = {
    iss: GITHUB_ISSUER,
    aud: ORIGIN,
    repository: 'Acme/Sync-Worker',
    ref: 'refs/heads/main',
    sha: 'f04b6e9aa1',
    run_id: '2231',
    run_attempt: '1',
    actor: 'jordan',
  };
  const raised = () => raiseChange.mock.calls.map(([change]) => change);

  it('a start and its outcome are each raised once, as the same deployment', async () => {
    const projectId = await codeProject(GITHUB, 'acme/sync-worker', 'acme/sync-worker');
    await report(await token(claims), body());
    await report(await token(claims), body({ status: 'failed', detail: 'exit code 1' }));
    const [row] = await getDataStore().ciDeployments.recent([projectId], 10);
    expect(raised()).toEqual([
      expect.objectContaining({
        kind: 'deployment',
        projectId,
        environment: 'production',
        status: 'started',
        deploymentId: row?.id,
        commit: 'f04b6e9aa1',
        branch: 'main',
        runUrl: 'https://github.com/acme/sync-worker/actions/runs/2231',
        at: NOW.toISOString(),
      }),
      expect.objectContaining({ status: 'failed', deploymentId: row?.id, detail: 'exit code 1' }),
    ]);
  });

  it('the same outcome reported again is not a change', async () => {
    await codeProject(GITHUB, 'acme/sync-worker', 'acme/sync-worker');
    await report(await token(claims), body({ status: 'failed' }));
    await report(await token(claims), body({ status: 'failed' }));
    expect(raised().map((change) => change.status)).toEqual(['failed']);
  });

  it('a start that arrives after the end is not one either', async () => {
    await codeProject(GITHUB, 'acme/sync-worker', 'acme/sync-worker');
    await report(await token(claims), body({ status: 'succeeded' }));
    await report(await token(claims), body());
    expect(raised().map((change) => change.status)).toEqual(['succeeded']);
  });

  it('a refused report raises nothing', async () => {
    await report(await token(claims), body());
    expect(raised()).toEqual([]);
  });
});

describe('a Bitbucket step’s report', () => {
  const claims = {
    iss: BITBUCKET_ISSUER,
    aud: 'ari:cloud:bitbucket::workspace/1111',
    repositoryUuid: '{8F2C1A9E-0000-4000-8000-00000000ABCD}',
    branchName: 'develop',
  };

  it('lands on the project by the repository’s UUID, with the keys fetched from its issuer', async () => {
    const projectId = await codeProject(
      ATLASSIAN_BITBUCKET,
      'acme/portal-web',
      '8f2c1a9e-0000-4000-8000-00000000abcd'
    );
    const outcome = await report(
      await token(claims),
      body({ environment: 'Dev', status: 'succeeded' })
    );
    expect(outcome).toMatchObject({ ok: true, projectId, environment: 'dev', status: 'succeeded' });
    expect(asked).toEqual([`${BITBUCKET_ISSUER}/keys.json`]);
    const [row] = await getDataStore().ciDeployments.recent([projectId], 1);
    expect(row).toMatchObject({
      branch: 'develop',
      runId: 'bitbucket:412',
      runUrl: 'https://bitbucket.org/acme/portal-web/pipelines/results/412',
      finishedAt: NOW,
    });
  });

  it('is refused for a repository no project built a pipeline for, or an environment the project does not have', async () => {
    await codeProject(
      ATLASSIAN_BITBUCKET,
      'acme/portal-web',
      '8f2c1a9e-0000-4000-8000-00000000abcd'
    );
    expect(
      await report(await token({ ...claims, repositoryUuid: '{0000}' }), body())
    ).toMatchObject({ ok: false, status: 404 });
    expect(await report(await token(claims), body({ environment: 'qa' }))).toEqual({
      ok: false,
      status: 400,
      error: 'The project Renkei keeps for acme/portal-web has no environment qa.',
    });
    expect(await getDataStore().ciDeployments.recent([], 10)).toEqual([]);
  });

  it('is taken for an environment the project has, whichever branch’s pipeline deploys it', async () => {
    // Only develop has a pipeline here, never put in a pull request: the
    // report for production still finds the project through that row.
    const store = getDataStore();
    const id = await store.chatProjects.create({
      ownerSubject: 'auth0|ada',
      name: 'intake',
      description: null,
      toolConfig: null,
      repo: { provider: ATLASSIAN_BITBUCKET, fullName: 'acme/intake', branch: 'main' },
    });
    await store.ciEnvironments.replace(
      id,
      [
        { name: 'production', production: true, branches: ['main'] },
        { name: 'dev', production: false, branches: ['develop', 'feature/intake'] },
      ],
      'auth0|ada'
    );
    await store.ciPipelines.save(id, 'develop', {
      host: 'bitbucket',
      spec: specFor('dev', 'develop'),
      updatedBy: 'auth0|ada',
    });
    await store.ciPipelines.setRepoKey(id, '8f2c1a9e-0000-4000-8000-00000000abcd');
    expect(await report(await token(claims), body({ status: 'succeeded' }))).toMatchObject({
      ok: true,
      projectId: id,
      environment: 'production',
    });
    // A second branch of dev reports to dev, under the project's spelling.
    expect(
      await report(
        await token({ ...claims, branchName: 'feature/intake' }),
        body({ environment: 'DEV', status: 'succeeded', run: '413' })
      )
    ).toMatchObject({ ok: true, projectId: id, environment: 'dev' });
    const rows = await store.ciDeployments.recent([id], 10);
    expect(rows.map((r) => [r.environment, r.branch]).sort()).toEqual([
      ['dev', 'feature/intake'],
      ['production', 'develop'],
    ]);
  });

  it('a project that named no environments has its production one, and only that', async () => {
    const store = getDataStore();
    const id = await store.chatProjects.create({
      ownerSubject: 'auth0|ada',
      name: 'bare',
      description: null,
      toolConfig: null,
      repo: { provider: ATLASSIAN_BITBUCKET, fullName: 'acme/bare', branch: 'main' },
    });
    await store.ciPipelines.save(id, 'main', {
      host: 'bitbucket',
      spec: specFor('production', 'main'),
      updatedBy: 'auth0|ada',
    });
    await store.ciPipelines.setRepoKey(id, '8f2c1a9e-0000-4000-8000-00000000abcd');
    expect(await report(await token(claims), body({ status: 'succeeded' }))).toMatchObject({
      ok: true,
      environment: 'production',
    });
    expect(await report(await token(claims), body({ environment: 'dev' }))).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it('never fetches keys for an issuer that is not Bitbucket’s own API', async () => {
    const outcome = await report(
      await token({
        ...claims,
        iss: 'https://evil.test/2.0/workspaces/acme/pipelines-config/identity/oidc',
      }),
      body()
    );
    expect(outcome).toEqual({
      ok: false,
      status: 401,
      error: 'The token was not issued by GitHub Actions or Bitbucket Pipelines.',
    });
    expect(asked).toEqual([]);
  });
});

describe('a pipeline written by hand', () => {
  const claims = {
    iss: GITHUB_ISSUER,
    aud: ORIGIN,
    repository: 'acme/handmade',
    ref: 'refs/heads/develop',
    sha: 'f04b6e9aa1',
    run_id: '77',
    run_attempt: '1',
    actor: 'jordan',
  };

  /** A code project with its environments and no pipeline built here. */
  async function handmade(name: string, environments: string[]): Promise<string> {
    const store = getDataStore();
    const id = await store.chatProjects.create({
      ownerSubject: 'auth0|ada',
      name,
      description: null,
      toolConfig: null,
      repo: { provider: GITHUB, fullName: 'acme/handmade', branch: 'main' },
    });
    await store.ciEnvironments.replace(
      id,
      environments.map((environment) => ({
        name: environment,
        production: environment === 'production',
        branches: [],
      })),
      'auth0|ada'
    );
    return id;
  }

  it('reports nowhere until the report step is taken for its project, and says how', async () => {
    const id = await handmade('handmade', ['production', 'dev']);
    const before = await report(await token(claims), body({ environment: 'dev' }));
    expect(before).toEqual({
      ok: false,
      status: 404,
      error:
        'No code project in Renkei reports for this repository: build its pipeline in Renkei, or take the report step from the project’s Pipeline tab.',
    });
    expect(await getDataStore().ciDeployments.recent([id], 10)).toEqual([]);
  });

  it('is taken once the project records how the host names its repository, with no pipeline built here', async () => {
    const id = await handmade('handmade', ['production', 'dev']);
    await getDataStore().ciRepoKeys.set(id, 'github', 'acme/handmade');
    const started = await report(await token(claims), body({ environment: 'Dev' }));
    expect(started).toMatchObject({
      ok: true,
      projectId: id,
      environment: 'dev',
      status: 'started',
      host: 'github',
    });
    await report(await token(claims), body({ environment: 'dev', status: 'succeeded' }));
    const rows = await getDataStore().ciDeployments.recent([id], 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      environment: 'dev',
      status: 'succeeded',
      commitSha: 'f04b6e9aa1',
      branch: 'develop',
      runId: 'github:77.1',
      actor: 'jordan',
    });
    // No pipeline row was made for it along the way.
    expect(await getDataStore().ciPipelines.listForProject(id)).toEqual([]);
  });

  it('still refuses an environment the project does not have', async () => {
    const id = await handmade('handmade', ['production']);
    await getDataStore().ciRepoKeys.set(id, 'github', 'acme/handmade');
    expect(await report(await token(claims), body({ environment: 'qa' }))).toEqual({
      ok: false,
      status: 400,
      error: 'The project Renkei keeps for acme/handmade has no environment qa.',
    });
  });

  it('a key recorded for another host’s repository of the same name does not take it', async () => {
    const id = await handmade('handmade', ['production', 'dev']);
    await getDataStore().ciRepoKeys.set(id, 'bitbucket', 'acme/handmade');
    expect(await report(await token(claims), body({ environment: 'dev' }))).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it('of two projects on the repository, the one that has the environment reported gets it', async () => {
    const live = await handmade('live', ['production']);
    const staging = await handmade('staging', ['production', 'staging']);
    // The one without the environment is the last recorded, so the first asked.
    await getDataStore().ciRepoKeys.set(staging, 'github', 'acme/handmade');
    await getDataStore().ciRepoKeys.set(live, 'github', 'acme/handmade');
    const taken = await report(await token(claims), body({ environment: 'staging' }));
    expect(taken).toMatchObject({ ok: true, projectId: staging, environment: 'staging' });
    expect(await getDataStore().ciDeployments.recent([live], 10)).toEqual([]);
    expect(await getDataStore().ciDeployments.recent([staging], 10)).toHaveLength(1);
  });

  it('a project whose builder wrote a pipeline for the repository comes before one that only took the step', async () => {
    const built = await codeProject(GITHUB, 'acme/handmade', 'acme/handmade');
    const stepOnly = await handmade('step-only', ['production', 'dev']);
    await getDataStore().ciRepoKeys.set(stepOnly, 'github', 'acme/handmade');
    const taken = await report(await token(claims), body({ environment: 'dev' }));
    expect(taken).toMatchObject({ ok: true, projectId: built });
  });
});

describe('what a report must carry', () => {
  it('a bearer token', async () => {
    expect(await report(null, body())).toMatchObject({ ok: false, status: 401 });
    expect(await report('not-a-jwt', body())).toEqual({
      ok: false,
      status: 401,
      error: 'The bearer token is not a JWT.',
    });
  });

  it('an environment, a status and a commit; the rest is kept only when it reads right', () => {
    expect(readReportBody(body({ status: 'deploying' }))).toEqual({
      ok: false,
      error: 'Say whether it started, succeeded or failed.',
    });
    expect(readReportBody(body({ commit: 'main' }))).toEqual({
      ok: false,
      error: 'Say which commit deployed.',
    });
    expect(
      readReportBody(body({ target: 'Not A Target', run: 'x', detail: 'line\nbreak' }))
    ).toEqual({
      ok: true,
      body: {
        environment: 'production',
        status: 'started',
        commit: 'abc1234def',
        branch: 'main',
        run: null,
        target: null,
        detail: 'line break',
      },
    });
  });
});
