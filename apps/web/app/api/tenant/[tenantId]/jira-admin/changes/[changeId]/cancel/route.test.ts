/**
 * Withdrawing a Jira admin change request: its owner only, and only while
 * it waits for review.
 */

jest.mock('@renkei/db', () => ({ getDatabase: () => ({ ok: true, val: {} }) }));
jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@/lib/jira-admin/change-requests', () => ({
  getChangeRequest: jest.fn(),
  cancelChangeRequest: jest.fn(),
}));

import { NextRequest } from 'next/server';
import { POST } from './route';
import { getSessionFromRequest } from '@/lib/session';
import { cancelChangeRequest, getChangeRequest } from '@/lib/jira-admin/change-requests';

const TENANT = '00000000-0000-4000-8000-000000000001';
const CHANGE = '6f1d3c1e-8c1a-4f5e-9a55-2b7a0c9e4d11';

function cancel() {
  const request = new NextRequest(
    `http://localhost/api/tenant/${TENANT}/jira-admin/changes/${CHANGE}/cancel`,
    { method: 'POST' }
  );
  return POST(request, { params: Promise.resolve({ tenantId: TENANT, changeId: CHANGE }) });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getSessionFromRequest).mockResolvedValue({
    id: 'session-1',
    tenantId: TENANT,
    subject: 'owner',
    roles: [],
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  const now = new Date();
  jest.mocked(getChangeRequest).mockResolvedValue({
    id: CHANGE,
    subject: 'owner',
    agentId: null,
    cloudId: 'cloud-1',
    siteUrl: null,
    kind: 'field_options',
    title: 'Source (Ops context): add option “Vendor”',
    reason: null,
    payload: {},
    status: 'pending',
    results: null,
    expiresAt: new Date(now.getTime() + 3_600_000),
    createdAt: now,
    updatedAt: now,
    appliedBy: null,
    appliedAt: null,
    cancelledAt: null,
  });
  jest.mocked(cancelChangeRequest).mockResolvedValue(true);
});

it('refuses without a signed-in session', async () => {
  jest.mocked(getSessionFromRequest).mockResolvedValue(null);
  expect((await cancel()).status).toBe(401);
  expect(cancelChangeRequest).not.toHaveBeenCalled();
});

it('reads someone else’s request as not found', async () => {
  jest.mocked(getChangeRequest).mockResolvedValue(null);
  expect((await cancel()).status).toBe(404);
  expect(cancelChangeRequest).not.toHaveBeenCalled();
});

it('cancels a pending request under the caller', async () => {
  const response = await cancel();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'cancelled' });
  expect(jest.mocked(cancelChangeRequest).mock.calls[0]?.slice(1)).toEqual([
    TENANT,
    'owner',
    CHANGE,
  ]);
});

it('refuses one that is no longer waiting', async () => {
  jest.mocked(cancelChangeRequest).mockResolvedValue(false);
  expect((await cancel()).status).toBe(409);
});
