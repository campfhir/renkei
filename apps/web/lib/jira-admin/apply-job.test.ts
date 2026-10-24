/**
 * The job behind an approved Jira admin change. What it must guarantee:
 * it runs the stored operations on the approving operator's connection,
 * not the requester's; it records how it ended and tells both of them,
 * whatever the outcome; it stops at a gate that has closed since the
 * approval; and a job that lost its process is ended, never run again.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));
jest.mock('@/lib/admin-changes/notify', () => ({
  notifyChangeOutcome: jest.fn(),
  notifyOperatorsOfRequest: jest.fn(),
}));
jest.mock('@/lib/shutdown', () => ({ isShuttingDown: () => false, onShutdown: () => () => {} }));
jest.mock('@/lib/mcp-tools/jira-admin/client', () => ({ resolveJiraAdminAccess: jest.fn() }));
jest.mock('@/lib/mcp-tools/jira-admin/jsm-access', () => ({ resolveJsmAccess: jest.fn() }));
jest.mock('@/lib/mcp-tools/jira-admin/automation-client', () => ({
  resolveAutomationAccess: jest.fn(),
}));
jest.mock('./apply', () => ({ applyGate: jest.fn(), applyChangeRequest: jest.fn() }));
jest.mock('./change-requests', () => ({
  getChangeRequestById: jest.fn(),
  startQueuedChange: jest.fn(),
  reclaimStaleChange: jest.fn(),
  setStep: jest.fn(),
  finishChangeRequest: jest.fn(),
  listRunnableChanges: jest.fn(),
}));

import { authedFetch } from '@renkei/delegate-client';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { recordAuditEvent } from '@/lib/audit-events';
import { notifyChangeOutcome } from '@/lib/admin-changes/notify';
import { resolveJiraAdminAccess } from '@/lib/mcp-tools/jira-admin/client';
import { applyChangeRequest, applyGate } from './apply';
import {
  finishChangeRequest,
  getChangeRequestById,
  listRunnableChanges,
  reclaimStaleChange,
  startQueuedChange,
  type ChangeRequest,
} from './change-requests';
import { recoverApplyJobs, resolveApplyAccess, runApplyJob } from './apply-job';

// The stores are mocked; nothing here touches the database.
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const db = {} as Kysely<DB>;
const CHANGE = '6f1d3c1e-8c1a-4f5e-9a55-2b7a0c9e4d11';

function change(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  const now = new Date();
  return {
    id: CHANGE,
    subject: 'requester',
    agentId: null,
    cloudId: 'cloud-1',
    siteUrl: 'https://acme.atlassian.net',
    kind: 'field_options',
    title: 'Source: add “Vendor”',
    reason: null,
    payload: {},
    status: 'queued',
    results: null,
    expiresAt: new Date(now.getTime() + 3_600_000),
    createdAt: now,
    updatedAt: now,
    appliedBy: null,
    appliedAt: null,
    cancelledAt: null,
    approvedBy: 'operator',
    approvedAt: now,
    step: null,
    resolution: null,
    ...overrides,
  };
}

const ACCESS = {
  cloudId: 'cloud-1',
  siteUrl: 'https://acme.atlassian.net',
  accountId: 'acct-1',
  // The delegate's fetcher stands in for the grant; nothing here calls it.
  auth: authedFetch((url, init) => fetch(url, init), 'atlassian-admin:acct-1'),
};

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(getChangeRequestById).mockResolvedValue(change());
  jest.mocked(startQueuedChange).mockResolvedValue(true);
  jest.mocked(reclaimStaleChange).mockResolvedValue(true);
  jest.mocked(applyGate).mockResolvedValue({ ok: true });
  jest.mocked(resolveJiraAdminAccess).mockResolvedValue(ACCESS);
  jest.mocked(applyChangeRequest).mockResolvedValue({
    status: 'applied',
    results: [{ label: 'Add option “Vendor”', outcome: 'done' }],
  });
});

it('applies the stored change on the approving operator’s connection, and tells both people', async () => {
  await runApplyJob(db, CHANGE);

  expect(jest.mocked(resolveJiraAdminAccess).mock.calls[0]?.[0]).toEqual({ subject: 'operator' });
  expect(jest.mocked(applyGate).mock.calls[0]?.[1]).toBe('operator');
  expect(jest.mocked(applyChangeRequest).mock.calls[0]?.[0]).toEqual({ subject: 'operator' });
  expect(finishChangeRequest).toHaveBeenCalledWith(db, CHANGE, {
    status: 'applied',
    results: [{ label: 'Add option “Vendor”', outcome: 'done' }],
    appliedBy: 'operator',
  });
  expect(notifyChangeOutcome).toHaveBeenCalledWith(
    expect.objectContaining({
      connector: 'jira-admin',
      requester: 'requester',
      approver: 'operator',
      outcome: 'applied',
    })
  );
  expect(recordAuditEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      actorSubject: 'operator',
      action: 'jira_admin.change_applied',
      details: expect.objectContaining({ requestedBy: 'requester', status: 'applied', done: 1 }),
    })
  );
});

it('does nothing when it loses the claim, so a change is never applied twice', async () => {
  jest.mocked(startQueuedChange).mockResolvedValue(false);
  await runApplyJob(db, CHANGE);
  expect(applyChangeRequest).not.toHaveBeenCalled();
  expect(finishChangeRequest).not.toHaveBeenCalled();
  expect(notifyChangeOutcome).not.toHaveBeenCalled();
});

it('ends a change as failed when the org has closed the gate since approval, saying why', async () => {
  jest
    .mocked(applyGate)
    .mockResolvedValue({ ok: false, reason: 'Your organization is in read-only mode.' });
  await runApplyJob(db, CHANGE);
  expect(applyChangeRequest).not.toHaveBeenCalled();
  expect(jest.mocked(finishChangeRequest).mock.calls[0]?.[2]).toMatchObject({
    status: 'failed',
    results: [{ outcome: 'failed', detail: 'Your organization is in read-only mode.' }],
  });
  expect(notifyChangeOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }));
});

it('ends a change as failed, and tells people, when the operator’s connection is on another site', async () => {
  jest.mocked(resolveJiraAdminAccess).mockResolvedValue({ ...ACCESS, cloudId: 'cloud-2' });
  await runApplyJob(db, CHANGE);
  expect(applyChangeRequest).not.toHaveBeenCalled();
  expect(
    jest.mocked(finishChangeRequest).mock.calls[0]?.[2].results[0]?.detail
  ).toMatch(/different Jira site/);
  expect(notifyChangeOutcome).toHaveBeenCalledTimes(1);
});

it('records a failure it did not expect as a failed apply, still audited and announced', async () => {
  jest.mocked(applyChangeRequest).mockRejectedValue(new Error('socket hang up'));
  await runApplyJob(db, CHANGE);
  expect(jest.mocked(finishChangeRequest).mock.calls[0]?.[2].status).toBe('failed');
  expect(recordAuditEvent).toHaveBeenCalledTimes(1);
  expect(notifyChangeOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }));
});

it('ends a job that lost its process as failed instead of running it again', async () => {
  jest.mocked(getChangeRequestById).mockResolvedValue(change({ status: 'applying' }));
  await runApplyJob(db, CHANGE);
  expect(applyChangeRequest).not.toHaveBeenCalled();
  expect(jest.mocked(finishChangeRequest).mock.calls[0]?.[2]).toMatchObject({
    status: 'failed',
    results: [{ detail: expect.stringMatching(/check Jira/) }],
  });
});

it('leaves an applying change alone while its job is still reporting', async () => {
  jest.mocked(getChangeRequestById).mockResolvedValue(change({ status: 'applying' }));
  jest.mocked(reclaimStaleChange).mockResolvedValue(false);
  await runApplyJob(db, CHANGE);
  expect(finishChangeRequest).not.toHaveBeenCalled();
  expect(notifyChangeOutcome).not.toHaveBeenCalled();
});

it('ignores a change that is not queued', async () => {
  jest.mocked(getChangeRequestById).mockResolvedValue(change({ status: 'pending' }));
  await runApplyJob(db, CHANGE);
  expect(startQueuedChange).not.toHaveBeenCalled();
  jest.mocked(getChangeRequestById).mockResolvedValue(null);
  await runApplyJob(db, CHANGE);
  expect(startQueuedChange).not.toHaveBeenCalled();
});

it('the sweep takes up whatever the queue offers', async () => {
  jest.mocked(listRunnableChanges).mockResolvedValue([{ id: CHANGE, status: 'queued' }]);
  await recoverApplyJobs(db);
  expect(applyChangeRequest).toHaveBeenCalledTimes(1);
});

describe('resolveApplyAccess', () => {
  it('passes on the connection’s own refusal', async () => {
    jest.mocked(resolveJiraAdminAccess).mockResolvedValue('Jira Administration is not connected.');
    expect(await resolveApplyAccess('operator', change())).toBe(
      'Jira Administration is not connected.'
    );
  });
});
