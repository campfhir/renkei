/**
 * Asking for a larger checkout (POST /api/code/projects/:id/size-request),
 * on the memory store: what sandbox-size-requests.spec.ts checked through
 * a page before — one open ask per project (409), more than the current
 * limit and at most 64 GB, a reason required, and only a member's project.
 * The dialog's own rules are size-request.model.test.ts.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { invalidateSettingsCache, setOrgSettings } from '@renkei/settings';
import { latestSizeRequest } from '@/lib/code/size-requests';
import { POST } from './route';

const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');

const GB = 1_073_741_824;
const ME = 'member@example.com';

beforeEach(() => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
  invalidateSettingsCache();
  mockGetSession.mockResolvedValue({ subject: ME, roles: ['renkei-user'] });
});

afterEach(() => {
  resetDataStore();
  invalidateSettingsCache();
});

function codeProject(owner = ME, repo = true): Promise<string> {
  return getDataStore().chatProjects.create({
    ownerSubject: owner,
    name: 'Monorepo',
    description: null,
    toolConfig: null,
    ...(repo ? { repo: { provider: 'bitbucket', fullName: 'acme/monorepo', branch: 'main' } } : {}),
  });
}

function ask(projectId: string, body: unknown) {
  return POST(
    new NextRequest(`http://test.local/api/code/projects/${projectId}/size-request`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ projectId }) }
  );
}

describe('POST /api/code/projects/:id/size-request', () => {
  it('files a request that waits for an admin', async () => {
    const projectId = await codeProject();

    const response = await ask(projectId, {
      requestedBytes: 24 * GB,
      reason: '  Monorepo with vendored toolchains  ',
    });

    expect(response.status).toBe(201);
    expect(await latestSizeRequest(projectId)).toMatchObject({
      status: 'pending',
      requestedBytes: 24 * GB,
      requestedBy: ME,
      reason: 'Monorepo with vendored toolchains',
    });
  });

  it('refuses a second ask while the first waits', async () => {
    const projectId = await codeProject();
    expect((await ask(projectId, { requestedBytes: 24 * GB, reason: 'first' })).status).toBe(201);

    const duplicate = await ask(projectId, { requestedBytes: 30 * GB, reason: 'again' });

    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).error).toBe('A request for this project is already waiting');
    expect((await latestSizeRequest(projectId))?.requestedBytes).toBe(24 * GB);
  });

  it('asks for more than the organization’s limit, never at or under it', async () => {
    const projectId = await codeProject();
    const atLimit = await ask(projectId, { requestedBytes: 8 * GB, reason: 'more' });
    expect(atLimit.status).toBe(400);
    expect((await atLimit.json()).error).toBe('Ask for more than the current limit');

    // The limit is the organization's as stored now.
    await setOrgSettings({ sandboxWorkspaceMaxBytes: 12 * GB });
    invalidateSettingsCache();
    expect((await ask(projectId, { requestedBytes: 10 * GB, reason: 'more' })).status).toBe(400);
    expect(await latestSizeRequest(projectId)).toBeNull();
  });

  it('asks for at most 64 GB', async () => {
    const projectId = await codeProject();
    const response = await ask(projectId, { requestedBytes: 65 * GB, reason: 'all of it' });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('The most that can be requested is 64 GB');
  });

  it('needs a reason', async () => {
    const projectId = await codeProject();
    expect((await ask(projectId, { requestedBytes: 24 * GB, reason: '   ' })).status).toBe(400);
    expect((await ask(projectId, { requestedBytes: 24 * GB })).status).toBe(400);
    expect(await latestSizeRequest(projectId)).toBeNull();
  });

  it('is only for a code project the person can reach', async () => {
    const someoneElses = await codeProject('owner@example.com');
    expect((await ask(someoneElses, { requestedBytes: 24 * GB, reason: 'x' })).status).toBe(404);

    const chatProject = await codeProject(ME, false);
    expect((await ask(chatProject, { requestedBytes: 24 * GB, reason: 'x' })).status).toBe(404);
  });

  it('needs a signed-in person', async () => {
    mockGetSession.mockResolvedValue(null);
    const projectId = await codeProject();
    expect((await ask(projectId, { requestedBytes: 24 * GB, reason: 'x' })).status).toBe(401);
  });
});
