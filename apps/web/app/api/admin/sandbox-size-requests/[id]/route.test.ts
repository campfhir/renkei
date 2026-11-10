/**
 * An admin deciding a request for a larger checkout
 * (POST /api/admin/sandbox-size-requests/:id), on the memory store: an
 * approval raises that project's limit only (to what the admin approved),
 * a denial keeps the limit and carries the note, and a request already
 * decided is refused. These were sandbox-size-requests.spec.ts's approve
 * and deny steps; the row's own rules are size-requests.model.test.ts.
 */

jest.mock('@/lib/access', () => ({ checkAccess: jest.fn(), ROLE_OPERATOR: 'renkei-operator' }));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { getWorkspaceLimitBytes, invalidateSettingsCache } from '@renkei/settings';
import { createSizeRequest, latestSizeRequest, listSizeRequests } from '@/lib/code/size-requests';
import { codeProjectTarget } from '@/lib/code/scope';
import { POST } from './route';

const { checkAccess: mockCheckAccess } = jest.requireMock<{ checkAccess: jest.Mock }>(
  '@/lib/access'
);

const GB = 1_073_741_824;
const MEMBER = 'member@example.com';

beforeEach(() => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
  invalidateSettingsCache();
  mockCheckAccess.mockResolvedValue({ subject: 'operator@example.com' });
});

afterEach(() => {
  resetDataStore();
  invalidateSettingsCache();
});

async function waitingRequest(name = 'Monorepo', bytes = 24 * GB) {
  const projectId = await getDataStore().chatProjects.create({
    ownerSubject: MEMBER,
    name,
    description: null,
    toolConfig: null,
    repo: { provider: 'bitbucket', fullName: `acme/${name.toLowerCase()}`, branch: 'main' },
  });
  const created = await createSizeRequest({
    projectId,
    projectName: name,
    requestedBy: MEMBER,
    requestedBytes: bytes,
    reason: 'Monorepo with vendored toolchains',
  });
  if (!created) throw new Error('request not created');
  return { projectId, requestId: created.id };
}

function decide(id: string, body: unknown) {
  return POST(
    new NextRequest(`http://test.local/api/admin/sandbox-size-requests/${id}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
}

async function limitOf(projectId: string): Promise<number> {
  const limit = await getWorkspaceLimitBytes(codeProjectTarget(projectId).subject);
  if (!limit.ok) throw new Error('no limit');
  return limit.val;
}

describe('POST /api/admin/sandbox-size-requests/:id', () => {
  it('lists the waiting request for the admin, with its project, size and reason', async () => {
    await waitingRequest();
    expect(await listSizeRequests()).toEqual([
      expect.objectContaining({
        projectName: 'Monorepo',
        requestedBytes: 24 * GB,
        reason: 'Monorepo with vendored toolchains',
        status: 'pending',
      }),
    ]);
  });

  it('approving less than was asked raises that project’s limit to the approved size, and no other', async () => {
    const { projectId, requestId } = await waitingRequest();
    const other = await waitingRequest('Other', 30 * GB);
    expect(await limitOf(projectId)).toBe(8 * GB);

    const response = await decide(requestId, {
      decision: 'approved',
      note: '',
      approvedBytes: 20 * GB,
    });

    expect(response.status).toBe(200);
    expect(await limitOf(projectId)).toBe(20 * GB);
    expect(await limitOf(other.projectId)).toBe(8 * GB);
    expect(await latestSizeRequest(projectId)).toMatchObject({
      status: 'approved',
      requestedBytes: 20 * GB,
      decisionNote: null,
    });
  });

  it('a denial keeps the limit and carries the note the person sees', async () => {
    const { projectId, requestId } = await waitingRequest();

    const response = await decide(requestId, {
      decision: 'denied',
      note: '  Prune build output first  ',
    });

    expect(response.status).toBe(200);
    expect(await limitOf(projectId)).toBe(8 * GB);
    expect(await latestSizeRequest(projectId)).toMatchObject({
      status: 'denied',
      decisionNote: 'Prune build output first',
    });
  });

  it('refuses to decide a request twice', async () => {
    const { requestId } = await waitingRequest();
    expect((await decide(requestId, { decision: 'denied', note: '' })).status).toBe(200);

    const again = await decide(requestId, { decision: 'approved', note: '' });

    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe('That request is not pending');
  });

  it('refuses a decision that is neither, and an approval outside 1–64 GB', async () => {
    const { projectId, requestId } = await waitingRequest();
    expect((await decide(requestId, { decision: 'maybe' })).status).toBe(400);
    expect(
      (await decide(requestId, { decision: 'approved', approvedBytes: 100 * GB })).status
    ).toBe(400);
    expect((await latestSizeRequest(projectId))?.status).toBe('pending');
  });

  it('is an operator’s', async () => {
    const { requestId } = await waitingRequest();
    mockCheckAccess.mockResolvedValue(null);
    expect((await decide(requestId, { decision: 'denied' })).status).toBe(401);
  });

  it('answers 404 for an id that is not one', async () => {
    expect((await decide('nope', { decision: 'denied' })).status).toBe(404);
  });
});
