/**
 * Deployment reports from pipeline steps, with tokens signed here as each
 * host signs them: a GitHub job's token (Renkei as its audience) and a
 * Bitbucket step's (its repository's UUID) land on the code project whose
 * builder wrote that repository's pipeline — a start, then its outcome on
 * the same row — and everything else is refused with nothing recorded: no
 * token, a token another issuer or key signed, one for another audience or
 * repository, an environment the pipeline does not have.
 */

import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTPayload,
} from 'jose';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { ATLASSIAN_BITBUCKET, GITHUB } from '@renkei/provider-grants';
import { readReportBody, recordDeploymentReport } from './deployment-reports';
import type { KeysFor } from './oidc';

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

const spec = {
  checks: [],
  environments: [
    { name: 'dev', branch: 'develop', steps: [] },
    { name: 'production', branch: 'main', steps: [] },
  ],
};

async function codeProject(provider: string, fullName: string, repoKey: string): Promise<string> {
  const store = getDataStore();
  const id = await store.chatProjects.create({
    ownerSubject: 'auth0|ada',
    name: fullName.split('/')[1],
    description: null,
    toolConfig: null,
    repo: { provider, fullName, branch: 'main' },
  });
  await store.ciPipelines.save(id, {
    host: provider === GITHUB ? 'github' : 'bitbucket',
    spec,
    updatedBy: 'auth0|ada',
  });
  await store.ciPipelines.setRepoKey(id, repoKey);
  await store.ciPipelines.markWritten(id, { text: 'pipelines: {}', pullRequestUrl: null });
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

  it('is refused for a repository no project built a pipeline for, or an environment it does not have', async () => {
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
      error: 'The pipeline Renkei built for acme/portal-web has no environment qa.',
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
