/**
 * What the deployments tools answer a chat or an agent, on the memory
 * store: the code projects a person owns or was given, each environment
 * with its last deployment and the health its application reports — and
 * nobody else's projects, no token, no variable.
 */

jest.mock('./deployment-changes', () => ({
  raiseChange: jest.fn(async () => true),
  settleHealth: jest.fn(async () => null),
}));

import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { codeProjectsOf, deploymentHistory, projectStatus, statusText } from './deployment-status';
import { issueHealthToken, recordCheckIn } from './health';

const ADA = 'auth0|ada';
const BOB = 'auth0|bob';
const AT = Date.parse('2026-11-24T10:00:00Z');
const MINUTE = 60_000;

async function codeProject(owner: string, name: string): Promise<string> {
  return getDataStore().chatProjects.create({
    ownerSubject: owner,
    name,
    description: null,
    toolConfig: null,
    repo: {
      provider: 'atlassian-bitbucket',
      fullName: `acme/${name.toLowerCase()}`,
      branch: 'main',
    },
  });
}

async function deployed(
  projectId: string,
  status: 'started' | 'succeeded' | 'failed',
  run: string,
  at: number
) {
  await getDataStore().ciDeployments.record({
    projectId,
    environment: 'production',
    status,
    commitSha: `${run}c1d9e7af0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5`.slice(0, 40),
    branch: 'main',
    target: null,
    runId: `bitbucket:${run}`,
    runUrl: `https://bitbucket.org/acme/shop/pipelines/results/${run}`,
    detail: status === 'failed' ? 'exit code 1' : null,
    actor: null,
    at: new Date(at),
  });
}

beforeEach(() => registerDataStore(createMemoryDataStore()));
afterEach(() => resetDataStore());

describe('whose projects', () => {
  it('the code projects a person owns and those shared with them, by name', async () => {
    const shop = await codeProject(ADA, 'Shop');
    const billing = await codeProject(BOB, 'Billing');
    await codeProject(BOB, 'Secret');
    await getDataStore().chatProjects.create({
      ownerSubject: ADA,
      name: 'Notes',
      description: null,
      toolConfig: null,
    });
    await getDataStore().resourceGrants.upsert({
      resourceKind: 'chat_project',
      resourceId: billing,
      ownerSubject: BOB,
      granteeSubject: ADA,
      role: 'viewer',
      expiresAt: null,
    });
    expect((await codeProjectsOf(ADA)).map((p) => p.name)).toEqual(['Billing', 'Shop']);
    expect((await codeProjectsOf(ADA, shop)).map((p) => p.name)).toEqual(['Shop']);
  });

  it('nobody else’s, even asked for by id', async () => {
    const secret = await codeProject(BOB, 'Secret');
    expect(await codeProjectsOf(ADA, secret)).toEqual([]);
  });
});

describe('how a project stands', () => {
  it('shows the last deployment, what is running, and the health reported', async () => {
    const id = await codeProject(ADA, 'Shop');
    const [project] = await codeProjectsOf(ADA, id);
    if (!project) throw new Error('no project');
    await deployed(id, 'succeeded', '7', AT - 60 * MINUTE);
    await deployed(id, 'failed', '8', AT - 10 * MINUTE);
    const { token } = await issueHealthToken(id, 'production', ADA, new Date(AT - 30 * MINUTE));
    await recordCheckIn({
      authorization: `Bearer ${token}`,
      body: {
        status: 'degraded',
        message: 'queue depth 40',
        version: '1.4.2',
        nextCheckInSeconds: 60,
      },
      now: new Date(AT),
    });

    const status = await projectStatus(project, new Date(AT + 30_000));
    expect(status.environments).toHaveLength(1);
    expect(status.environments[0]).toMatchObject({
      name: 'production',
      production: true,
      latest: { status: 'failed', detail: 'exit code 1' },
      running: { status: 'succeeded' },
      health: { state: 'degraded', missed: 0, message: 'queue depth 40', version: '1.4.2' },
    });
    const text = statusText([status]);
    expect(text).toContain(`Project "Shop" (acme/shop) — id ${id}`);
    expect(text).toContain('production (production)');
    expect(text).toContain('last deployment: failed commit 8c1d9e7 from main');
    expect(text).toContain('running: succeeded commit 7c1d9e7');
    expect(text).toContain('health: degraded');
    expect(text).toContain('said: queue depth 40');
    // The token and its hint stay out.
    expect(JSON.stringify(status)).not.toContain(token);
    expect(JSON.stringify(status)).not.toContain(token.slice(-4));
  });

  it('reads silence as the page does: potentially failing, then failed', async () => {
    const id = await codeProject(ADA, 'Shop');
    const [project] = await codeProjectsOf(ADA, id);
    if (!project) throw new Error('no project');
    const { token } = await issueHealthToken(id, 'production', ADA, new Date(AT - MINUTE));
    await recordCheckIn({
      authorization: `Bearer ${token}`,
      body: { status: 'healthy', nextCheckInSeconds: 60 },
      now: new Date(AT),
    });
    const late = await projectStatus(project, new Date(AT + 2 * MINUTE));
    expect(late.environments[0]?.health).toMatchObject({ state: 'late', missed: 1 });
    expect(statusText([late])).toContain('potentially failing (a check-in is overdue)');
    const failed = await projectStatus(project, new Date(AT + 4 * MINUTE));
    expect(failed.environments[0]?.health?.state).toBe('failed');
  });

  it('says so when nothing was reported and the application does not check in', async () => {
    const id = await codeProject(ADA, 'Shop');
    const [project] = await codeProjectsOf(ADA, id);
    if (!project) throw new Error('no project');
    const text = statusText([await projectStatus(project, new Date(AT))]);
    expect(text).toContain('last deployment: none reported');
    expect(text).toContain('health: the application does not check in');
    expect(statusText([])).toBe('No code project of yours has anything to show.');
  });
});

describe('a project’s history', () => {
  it('is its deployments newest first, one environment’s when asked', async () => {
    const id = await codeProject(ADA, 'Shop');
    await deployed(id, 'succeeded', '7', AT - 60 * MINUTE);
    await deployed(id, 'failed', '8', AT - 10 * MINUTE);
    expect((await deploymentHistory(id, null, 10)).map((d) => d.status)).toEqual([
      'failed',
      'succeeded',
    ]);
    expect(await deploymentHistory(id, 'PRODUCTION', 1)).toHaveLength(1);
    expect(await deploymentHistory(id, 'staging', 10)).toEqual([]);
  });
});
