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

jest.mock('@/lib/admin-changes/legacy-database', () => ({
  legacyDatabase: () => ({}),
  NO_DATABASE_REASON: 'no database',
}));
import { authedFetch } from '@renkei/delegate-client';
import { EMPTY_POLICY } from '@renkei/connector-salesforce';
import type { SalesforceAccess } from '@/lib/mcp-tools/salesforce/client';
import { applyChangeRequest, refreshApplying } from './apply';
import type { ChangeRequest } from './change-requests';
import { applyScopesFor, type MetadataPayload } from './plan';

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
let quickRefusal: { status: number; errorCode: string; message: string };
let deployDone: boolean;
let deploySucceeds: boolean;
let grantFails: boolean;
let existingAccess: boolean;
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
  if (method === 'GET' && /FROM FieldPermissions/.test(q)) {
    return answer(200, {
      totalSize: existingAccess ? 1 : 0,
      done: true,
      records: existingAccess ? [{ Id: '01k00000000000EAAA' }] : [],
    });
  }
  if (method === 'GET' && /FROM RecordType WHERE SobjectType/.test(q)) {
    return answer(200, {
      totalSize: 1,
      done: true,
      records: [{ Id: '012000000000001AAA', Name: 'Home Visit', DeveloperName: 'Home_Visit' }],
    });
  }
  if (method === 'GET' && /FROM RecordType WHERE Id/.test(q)) {
    return answer(200, {
      totalSize: 1,
      done: true,
      records: [
        {
          Id: '012000000000001AAA',
          DeveloperName: 'Home_Visit',
          Metadata: { label: 'Home Visit (edited)', active: true },
        },
      ],
    });
  }
  if (method === 'GET' && /FROM PermissionSetTabSetting/.test(q)) {
    return answer(200, {
      totalSize: /'Shown__c'/.test(q) ? 1 : 0,
      done: true,
      records: /'Shown__c'/.test(q) ? [{ Id: '0PT000000000001AAA' }] : [],
    });
  }
  if (method === 'POST' && url.pathname === `${V}/sobjects/PermissionSetTabSetting`) {
    return answer(201, { id: '0PT000000000002AAA', success: true });
  }
  if (method === 'GET' && /FROM PermissionSetAssignment/.test(q)) {
    return answer(200, { totalSize: 0, done: true, records: [] });
  }
  if (method === 'PATCH' && url.pathname === `${V}/sobjects/FieldPermissions/01k00000000000EAAA`) {
    return new Response(null, { status: 204 });
  }
  if (method === 'POST' && url.pathname === `${V}/sobjects/PermissionSetAssignment`) {
    return answer(201, { id: '0Pa000000000001AAA', success: true });
  }
  if (method === 'POST' && url.pathname === `${V}/metadata/deployRequest/${VALIDATED}`) {
    return quickQualifies
      ? answer(201, result(QUICK))
      : answer(quickRefusal.status, [
          { errorCode: quickRefusal.errorCode, message: quickRefusal.message },
        ]);
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
  dataSteps: [
    {
      kind: 'field-permission',
      permissionSetId: '0PS000000000001AAA',
      permissionSetName: 'Program_Staff',
      object: 'Site_Visit__c',
      field: 'Outcome__c',
      read: true,
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
  approvedBy: null,
  approvedAt: null,
  step: null,
  resolution: null,
});

const context = { subject: 'ada' };
const finished = () => store.finishChangeRequest.mock.calls.at(-1)?.[1];

beforeEach(() => {
  jest.clearAllMocks();
  requests = [];
  fieldExistsNow = false;
  quickQualifies = true;
  quickRefusal = { status: 404, errorCode: 'NOT_FOUND', message: 'no' };
  deployDone = true;
  deploySucceeds = true;
  grantFails = false;
  existingAccess = false;
});

describe('applyChangeRequest', () => {
  it('stops before deploying when the org moved since the proposal', async () => {
    fieldExistsNow = true;
    const outcome = await applyChangeRequest(context, access, change(), 'ada');
    expect(outcome.status).toBe('failed');
    expect(finished()?.results.operations[0].detail).toContain(
      'Site_Visit__c.Outcome__c exists now'
    );
    expect(requests.some((r) => r.path.includes('/metadata/'))).toBe(false);
  });

  it('stops when a record type was edited since it was read, or one was created under the name', async () => {
    const recordTypes = {
      ...change(),
      kind: 'record_type',
      payload: {
        ...payload,
        preconditions: [
          {
            kind: 'component-unchanged',
            type: 'RecordType',
            object: 'Site_Visit__c',
            name: 'Home_Visit',
            fingerprint: 'what-it-was',
          },
          { kind: 'record-type-absent', object: 'Site_Visit__c', name: 'home_visit' },
        ],
      },
    };
    const outcome = await applyChangeRequest(context, access, recordTypes, 'ada');
    expect(outcome.status).toBe('failed');
    const detail = finished()?.results.operations[0].detail ?? '';
    expect(detail).toContain(
      'The record type Site_Visit__c.Home_Visit was changed since this was proposed'
    );
    expect(detail).toContain('Site_Visit__c.home_visit exists now');
    expect(requests.some((r) => r.path.includes('/metadata/'))).toBe(false);
  });

  it('quick-deploys the validation, records the deploy, then grants the fields', async () => {
    const outcome = await applyChangeRequest(context, access, change(), 'ada');
    expect(outcome.status).toBe('applied');
    expect(store.recordDeployStarted).toHaveBeenCalledWith(
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
    const outcome = await applyChangeRequest(context, access, change(), 'ada');
    expect(outcome.status).toBe('applied');
    expect(outcome.results.deployId).toBe(FULL);
    const full = requests.find(
      (r) => r.method === 'POST' && r.path === `${V}/metadata/deployRequest`
    );
    const text = Buffer.from(full?.body as Uint8Array).toString('latin1');
    // The json part carries no filename — Salesforce refuses one as an invalid multipart request.
    expect(text).toContain(
      'Content-Disposition: form-data; name="json"\r\nContent-Type: application/json\r\n\r\n'
    );
    expect(text).toContain('name="file"; filename="deploy.zip"');
  });

  it('deploys in full when the validation ran no tests, which Salesforce refuses with INVALID_ID_FIELD', async () => {
    quickQualifies = false;
    quickRefusal = {
      status: 400,
      errorCode: 'INVALID_ID_FIELD',
      message: 'Source validate did not run tests in the org',
    };
    const outcome = await applyChangeRequest(context, access, change(), 'ada');
    expect(outcome.status).toBe('applied');
    expect(outcome.results.deployId).toBe(FULL);
    expect(outcome.results.quick).toBe(false);
  });

  it('does not deploy in full after a quick deploy is refused for any other reason', async () => {
    quickQualifies = false;
    quickRefusal = { status: 400, errorCode: 'INVALID_FIELD', message: 'something else' };
    const outcome = await applyChangeRequest(context, access, change(), 'ada');
    expect(outcome.status).toBe('failed');
    expect(
      requests.some((r) => r.method === 'POST' && r.path === `${V}/metadata/deployRequest`)
    ).toBe(false);
  });

  it('fails in Salesforce’s words, and grants nothing, when the deploy fails', async () => {
    deploySucceeds = false;
    const outcome = await applyChangeRequest(context, access, change(), 'ada');
    expect(outcome.status).toBe('failed');
    expect(finished()?.results.operations.at(-1).detail).toContain('Duplicate developer name');
    expect(requests.some((r) => r.path.endsWith('/sobjects/FieldPermissions'))).toBe(false);
  });

  it('is partial when the deploy succeeds and a grant does not', async () => {
    grantFails = true;
    const outcome = await applyChangeRequest(context, access, change(), 'ada');
    expect(outcome.status).toBe('partial');
  });

  it('updates the access a permission set already has instead of adding a second row', async () => {
    existingAccess = true;
    const outcome = await applyChangeRequest(context, access, change(), 'ada');
    expect(outcome.status).toBe('applied');
    expect(
      requests.some((r) => r.method === 'POST' && r.path.endsWith('/sobjects/FieldPermissions'))
    ).toBe(false);
    const patch = requests.find((r) => r.method === 'PATCH');
    expect(JSON.parse(String(patch?.body))).toEqual({
      PermissionsRead: true,
      PermissionsEdit: true,
    });
  });

  it('runs a data-only change without deploying anything', async () => {
    const dataOnly = {
      ...change(),
      kind: 'assignments',
      validation: {
        deployId: '',
        done: true,
        success: true,
        status: 'Checked',
        failures: [],
        checkedAt: '',
      },
      payload: {
        files: {},
        members: [],
        components: [],
        preconditions: [],
        dataSteps: [
          {
            kind: 'assign',
            permissionSetId: '0PS000000000001AAA',
            permissionSetName: 'Program_Staff',
            userId: '005000000000002AAA',
            userName: 'Grace Hopper',
          },
        ],
      },
    };
    const outcome = await applyChangeRequest(context, access, dataOnly, 'ada');
    expect(outcome.status).toBe('applied');
    expect(requests.some((r) => r.path.includes('/metadata/'))).toBe(false);
    const assigned = requests.find((r) => r.path.endsWith('/sobjects/PermissionSetAssignment'));
    expect(JSON.parse(String(assigned?.body))).toEqual({
      AssigneeId: '005000000000002AAA',
      PermissionSetId: '0PS000000000001AAA',
    });
  });

  it('creates a tab setting once, and leaves one that exists', async () => {
    const base = { permissionSetId: '0PS000000000001AAA', permissionSetName: 'Program_Staff' };
    const tabs = {
      ...change(),
      kind: 'permission_set',
      validation: {
        deployId: '',
        done: true,
        success: true,
        status: 'Checked',
        failures: [],
        checkedAt: '',
      },
      payload: {
        files: {},
        members: [],
        components: [],
        preconditions: [],
        dataSteps: [
          { kind: 'tab-visibility', ...base, tab: 'Site_Visit__c', visibility: 'DefaultOn' },
          { kind: 'tab-visibility', ...base, tab: 'Shown__c', visibility: 'DefaultOn' },
        ],
      },
    };
    const outcome = await applyChangeRequest(context, access, tabs, 'ada');
    expect(outcome.status).toBe('applied');
    const created = requests.filter((r) => r.path.endsWith('/sobjects/PermissionSetTabSetting'));
    expect(created.map((r) => JSON.parse(String(r.body)))).toEqual([
      { ParentId: '0PS000000000001AAA', Name: 'Site_Visit__c', Visibility: 'DefaultOn' },
    ]);
  });

  it('leaves a deploy still running as applying, and a later look finishes it', async () => {
    deployDone = false;
    const outcome = await applyChangeRequest(context, access, change(), 'ada', 0);
    expect(outcome.status).toBe('applying');
    expect(store.finishChangeRequest).not.toHaveBeenCalled();

    deployDone = true;
    const later = { ...change(), results: { deployId: QUICK, quick: true, operations: [] } };
    expect(await refreshApplying(context, access, later)).toBe(true);
    expect(finished()).toMatchObject({ status: 'applied' });
  });
});

describe('applyScopesFor', () => {
  const payload = (over: Partial<MetadataPayload>): MetadataPayload => ({
    files: {},
    members: [],
    components: [],
    preconditions: [],
    dataSteps: [],
    ...over,
  });

  it('needs what the change carries, not only its kind', () => {
    expect(applyScopesFor('fields', payload({}))).toEqual(['sfa-schema']);
    expect(
      applyScopesFor(
        'fields',
        payload({ members: [{ type: 'Layout', member: 'Site_Visit__c-Site Visit Layout' }] })
      )
    ).toEqual(['sfa-schema', 'sfa-layouts']);
    expect(applyScopesFor('layout')).toEqual(['sfa-layouts']);
    // Record type access in a profile is access.
    expect(
      applyScopesFor('record_type', payload({ members: [{ type: 'Profile', member: 'Standard' }] }))
    ).toEqual(['sfa-schema', 'sfa-permissions']);
    expect(
      applyScopesFor(
        'permission_set',
        payload({
          dataSteps: [
            {
              kind: 'unassign',
              permissionSetId: '0PS',
              permissionSetName: 'X',
              userId: '005',
              userName: 'Y',
            },
          ],
        })
      )
    ).toEqual(['sfa-permissions', 'sfa-user-access']);
  });
});
