/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Applying a change request against a fake org: a precondition that moved
 * (the field exists now) stops it before anything deploys; a passed
 * validation goes out as a quick deploy, and when Salesforce says it no
 * longer qualifies the same files deploy in full; the deploy id is recorded
 * before waiting, so a deploy that outlives the request is left
 * 'applying' and finished later from its own status; a failed deploy is
 * 'failed' in Salesforce's words; and the field grants run only after a
 * successful deploy, one failure making it 'partial'.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
jest.mock('./change-requests', () => ({
  ...jest.requireActual('./change-requests'),
  finishChangeRequest: jest.fn(async () => true),
  recordDeployStarted: jest.fn(),
  setValidation: jest.fn(),
}));

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { authedFetch } from '@renkei/delegate-client';
import { EMPTY_POLICY } from '@renkei/connector-salesforce';
import type { SalesforceAccess } from '@/lib/mcp-tools/salesforce/client';
import { applyChangeRequest, refreshApplying } from './apply';
import type { ChangeRequest } from './change-requests';
import type { MetadataPayload } from './plan';

const store = jest.requireMock<{ finishChangeRequest: jest.Mock; recordDeployStarted: jest.Mock }>(
  './change-requests'
);

const UAT = 'https://acme--uat.sandbox.my.salesforce.com';
const V = '/services/data/v68.0';
const VALIDATED = '0Af00000000000VAAA';
const QUICK = '0Af00000000000QAAA';
const FULL = '0Af00000000000FAAA';

let fieldExistsNow: boolean;
let quickQualifies: boolean;
let deployDone: boolean;
let deploySucceeds: boolean;
let grantFails: boolean;
let requests: { method: string; path: string; body: unknown }[];

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const result = (id: string) => ({
  id,
  deployResult: {
    id,
    done: deployDone,
    success: deployDone && deploySucceeds,
    status: !deployDone ? 'InProgress' : deploySucceeds ? 'Succeeded' : 'Failed',
    ...(deployDone && !deploySucceeds
      ? {
          details: {
            componentFailures: [
              {
                componentType: 'CustomField',
                fullName: 'Site_Visit__c.Outcome__c',
                problem: 'Duplicate developer name',
              },
            ],
          },
        }
      : {}),
  },
});

global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  );
  const method = init?.method ?? 'GET';
  requests.push({ method, path: url.pathname, body: init?.body });
  const q = new URLSearchParams(url.search).get('q') ?? '';
  if (method === 'GET' && /FROM FieldDefinition/.test(q)) {
    return answer(200, {
      totalSize: fieldExistsNow ? 1 : 0,
      done: true,
      records: fieldExistsNow ? [{ QualifiedApiName: 'Outcome__c' }] : [],
    });
  }
  if (method === 'POST' && url.pathname === `${V}/metadata/deployRequest/${VALIDATED}`) {
    return quickQualifies
      ? answer(201, result(QUICK))
      : answer(404, [{ errorCode: 'NOT_FOUND', message: 'no' }]);
  }
  if (method === 'POST' && url.pathname === `${V}/metadata/deployRequest`)
    return answer(201, result(FULL));
  if (method === 'GET' && url.pathname.startsWith(`${V}/metadata/deployRequest/`)) {
    return answer(200, result(url.pathname.split('/').pop() ?? ''));
  }
  if (method === 'POST' && url.pathname === `${V}/sobjects/FieldPermissions`) {
    return grantFails
      ? answer(400, [{ errorCode: 'INVALID_FIELD', message: 'Field is required' }])
      : answer(201, { id: '01k000000000001AAA', success: true });
  }
  return answer(404, [
    { errorCode: 'NOT_FOUND', message: `no stub for ${method} ${url.pathname}` },
  ]);
}) as unknown as typeof fetch;

const access: SalesforceAccess = {
  auth: authedFetch((url, init) => fetch(url, init), 'salesforce-admin:00D/005'),
  accountId: '00D000000000062EAA/005000000000001AAA',
  orgId: '00D000000000062EAA',
  userId: '005000000000001AAA',
  instanceUrl: UAT,
  username: 'ada@acme.org',
  connector: 'uat',
  connectorName: 'UAT',
  sandbox: true,
  policy: EMPTY_POLICY,
};

const payload: MetadataPayload = {
  files: { 'package.xml': '<Package/>', 'objects/Site_Visit__c.object': '<CustomObject/>' },
  members: [{ type: 'CustomField', member: 'Site_Visit__c.Outcome__c' }],
  components: [],
  preconditions: [{ kind: 'field-absent', object: 'Site_Visit__c', field: 'Outcome__c' }],
  fieldGrants: [
    {
      permissionSetId: '0PS000000000001AAA',
      permissionSetName: 'Program_Staff',
      object: 'Site_Visit__c',
      field: 'Outcome__c',
      edit: true,
    },
  ],
};

