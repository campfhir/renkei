/**
 * Approving and withdrawing a Salesforce admin change request, run for
 * real on the memory store with requests filed the way the tools file
 * them (lib/salesforce-admin/change-requests.ts): only an operator may
 * approve (403), a request in words has nothing to approve (409), nor
 * does one already decided; the person who asked may withdraw their own,
 * an operator may decline anyone's with a note, and a stranger does not
 * find it. These were salesforce-admin.spec.ts's direct posts and its
 * withdrawal. The apply gate and the job are what the refusals stand in
 * front of: both are replaced, so a request that got past would show.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@/lib/salesforce-admin/apply', () => ({
  applyGate: jest.fn(),
  accessForChange: jest.fn(),
}));
jest.mock('@/lib/salesforce-admin/apply-job', () => ({ runApplyJob: jest.fn() }));
jest.mock('@/lib/admin-changes/notify', () => ({ notifyChangeOutcome: jest.fn() }));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import {
  createChangeRequest,
  createRequest,
  getChangeRequestById,
  stateOf,
} from '@/lib/salesforce-admin/change-requests';
import { POST as cancelPOST } from '../cancel/route';
import { POST } from './route';

const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');
const apply = jest.requireMock<{ applyGate: jest.Mock; accessForChange: jest.Mock }>(
  '@/lib/salesforce-admin/apply'
);
const { notifyChangeOutcome } = jest.requireMock<{ notifyChangeOutcome: jest.Mock }>(
  '@/lib/admin-changes/notify'
);

const ASKER = 'arlo@example.com';
const OPERATOR = 'ops@example.com';
const STRANGER = 'sam@example.com';
const where = {
  connectorKey: 'uat',
  orgId: '00D000000000062EAA',
  instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
};

const as = (subject: string, operator = false) =>
  mockGetSession.mockResolvedValue({
    subject,
    roles: operator ? ['renkei-user', 'renkei-operator'] : ['renkei-user'],
  });
const params = (changeId: string) => ({ params: Promise.resolve({ changeId }) });
const post = (body: unknown = {}) =>
  new NextRequest('http://test.local/api/salesforce-admin/changes/x', {
    method: 'POST',
    body: JSON.stringify(body),
  });
const approve = (id: string) => POST(post(), params(id));
const cancel = (id: string, body: unknown = {}) => cancelPOST(post(body), params(id));

const askInWords = () =>
  createRequest({
    subject: ASKER,
    ...where,
    title: 'Add an Outcome picklist to Site Visit',
    reason: 'The program tracks outcomes now',
    description: 'Site_Visit__c needs Outcome__c: Completed, No show.',
  });
const propose = () =>
  createChangeRequest({
    subject: ASKER,
    ...where,
    kind: 'fields',
    title: 'Site Visit: add Outcome',
    payload: { files: { 'package.xml': '<Package/>' } },
  });

beforeEach(() => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
});

afterEach(() => resetDataStore());

describe('approving', () => {
  it('is an operator’s alone, whatever the page shows', async () => {
    const change = await propose();
    as(ASKER);
    const response = await approve(change.id);
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe(
      'Only an operator can approve a change to Salesforce.'
    );
    expect(apply.applyGate).not.toHaveBeenCalled();
    expect(stateOf((await getChangeRequestById(change.id))!)).toBe('pending');
  });

  it('a request in words has nothing to approve: build it as a proposal, or decline it', async () => {
    const request = await askInWords();
    as(OPERATOR, true);
    const response = await approve(request.id);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/request in words, not a proposal/);
    expect(apply.applyGate).not.toHaveBeenCalled();
  });

  it('a request no longer pending says what became of it', async () => {
    const change = await propose();
    as(ASKER);
    expect((await cancel(change.id)).status).toBe(200);
    as(OPERATOR, true);
    const response = await approve(change.id);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('This change request was cancelled.');
  });

  it('a request that does not exist is not found', async () => {
    as(OPERATOR, true);
    expect((await approve('00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });
});

describe('withdrawing and declining', () => {
  it('the person who asked withdraws their own, and nobody is notified', async () => {
    const request = await askInWords();
    as(ASKER);
    const response = await cancel(request.id, { note: '' });
    expect(response.status).toBe(200);
    expect(stateOf((await getChangeRequestById(request.id))!)).toBe('cancelled');
    expect(notifyChangeOutcome).not.toHaveBeenCalled();
  });

  it('someone else does not find it', async () => {
    const request = await askInWords();
    as(STRANGER);
    expect((await cancel(request.id)).status).toBe(404);
    expect(stateOf((await getChangeRequestById(request.id))!)).toBe('pending');
  });

  it('an operator declines with a note the requester is told', async () => {
    const request = await askInWords();
    as(OPERATOR, true);
    const response = await cancel(request.id, { note: '  Not this sprint  ' });
    expect(response.status).toBe(200);
    expect(notifyChangeOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        changeId: request.id,
        requester: ASKER,
        outcome: 'declined',
        note: 'Not this sprint',
      })
    );
  });

  it('only a request waiting for review can be cancelled', async () => {
    const request = await askInWords();
    as(ASKER);
    await cancel(request.id);
    const again = await cancel(request.id);
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe(
      'Only a change request waiting for review can be cancelled.'
    );
  });
});
