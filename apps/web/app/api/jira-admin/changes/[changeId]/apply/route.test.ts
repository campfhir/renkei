/**
 * The approve route — the only path by which a Jira admin change reaches
 * Jira. What it must guarantee: a signed-in operator (and only one), a
 * pending request that is a proposal rather than a request in words, an
 * org that still allows it, the same Jira site it was proposed for, one
 * winner per request — and that approving only queues it: the job runs
 * after the response, from the stored row, never from the browser.
 */

jest.mock('@renkei/db', () => ({ getDatabase: () => ({ ok: true, val: {} }) }));
jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('next/server', () => ({
  ...jest.requireActual<typeof import('next/server')>('next/server'),
  after: jest.fn(),
}));
jest.mock('@/lib/jira-admin/apply', () => ({ applyGate: jest.fn() }));
jest.mock('@/lib/jira-admin/apply-job', () => ({
  resolveApplyAccess: jest.fn(),
  runApplyJob: jest.fn(),
}));
jest.mock('@/lib/jira-admin/change-requests', () => {
  const actual = jest.requireActual<typeof import('@/lib/jira-admin/change-requests')>(
    '@/lib/jira-admin/change-requests'
  );
  return {
    ...actual,
    getChangeRequestById: jest.fn(),
    queueChangeRequest: jest.fn(),
  };
});

import { authedFetch } from '@renkei/delegate-client';
import { NextRequest, after } from 'next/server';
import { POST } from './route';
import { getSessionFromRequest } from '@/lib/session';
import { applyGate } from '@/lib/jira-admin/apply';
import { resolveApplyAccess, runApplyJob } from '@/lib/jira-admin/apply-job';
import {
  getChangeRequestById,
  queueChangeRequest,
  type ChangeRequest,
} from '@/lib/jira-admin/change-requests';

const CHANGE = '6f1d3c1e-8c1a-4f5e-9a55-2b7a0c9e4d11';
const PAYLOAD = { operations: [{ op: 'add', values: ['Vendor'] }] };

function change(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  const now = new Date();
  return {
    id: CHANGE,
    subject: 'owner',
    agentId: null,
    cloudId: 'cloud-1',
    siteUrl: 'https://acme.atlassian.net',
    kind: 'field_options',
    title: 'Source (Ops context): add option “Vendor”',
    reason: null,
    payload: PAYLOAD,
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
    ...overrides,
  };
}

function apply(body?: unknown) {
  const request = new NextRequest(`http://localhost/api/jira-admin/changes/${CHANGE}/apply`, {
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
    subject: 'operator',
    roles: ['renkei-user', 'renkei-operator'],
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  // Someone else asked; the operator approves.
  jest.mocked(getChangeRequestById).mockResolvedValue(change({ subject: 'requester' }));
  jest.mocked(applyGate).mockResolvedValue({ ok: true });
  jest.mocked(resolveApplyAccess).mockResolvedValue({
    access: {
      cloudId: 'cloud-1',
      siteUrl: 'https://acme.atlassian.net',
      accountId: 'acct-1',
      // The delegate's fetcher stands in for the grant; nothing here calls it.
      auth: authedFetch((url, init) => fetch(url, init), 'atlassian-admin:acct-1'),
    },
  });
  jest.mocked(queueChangeRequest).mockResolvedValue(true);
});

it('refuses without a signed-in session', async () => {
  jest.mocked(getSessionFromRequest).mockResolvedValue(null);
  const response = await apply();
  expect(response.status).toBe(401);
  expect(queueChangeRequest).not.toHaveBeenCalled();
});

it('refuses anyone who is not an operator, even the person who asked', async () => {
  jest.mocked(getSessionFromRequest).mockResolvedValue({
    id: 'session-2',
    subject: 'requester',
    roles: ['renkei-user'],
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  const response = await apply();
  expect(response.status).toBe(403);
  expect((await response.json()).error).toMatch(/operator/);
  expect(queueChangeRequest).not.toHaveBeenCalled();
  expect(after).not.toHaveBeenCalled();
});

it('reads an unknown request as not found', async () => {
  jest.mocked(getChangeRequestById).mockResolvedValue(null);
  expect((await apply()).status).toBe(404);
});

it('will not approve a request in words: there is nothing in it to run', async () => {
  jest.mocked(getChangeRequestById).mockResolvedValue(change({ kind: 'request' }));
  const response = await apply();
  expect(response.status).toBe(409);
  expect((await response.json()).error).toMatch(/request in words/);
  expect(queueChangeRequest).not.toHaveBeenCalled();
});

it('refuses a request that is no longer pending, or has expired', async () => {
  jest.mocked(getChangeRequestById).mockResolvedValue(change({ status: 'applied' }));
  let response = await apply();
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: 'This change request has already been applied.',
  });

  jest.mocked(getChangeRequestById).mockResolvedValue(change({ status: 'queued' }));
  response = await apply();
  expect(response.status).toBe(409);
  expect((await response.json()).error).toMatch(/already approved/);

  jest
    .mocked(getChangeRequestById)
    .mockResolvedValue(change({ expiresAt: new Date(Date.now() - 1000) }));
  response = await apply();
  expect(response.status).toBe(409);
  expect((await response.json()).error).toMatch(/expired/);
  expect(queueChangeRequest).not.toHaveBeenCalled();
});

it('says why when the org no longer allows it, and queues nothing', async () => {
  jest.mocked(applyGate).mockResolvedValue({
    ok: false,
    reason: 'Your organization is in read-only mode, so admin changes cannot be applied.',
  });
  const response = await apply();
  expect(response.status).toBe(403);
  expect((await response.json()).error).toMatch(/read-only mode/);
  expect(queueChangeRequest).not.toHaveBeenCalled();
  expect(after).not.toHaveBeenCalled();
});

it('says so at once when the operator has no usable connection, rather than failing later', async () => {
  jest
    .mocked(resolveApplyAccess)
    .mockResolvedValue('Your Jira Administration connection is on a different Jira site.');
  const response = await apply();
  expect(response.status).toBe(409);
  expect((await response.json()).error).toMatch(/different Jira site/);
  expect(queueChangeRequest).not.toHaveBeenCalled();
});

it('lets a second click lose the queueing instead of applying twice', async () => {
  jest.mocked(queueChangeRequest).mockResolvedValue(false);
  const response = await apply();
  expect(response.status).toBe(409);
  expect(after).not.toHaveBeenCalled();
});

it('queues it under the approving operator, answers at once, and runs the job afterwards', async () => {
  const response = await apply({ operations: [{ op: 'add', values: ['Injected'] }] });

  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ status: 'queued' });
  expect(queueChangeRequest).toHaveBeenCalledWith(CHANGE, 'operator');
  // The access is resolved for the operator who approved, not the requester.
  expect(jest.mocked(resolveApplyAccess).mock.calls[0]?.[0]).toBe('operator');
  // Nothing runs in the request itself; the job is handed to after().
  expect(runApplyJob).not.toHaveBeenCalled();
  expect(after).toHaveBeenCalledTimes(1);
  const job = jest.mocked(after).mock.calls[0]?.[0];
  if (typeof job !== 'function') throw new Error('expected a callback');
  await job();
  expect(runApplyJob).toHaveBeenCalledWith(CHANGE);
});