const change = (): ChangeRequest => ({
  id: '11111111-2222-4333-8444-555555555555',
  subject: 'ada',
  agentId: null,
  connectorKey: 'uat',
  orgId: '00D000000000062EAA',
  instanceUrl: UAT,
  kind: 'fields',
  title: 'Site Visit: add the field Outcome',
  reason: null,
  payload,
  validation: {
    deployId: VALIDATED,
    done: true,
    success: true,
    status: 'Succeeded',
    failures: [],
    checkedAt: '',
  },
  status: 'applying',
  results: null,
  expiresAt: new Date(Date.now() + 3_600_000),
  createdAt: new Date(),
  updatedAt: new Date(),
  appliedBy: null,
  appliedAt: null,
  cancelledAt: null,
});

const db = {} as Kysely<DB>;
const context = { subject: 'ada' };
const finished = () => store.finishChangeRequest.mock.calls.at(-1)?.[2];

beforeEach(() => {
  jest.clearAllMocks();
  requests = [];
  fieldExistsNow = false;
  quickQualifies = true;
  deployDone = true;
  deploySucceeds = true;
  grantFails = false;
});

describe('applyChangeRequest', () => {
  it('stops before deploying when the org moved since the proposal', async () => {
    fieldExistsNow = true;
    const outcome = await applyChangeRequest(db, context, access, change(), 'ada');
    expect(outcome.status).toBe('failed');
    expect(finished()?.results.operations[0].detail).toContain(
      'Site_Visit__c.Outcome__c exists now'
    );
    expect(requests.some((r) => r.path.includes('/metadata/'))).toBe(false);
  });

  it('quick-deploys the validation, records the deploy, then grants the fields', async () => {
    const outcome = await applyChangeRequest(db, context, access, change(), 'ada');
    expect(outcome.status).toBe('applied');
    expect(store.recordDeployStarted).toHaveBeenCalledWith(
      db,
      change().id,
      expect.objectContaining({ deployId: QUICK, quick: true })
    );
    expect(
      requests.some((r) => r.method === 'POST' && r.path === `${V}/metadata/deployRequest`)
    ).toBe(false);
    const grant = requests.find((r) => r.path.endsWith('/sobjects/FieldPermissions'));
    expect(JSON.parse(String(grant?.body))).toEqual({
      ParentId: '0PS000000000001AAA',
      SobjectType: 'Site_Visit__c',
      Field: 'Site_Visit__c.Outcome__c',
      PermissionsRead: true,
      PermissionsEdit: true,
    });
    expect(finished()).toMatchObject({ status: 'applied', appliedBy: 'ada' });
  });

  it('deploys in full when the validation no longer qualifies for a quick deploy', async () => {
    quickQualifies = false;
    const outcome = await applyChangeRequest(db, context, access, change(), 'ada');
    expect(outcome.status).toBe('applied');
    expect(outcome.results.deployId).toBe(FULL);
    const full = requests.find(
      (r) => r.method === 'POST' && r.path === `${V}/metadata/deployRequest`
    );
    expect(full?.body).toBeInstanceOf(FormData);
  });

  it('fails in Salesforce’s words, and grants nothing, when the deploy fails', async () => {
    deploySucceeds = false;
    const outcome = await applyChangeRequest(db, context, access, change(), 'ada');
    expect(outcome.status).toBe('failed');
    expect(finished()?.results.operations.at(-1).detail).toContain('Duplicate developer name');
    expect(requests.some((r) => r.path.endsWith('/sobjects/FieldPermissions'))).toBe(false);
  });

  it('is partial when the deploy succeeds and a grant does not', async () => {
    grantFails = true;
    const outcome = await applyChangeRequest(db, context, access, change(), 'ada');
    expect(outcome.status).toBe('partial');
  });

  it('leaves a deploy still running as applying, and a later look finishes it', async () => {
    deployDone = false;
    const outcome = await applyChangeRequest(db, context, access, change(), 'ada', 0);
    expect(outcome.status).toBe('applying');
    expect(store.finishChangeRequest).not.toHaveBeenCalled();

    deployDone = true;
    const later = { ...change(), results: { deployId: QUICK, quick: true, operations: [] } };
    expect(await refreshApplying(db, context, access, later)).toBe(true);
    expect(finished()).toMatchObject({ status: 'applied' });
  });
});
