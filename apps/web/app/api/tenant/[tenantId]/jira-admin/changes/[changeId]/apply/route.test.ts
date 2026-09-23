/**
 * The apply route — the only path by which a Jira admin change reaches
 * Jira. What it must guarantee: a signed-in owner, a pending request, an
 * org that still allows it, the same Jira site it was proposed for, one
 * winner per request, and operations taken from the stored row, never from
 * the browser. And every apply lands in the audit trail, however it ended.
 */

jest.mock('@renkei/db', () => ({ getDatabase: () => ({ ok: true, val: {} }) }));
jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@/lib/get-origin', () => ({
  getOrigin: async () => ({ ok: true, val: 'https://renkei.example' }),
}));
jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));
jest.mock('@/lib/mcp-tools/jira-admin/client', () => ({ resolveJiraAdminAccess: jest.fn() }));
jest.mock('@/lib/jira-admin/apply', () => ({
  applyGate: jest.fn(),
  applyChangeRequest: jest.fn(),
}));
jest.mock('@/lib/jira-admin/change-requests', () => {
  const actual = jest.requireActual<typeof import('@/lib/jira-admin/change-requests')>(
    '@/lib/jira-admin/change-requests'
  );
  return {
    ...actual,
    getChangeRequest: jest.fn(),
    claimChangeRequest: jest.fn(),
    finishChangeRequest: jest.fn(),
  };
});

import { NextRequest } from 'next/server';
import { POST } from './route';
import { getSessionFromRequest } from '@/lib/session';
import { recordAuditEvent } from '@/lib/audit-events';
import { resolveJiraAdminAccess } from '@/lib/mcp-tools/jira-admin/client';
import { applyChangeRequest, applyGate } from '@/lib/jira-admin/apply';
import {
  claimChangeRequest,
  finishChangeRequest,
  getChangeRequest,
  type ChangeRequest,
} from '@/lib/jira-admin/change-requests';

const TENANT = '00000000-0000-4000-8000-000000000001';
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
    ...overrides,
  };
}

function apply(body?: unknown) {
  const request = new NextRequest(
    `http://localhost/api/tenant/${TENANT}/jira-admin/changes/${CHANGE}/apply`,
    {
      method: 'POST',
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    }
  );
  return POST(request, { params: Promise.resolve({ tenantId: TENANT, changeId: CHANGE }) });
}

const ACCESS = {
  cloudId: 'cloud-1',
  siteUrl: 'https://acme.atlassian.net',
  accountId: 'acct-1',
  authHeader: 'Bearer t',
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getSessionFromRequest).mockResolvedValue({
    id: 'session-1',
    tenantId: TENANT,
    subject: 'owner',
    roles: [],
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  jest.mocked(getChangeRequest).mockResolvedValue(change());
  jest.mocked(applyGate).mockResolvedValue({ ok: true });
  jest.mocked(resolveJiraAdminAccess).mockResolvedValue(ACCESS);
  jest.mocked(claimChangeRequest).mockResolvedValue(true);
  jest.mocked(applyChangeRequest).mockResolvedValue({
    status: 'applied',
    results: [{ label: 'Add option “Vendor”', outcome: 'done' }],
  });
});

it('refuses without a signed-in session', async () => {
  jest.mocked(getSessionFromRequest).mockResolvedValue(null);
  const response = await apply();
  expect(response.status).toBe(401);
  expect(applyChangeRequest).not.toHaveBeenCalled();
});

it('reads someone else’s request as not found, looking it up under the caller only', async () => {
  jest.mocked(getChangeRequest).mockResolvedValue(null);
  const response = await apply();
  expect(response.status).toBe(404);
  expect(jest.mocked(getChangeRequest).mock.calls[0]?.slice(1)).toEqual([TENANT, 'owner', CHANGE]);
});

it('refuses a request that is no longer pending, or has expired', async () => {
  jest.mocked(getChangeRequest).mockResolvedValue(change({ status: 'applied' }));
  let response = await apply();
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: 'This change request has already been applied.',
  });

  jest
    .mocked(getChangeRequest)
    .mockResolvedValue(change({ expiresAt: new Date(Date.now() - 1000) }));
  response = await apply();
  expect(response.status).toBe(409);
  expect((await response.json()).error).toMatch(/expired/);
  expect(claimChangeRequest).not.toHaveBeenCalled();
});

it('says why when the org no longer allows it, and touches nothing', async () => {
  jest.mocked(applyGate).mockResolvedValue({
    ok: false,
    reason: 'Your organization is in read-only mode, so admin changes cannot be applied.',
  });
  const response = await apply();
  expect(response.status).toBe(403);
  expect((await response.json()).error).toMatch(/read-only mode/);
  expect(claimChangeRequest).not.toHaveBeenCalled();
  expect(applyChangeRequest).not.toHaveBeenCalled();
});

it('will not run a proposal on a different Jira site than it was made for', async () => {
  jest.mocked(resolveJiraAdminAccess).mockResolvedValue({ ...ACCESS, cloudId: 'cloud-2' });
  const response = await apply();
  expect(response.status).toBe(409);
  expect((await response.json()).error).toMatch(/different Jira site/);
  expect(claimChangeRequest).not.toHaveBeenCalled();
});

it('lets a second click lose the claim instead of applying twice', async () => {
  jest.mocked(claimChangeRequest).mockResolvedValue(false);
  const response = await apply();
  expect(response.status).toBe(409);
  expect(applyChangeRequest).not.toHaveBeenCalled();
  expect(finishChangeRequest).not.toHaveBeenCalled();
});

it('applies the stored operations — never the browser’s — and records how it went', async () => {
  const response = await apply({ operations: [{ op: 'add', values: ['Injected'] }] });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    status: 'applied',
    results: [{ label: 'Add option “Vendor”', outcome: 'done' }],
  });
  expect(jest.mocked(applyChangeRequest).mock.calls[0]?.[2]).toMatchObject({ payload: PAYLOAD });
  expect(finishChangeRequest).toHaveBeenCalledWith(expect.anything(), CHANGE, {
    status: 'applied',
    results: [{ label: 'Add option “Vendor”', outcome: 'done' }],
    appliedBy: 'owner',
  });
  expect(recordAuditEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      tenantId: TENANT,
      actorSubject: 'owner',
      action: 'jira_admin.change_applied',
      targetLabel: 'Source (Ops context): add option “Vendor”',
      details: expect.objectContaining({ changeId: CHANGE, status: 'applied', done: 1 }),
    })
  );
});

it('records a failure it did not expect as a failed apply, still audited', async () => {
  jest.mocked(applyChangeRequest).mockRejectedValue(new Error('socket hang up'));
  const response = await apply();
  expect(response.status).toBe(200);
  expect((await response.json()).status).toBe('failed');
  expect(jest.mocked(finishChangeRequest).mock.calls[0]?.[2].status).toBe('failed');
  expect(recordAuditEvent).toHaveBeenCalledTimes(1);
});
