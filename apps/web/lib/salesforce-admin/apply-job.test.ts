/**
 * The job behind an approved Salesforce admin change. What it must
 * guarantee: it deploys the stored package on the approving operator's own
 * connection, not the requester's; it records how it ended and tells both
 * people whatever the outcome; it stops at a gate that closed since the
 * approval; a deploy that outlives the job is followed to its end rather
 * than started again; and one that never got a deploy id is not guessed at.
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
jest.mock('./apply', () => ({
  applyGate: jest.fn(),
  accessForChange: jest.fn(),
  applyChangeRequest: jest.fn(),
  refreshApplying: jest.fn(),
}));
jest.mock('./change-requests', () => ({
  getChangeRequestById: jest.fn(),
  startQueuedChange: jest.fn(),
  reclaimStaleChange: jest.fn(),
  setStep: jest.fn(),
  finishChangeRequest: jest.fn(),
  listRunnableChanges: jest.fn(),
}));

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { recordAuditEvent } from '@/lib/audit-events';
import { notifyChangeOutcome } from '@/lib/admin-changes/notify';
import type { SalesforceAccess } from '@/lib/mcp-tools/salesforce/client';
import { accessForChange, applyChangeRequest, applyGate, refreshApplying } from './apply';
import {
  finishChangeRequest,
  getChangeRequestById,
  listRunnableChanges,
  reclaimStaleChange,
  startQueuedChange,
  type ChangeRequest,
} from './change-requests';
import { recoverApplyJobs, runApplyJob } from './apply-job';

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
    connectorKey: 'uat',
    orgId: '00D000000000062EAA',
    instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
    kind: 'fields',
    title: 'Site Visit: add Outcome',
    reason: null,
    payload: {},
    validation: null,
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

// The job only passes the access through; none of its fields are read here.
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const ACCESS = { connector: 'uat', orgId: '00D000000000062EAA' } as SalesforceAccess;

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(getChangeRequestById).mockResolvedValue(change());
  jest.mocked(startQueuedChange).mockResolvedValue(true);
  jest.mocked(reclaimStaleChange).mockResolvedValue(true);
  jest.mocked(applyGate).mockResolvedValue({ ok: true });
  jest.mocked(accessForChange).mockResolvedValue(ACCESS);
  jest.mocked(applyChangeRequest).mockResolvedValue({
    status: 'applied',
    results: { deployId: '0Af000000000009', operations: [{ label: 'Deploy', outcome: 'done' }] },
  });
});

it('deploys on the approving operator’s connection and tells the requester and the operator', async () => {
  await runApplyJob(db, CHANGE);

  expect(jest.mocked(applyGate).mock.calls[0]?.[1]).toBe('operator');
  expect(jest.mocked(accessForChange).mock.calls[0]?.[0]).toMatchObject({ subject: 'operator' });
  const call = jest.mocked(applyChangeRequest).mock.calls[0];
  expect(call?.[1]).toMatchObject({ subject: 'operator' });
  expect(call?.[4]).toBe('operator');
  expect(notifyChangeOutcome).toHaveBeenCalledWith(
    expect.objectContaining({
      connector: 'salesforce-admin',
      requester: 'requester',
      approver: 'operator',
      outcome: 'applied',
    })
  );
  expect(recordAuditEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      actorSubject: 'operator',
      action: 'salesforce_admin.change_applied',
      details: expect.objectContaining({
        requestedBy: 'requester',
        status: 'applied',
        deployId: '0Af000000000009',
      }),
    })
  );
});

it('reports what it is doing through the step callback, which is also its heartbeat', async () => {
  jest.mocked(applyChangeRequest).mockImplementation(async (...args) => {
    const onStep = args[6];
    await onStep?.('Salesforce is deploying — 1 of 4 components (InProgress)');
    return { status: 'applied', results: { operations: [] } };
  });
  const { setStep } = jest.requireMock<typeof import('./change-requests')>('./change-requests');
  await runApplyJob(db, CHANGE);
  expect(setStep).toHaveBeenCalledWith(
    db,
    CHANGE,
    'Salesforce is deploying — 1 of 4 components (InProgress)'
  );
});

it('does nothing when it loses the claim, so a change is never deployed twice', async () => {
  jest.mocked(startQueuedChange).mockResolvedValue(false);
  await runApplyJob(db, CHANGE);
  expect(applyChangeRequest).not.toHaveBeenCalled();
  expect(notifyChangeOutcome).not.toHaveBeenCalled();
});

it('ends a change as failed when the org closed the gate since approval, saying why', async () => {
  jest.mocked(applyGate).mockResolvedValue({
    ok: false,
    reason: 'Your organization is in read-only mode, so changes cannot be applied.',
  });
  await runApplyJob(db, CHANGE);
  expect(applyChangeRequest).not.toHaveBeenCalled();
  expect(jest.mocked(finishChangeRequest).mock.calls[0]?.[2]).toMatchObject({
    status: 'failed',
    appliedBy: 'operator',
    results: { operations: [{ outcome: 'failed', detail: expect.stringMatching(/read-only/) }] },
  });
  expect(notifyChangeOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }));
});

it('ends a change as failed, and tells people, when the operator has no usable connection', async () => {
  jest.mocked(accessForChange).mockResolvedValue('Salesforce Admin UAT is not connected.');
  await runApplyJob(db, CHANGE);
  expect(applyChangeRequest).not.toHaveBeenCalled();
  expect(jest.mocked(finishChangeRequest).mock.calls[0]?.[2].results.operations[0]?.detail).toBe(
    'Salesforce Admin UAT is not connected.'
  );
  expect(notifyChangeOutcome).toHaveBeenCalledTimes(1);
});

it('stays quiet while a deploy is still running at the end of the wait, for the sweep to follow', async () => {
  jest.mocked(applyChangeRequest).mockResolvedValue({
    status: 'applying',
    results: { deployId: '0Af000000000009', operations: [] },
  });
  await runApplyJob(db, CHANGE);
  expect(notifyChangeOutcome).not.toHaveBeenCalled();
  expect(recordAuditEvent).not.toHaveBeenCalled();
});

it('follows a deploy that outlived its job to its end instead of starting another', async () => {
  const applying = change({
    status: 'applying',
    results: { deployId: '0Af000000000009', operations: [] },
  });
  jest.mocked(getChangeRequestById).mockResolvedValueOnce(applying).mockResolvedValueOnce(applying);
  // After the refresh the row is finished.
  jest
    .mocked(getChangeRequestById)
    .mockResolvedValueOnce(
      change({ status: 'applied', results: { deployId: '0Af000000000009', operations: [] } })
    );
  jest.mocked(refreshApplying).mockResolvedValue(true);
  await runApplyJob(db, CHANGE);
  expect(applyChangeRequest).not.toHaveBeenCalled();
  expect(refreshApplying).toHaveBeenCalledTimes(1);
  expect(notifyChangeOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'applied' }));
});

it('ends a change that died before Salesforce gave it a deploy id, saying so, without guessing', async () => {
  jest.mocked(getChangeRequestById).mockResolvedValue(change({ status: 'applying' }));
  await runApplyJob(db, CHANGE);
  expect(applyChangeRequest).not.toHaveBeenCalled();
  expect(refreshApplying).not.toHaveBeenCalled();
  expect(jest.mocked(finishChangeRequest).mock.calls[0]?.[2]).toMatchObject({
    status: 'failed',
    results: { operations: [{ detail: expect.stringMatching(/Deployment Status/) }] },
  });
  expect(notifyChangeOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }));
});

it('leaves an applying change alone while its job is still reporting', async () => {
  jest.mocked(getChangeRequestById).mockResolvedValue(change({ status: 'applying' }));
  jest.mocked(reclaimStaleChange).mockResolvedValue(false);
  await runApplyJob(db, CHANGE);
  expect(finishChangeRequest).not.toHaveBeenCalled();
  expect(notifyChangeOutcome).not.toHaveBeenCalled();
});

it('ignores a change that is not in the queue', async () => {
  jest.mocked(getChangeRequestById).mockResolvedValue(change({ status: 'pending' }));
  await runApplyJob(db, CHANGE);
  expect(startQueuedChange).not.toHaveBeenCalled();
});

it('the sweep takes up whatever the queue offers', async () => {
  jest.mocked(listRunnableChanges).mockResolvedValue([{ id: CHANGE, status: 'queued' }]);
  await recoverApplyJobs(db);
  expect(applyChangeRequest).toHaveBeenCalledTimes(1);
});
