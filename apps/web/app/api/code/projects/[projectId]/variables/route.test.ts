/**
 * Saving pipeline variables (PUT /api/code/projects/:id/variables), on the
 * memory store with the host stood in for: who may save, which set a save
 * names, and — the reason this route has a test of its own — that a value
 * goes to the host and nowhere else: not into the audit log, not into a
 * log line, not back in the answer. What the host is then asked is
 * lib/code/host-variables.test.ts.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));
jest.mock('@/lib/code/access', () => ({
  ...jest.requireActual('@/lib/code/access'),
  grantScopes: jest.fn(),
}));
jest.mock('@/lib/code/github-browse', () => ({ githubAuthFor: jest.fn(async () => ({})) }));
jest.mock('@/lib/code/bitbucket-browse', () => ({ bitbucketAuthFor: jest.fn(async () => ({})) }));
jest.mock('@/lib/code/host-variables', () => ({
  ...jest.requireActual('@/lib/code/host-variables'),
  applyGithubVariables: jest.fn(),
  applyBitbucketVariables: jest.fn(),
}));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { grantResourceAccess } from '@/lib/chat/access';
import { PUT } from './route';

const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');
const { grantScopes } = jest.requireMock<{ grantScopes: jest.Mock }>('@/lib/code/access');
const { applyGithubVariables, applyBitbucketVariables } = jest.requireMock<{
  applyGithubVariables: jest.Mock;
  applyBitbucketVariables: jest.Mock;
}>('@/lib/code/host-variables');
const { recordAuditEvent } = jest.requireMock<{ recordAuditEvent: jest.Mock }>(
  '@/lib/audit-events'
);
const { logger } = jest.requireMock<{ logger: Record<string, jest.Mock> }>('@/lib/logger');

const OWNER = 'owner@example.com';
const VIEWER = 'viewer@example.com';
const SECRET = 'tok-never-written-down-9f2c';

beforeEach(() => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
  mockGetSession.mockResolvedValue({ subject: OWNER, roles: ['renkei-user'] });
  grantScopes.mockResolvedValue(['actions:configure', 'pipeline:variable']);
  const applied = {
    ok: true,
    created: false,
    applied: { added: ['DEPLOY_TOKEN'], changed: [], removed: [], errors: [] },
  };
  applyGithubVariables.mockResolvedValue(applied);
  applyBitbucketVariables.mockResolvedValue(applied);
});

afterEach(() => resetDataStore());

function project(provider: 'github' | 'atlassian-bitbucket' = 'github'): Promise<string> {
  return getDataStore().chatProjects.create({
    ownerSubject: OWNER,
    name: 'Billing',
    description: null,
    toolConfig: null,
    repo: { provider, fullName: 'acme/billing', branch: 'main' },
  });
}

function save(projectId: string, body: unknown) {
  return PUT(
    new NextRequest(`http://test.local/api/code/projects/${projectId}/variables`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ projectId }) }
  );
}

const change = {
  scope: 'repository',
  set: [{ key: 'DEPLOY_TOKEN', value: SECRET, secured: true }],
  remove: [],
};

describe('PUT /api/code/projects/:id/variables', () => {
  it('sends the change to the project’s host, the repository’s set unless an environment is named', async () => {
    const projectId = await project();
    const response = await save(projectId, change);
    expect(response.status).toBe(200);
    expect(applyGithubVariables).toHaveBeenCalledWith(expect.anything(), 'acme/billing', null, {
      set: [{ key: 'DEPLOY_TOKEN', value: SECRET, secured: true }],
      remove: [],
    });
    expect(applyBitbucketVariables).not.toHaveBeenCalled();
  });

  it('a Bitbucket project’s change goes to Bitbucket', async () => {
    const projectId = await project('atlassian-bitbucket');
    expect((await save(projectId, change)).status).toBe(200);
    expect(applyBitbucketVariables).toHaveBeenCalled();
    expect(applyGithubVariables).not.toHaveBeenCalled();
  });

  it('an environment’s set is one of the project’s own environments, named as the project spells it', async () => {
    const projectId = await project();
    await getDataStore().ciEnvironments.replace(
      projectId,
      [
        { name: 'Production', production: true, branches: ['main'] },
        { name: 'dev', production: false, branches: ['develop'] },
      ],
      OWNER
    );
    await save(projectId, { ...change, scope: 'environment', environment: 'production' });
    expect(applyGithubVariables.mock.calls[0]?.[2]).toEqual({
      name: 'Production',
      production: true,
    });
    const unknown = await save(projectId, { ...change, scope: 'environment', environment: 'qa' });
    expect(unknown.status).toBe(400);
    expect(applyGithubVariables).toHaveBeenCalledTimes(1);
  });

  it('a value goes to the host and nowhere else: not the audit log, a log line or the answer', async () => {
    const projectId = await project();
    applyGithubVariables.mockResolvedValue({
      ok: true,
      created: false,
      applied: {
        added: ['DEPLOY_TOKEN'],
        changed: [],
        removed: [],
        errors: ['OTHER: GitHub refused it.'],
      },
    });
    const response = await save(projectId, change);
    const answered = JSON.stringify(await response.json());
    const audited = JSON.stringify(recordAuditEvent.mock.calls);
    const logged = JSON.stringify(Object.values(logger).flatMap((fn) => fn.mock.calls));
    for (const text of [answered, audited, logged]) expect(text).not.toContain(SECRET);
    // The audit log says which names changed, and which were saved as secrets.
    expect(recordAuditEvent.mock.calls[0]?.[0]).toMatchObject({
      action: 'code.variables.saved',
      actorSubject: OWNER,
      details: { added: ['DEPLOY_TOKEN'], secrets: ['DEPLOY_TOKEN'], environment: null },
    });
  });

  it('a viewer of the project cannot save', async () => {
    const projectId = await project();
    await grantResourceAccess(OWNER, 'chat_project', projectId, {
      granteeSubject: VIEWER,
      role: 'viewer',
      expiresAt: null,
    });
    mockGetSession.mockResolvedValue({ subject: VIEWER, roles: ['renkei-user'] });
    expect((await save(projectId, change)).status).toBe(403);
    expect(applyGithubVariables).not.toHaveBeenCalled();
  });

  it('a connection that cannot set variables is told so before the host is asked', async () => {
    const projectId = await project();
    grantScopes.mockResolvedValue(['repository']);
    const response = await save(projectId, change);
    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/Reconnect GitHub on the Connectors page/);
    expect(applyGithubVariables).not.toHaveBeenCalled();
  });

  it('a change that is not one is refused whole, and the old text form is not read', async () => {
    const projectId = await project();
    expect((await save(projectId, { scope: 'repository', set: [], remove: [] })).status).toBe(400);
    expect((await save(projectId, { text: `secret DEPLOY_TOKEN=${SECRET}` })).status).toBe(400);
    expect(applyGithubVariables).not.toHaveBeenCalled();
  });

  it('making the host’s environment needs no variable', async () => {
    const projectId = await project();
    const response = await save(projectId, {
      scope: 'environment',
      environment: 'production',
      create: true,
      set: [],
      remove: [],
    });
    expect(response.status).toBe(200);
    expect(applyGithubVariables.mock.calls[0]?.[3]).toEqual({ set: [], remove: [] });
  });

  it('a host that does not take the change is a 502 with its reason', async () => {
    const projectId = await project();
    applyGithubVariables.mockResolvedValue({ ok: false, error: 'GitHub is down.' });
    const response = await save(projectId, change);
    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe('GitHub is down.');
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });
});
