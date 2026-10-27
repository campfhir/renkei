/**
 * Withdrawing or declining a Jira admin change request: the person who
 * asked may withdraw theirs, an operator may decline anyone's (and the
 * requester is told), and only while it waits for review.
 */

jest.mock('@renkei/db', () => ({ getDatabase: () => ({ ok: true, val: {} }) }));
jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@/lib/admin-changes/notify', () => ({ notifyChangeOutcome: jest.fn() }));
jest.mock('@/lib/jira-admin/change-requests', () => ({
  ...jest.requireActual<typeof import('@/lib/jira-admin/change-requests')>(
    '@/lib/jira-admin/change-requests'
  ),
  getChangeRequestById: jest.fn(),
  cancelChangeRequest: jest.fn(),
}));

import { NextRequest } from 'next/server';
import { POST } from './route';
import { getSessionFromRequest } from '@/lib/session';
import { notifyChangeOutcome } from '@/lib/admin-changes/notify';
import { cancelChangeRequest, getChangeRequestById } from '@/lib/jira-admin/change-requests';

const CHANGE = '6f1d3c1e-8c1a-4f5e-9a55-2b7a0c9e4d11';

function cancel(body?: unknown) {
  const request = new NextRequest(`http://localhost/api/jira-admin/changes/${CHANGE}/cancel`, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return POST(request, { params: Promise.resolve({ changeId: CHANGE }) });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getSessionFromRequest).mockResolvedValue({
    id: 'session-1',
    subject: 'owner',
    roles: [],
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  const now = new Date();
  jest.mocked(getChangeRequestById).mockResolvedValue({
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
    approvedBy: null,
    approvedAt: null,
    step: null,
    resolution: null,
  });
  jest.mocked(cancelChangeRequest).mockResolvedValue(true);
});

it('refuses without a signed-in session', async () => {
  jest.mocked(getSessionFromRequest).mockResolvedValue(null);
  expect((await cancel()).status).toBe(401);
  expect(cancelChangeRequest).not.toHaveBeenCalled();
});

it('reads someone else’s request as not found to an ordinary user', async () => {
  jest.mocked(getSessionFromRequest).mockResolvedValue({
    id: 'session-2',
    subject: 'stranger',
    roles: ['renkei-user'],
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  expect((await cancel()).status).toBe(404);
  expect(cancelChangeRequest).not.toHaveBeenCalled();
});

it('reads an unknown request as not found', async () => {
  jest.mocked(getChangeRequestById).mockResolvedValue(null);
  expect((await cancel()).status).toBe(404);
  expect(cancelChangeRequest).not.toHaveBeenCalled();
});

it('withdraws the caller’s own pending request without telling anyone', async () => {
  const response = await cancel();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'cancelled' });
  expect(jest.mocked(cancelChangeRequest).mock.calls[0]?.slice(0)).toEqual([
    'owner',
    CHANGE,
    { operator: false, note: '' },
  ]);
  expect(notifyChangeOutcome).not.toHaveBeenCalled();
});

it('lets an operator decline anyone’s request with a note, and tells the requester', async () => {
  jest.mocked(getSessionFromRequest).mockResolvedValue({
    id: 'session-3',
    subject: 'operator',
    roles: ['renkei-user', 'renkei-operator'],
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  const response = await cancel({ note: 'Use the existing Source field' });
  expect(response.status).toBe(200);
  expect(jest.mocked(cancelChangeRequest).mock.calls[0]?.slice(0)).toEqual([
    'operator',
    CHANGE,
    { operator: true, note: 'Use the existing Source field' },
  ]);
  expect(notifyChangeOutcome).toHaveBeenCalledWith(
    expect.objectContaining({
      connector: 'jira-admin',
      requester: 'owner',
      outcome: 'declined',
      note: 'Use the existing Source field',
    })
  );
});

it('refuses one that is no longer waiting', async () => {
  jest.mocked(cancelChangeRequest).mockResolvedValue(false);
  expect((await cancel()).status).toBe(409);
  expect(notifyChangeOutcome).not.toHaveBeenCalled();
});
