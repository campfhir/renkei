/**
 * Issuing and taking away an environment's health token
 * (POST/DELETE /api/code/projects/:id/health-token), on the memory store:
 * who may, for which environments, and that the token is in the answer
 * and nowhere else — not in the audit log. What a token then does is
 * lib/ci/health.test.ts.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));
jest.mock('@/lib/get-origin', () => ({ getOrigin: jest.fn() }));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { grantResourceAccess } from '@/lib/chat/access';
import { recordCheckIn } from '@/lib/ci/health';
import { DELETE, POST } from './route';

const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');
const { recordAuditEvent } = jest.requireMock<{ recordAuditEvent: jest.Mock }>(
  '@/lib/audit-events'
);
const { getOrigin } = jest.requireMock<{ getOrigin: jest.Mock }>('@/lib/get-origin');

const OWNER = 'owner@example.com';
const VIEWER = 'viewer@example.com';

let projectId: string;

beforeEach(async () => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
  mockGetSession.mockResolvedValue({ subject: OWNER, roles: ['renkei-user'] });
  getOrigin.mockResolvedValue({ ok: true, val: 'https://renkei.example' });
  projectId = await getDataStore().chatProjects.create({
    ownerSubject: OWNER,
    name: 'Billing',
    description: null,
    toolConfig: null,
    repo: { provider: 'github', fullName: 'acme/billing', branch: 'main' },
  });
  await getDataStore().ciEnvironments.replace(
    projectId,
    [
      { name: 'Production', production: true, branches: ['main'] },
      { name: 'dev', production: false, branches: ['develop'] },
    ],
    OWNER
  );
});

afterEach(() => resetDataStore());

function call(handler: typeof POST, method: 'POST' | 'DELETE', body: unknown) {
  return handler(
    new NextRequest(`http://test.local/api/code/projects/${projectId}/health-token`, {
      method,
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ projectId }) }
  );
}
const issue = (environment: unknown) => call(POST, 'POST', { environment });
const revoke = (environment: unknown) => call(DELETE, 'DELETE', { environment });

describe('POST /api/code/projects/:id/health-token', () => {
  it('issues a token for one of the project’s environments, with where to check in', async () => {
    const response = await issue('dev');
    expect(response.status).toBe(200);
    const answered = await response.json();
    expect(answered).toEqual({
      token: expect.stringMatching(/^rkh_/),
      hint: answered.token.slice(-4),
      url: 'https://renkei.example/api/health/check-in',
      environment: 'dev',
    });
    // It works: a check-in made with it lands on that environment.
    const taken = await recordCheckIn({
      authorization: `Bearer ${answered.token}`,
      body: { status: 'healthy' },
      now: new Date(),
    });
    expect(taken.ok && taken.record.environment).toBe('dev');
  });

  it('names the environment as the project spells it, whatever case was sent', async () => {
    const answered = await (await issue('production')).json();
    expect(answered.environment).toBe('Production');
    expect((await getDataStore().ciHealth.listForProject(projectId))[0]?.environment).toBe(
      'Production'
    );
  });

  it('an environment the project does not have is refused', async () => {
    expect((await issue('qa')).status).toBe(400);
    expect((await issue('')).status).toBe(400);
    expect((await issue(undefined)).status).toBe(400);
    expect(await getDataStore().ciHealth.listForProject(projectId)).toEqual([]);
  });

  it('the audit log says a token was issued, by its last characters, never the token', async () => {
    const answered = await (await issue('dev')).json();
    expect(recordAuditEvent.mock.calls[0]?.[0]).toMatchObject({
      action: 'ci.health_token_issued',
      actorSubject: OWNER,
      details: { projectId, environment: 'dev', tokenHint: answered.hint },
    });
    expect(JSON.stringify(recordAuditEvent.mock.calls)).not.toContain(answered.token);
  });

  it('a viewer of the project cannot issue one', async () => {
    await grantResourceAccess(OWNER, 'chat_project', projectId, {
      granteeSubject: VIEWER,
      role: 'viewer',
      expiresAt: null,
    });
    mockGetSession.mockResolvedValue({ subject: VIEWER, roles: ['renkei-user'] });
    expect((await issue('dev')).status).toBe(403);
    expect(await getDataStore().ciHealth.listForProject(projectId)).toEqual([]);
  });

  it('when Renkei does not know its own address there is nowhere to check in, and no token', async () => {
    getOrigin.mockResolvedValue({ ok: false, err: 'CONFIG_ERROR' });
    const response = await issue('dev');
    expect(response.status).toBe(409);
    expect(await getDataStore().ciHealth.listForProject(projectId)).toEqual([]);
  });
});

describe('DELETE /api/code/projects/:id/health-token', () => {
  it('takes the token away, once', async () => {
    const answered = await (await issue('dev')).json();
    const first = await revoke('dev');
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ revoked: true });
    expect(await (await revoke('dev')).json()).toEqual({ revoked: false });
    const after = await recordCheckIn({
      authorization: `Bearer ${answered.token}`,
      body: { status: 'healthy' },
      now: new Date(),
    });
    expect(after).toMatchObject({ ok: false, status: 401 });
    expect(recordAuditEvent.mock.calls.map(([event]) => event.action)).toEqual([
      'ci.health_token_issued',
      'ci.health_token_revoked',
    ]);
  });

  it('needs to be told which environment', async () => {
    expect((await revoke('')).status).toBe(400);
  });

  it('a viewer cannot take one away', async () => {
    await issue('dev');
    await grantResourceAccess(OWNER, 'chat_project', projectId, {
      granteeSubject: VIEWER,
      role: 'viewer',
      expiresAt: null,
    });
    mockGetSession.mockResolvedValue({ subject: VIEWER, roles: ['renkei-user'] });
    expect((await revoke('dev')).status).toBe(403);
    expect(await getDataStore().ciHealth.listForProject(projectId)).toHaveLength(1);
  });
});
