/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Apex in a code project, against a fake checkout and a fake org: pulling
 * classes into the repository in the Salesforce DX layout; running tests
 * as a validation that names them and reports whether the result would
 * deploy (every test passing, each changed class 80% covered); and
 * proposing the repository's Apex as a change request that carries its
 * tests, a diff per class, a check that the org has not moved, a trigger
 * switched off rather than deleted, and a class deleted after the rest.
 * Each call runs on the person's admin connection to the org it names.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
jest.mock('@renkei/provider-grants', () => ({
  SALESFORCE: 'salesforce',
  SALESFORCE_ADMIN: 'salesforce-admin',
  readSalesforceMetadata: (metadata: Record<string, unknown>) => metadata,
}));
jest.mock('@/lib/salesforce-app', () => ({ listSalesforceConnectors: jest.fn() }));
jest.mock('@/lib/salesforce-admin/change-requests', () => ({
  ...jest.requireActual('@/lib/salesforce-admin/change-requests'),
  createChangeRequest: jest.fn(),
  getChangeRequestById: jest.fn(),
  closeRequestAsProposed: jest.fn(),
  setValidation: jest.fn(),
  cancelChangeRequest: jest.fn(),
}));
jest.mock('@/lib/admin-changes/notify', () => ({
  notifyOperatorsOfRequest: jest.fn(),
  notifyChangeOutcome: jest.fn(),
}));
jest.mock('@/lib/mcp-tools/salesforce/client', () => ({
  ...jest.requireActual('@/lib/mcp-tools/salesforce/client'),
  resolveSalesforceAccess: jest.fn(),
}));
jest.mock('@renkei/sandbox-client', () => ({
  sbWorkspaceRead: jest.fn(),
  sbWorkspaceWrite: jest.fn(),
  sbWorkspaceGitStatus: jest.fn(),
  sbWorkspaceFind: jest.fn(),
  clientFailure: (error: { message?: string }) => ({
    status: 502,
    message: error.message ?? 'failed',
  }),
}));
jest.mock('./salesforce-apex-access', () => ({
  APEX_SCOPE: 'sfa-apex',
  salesforceApexAvailable: jest.fn(),
}));
jest.mock('@/lib/salesforce-grants', () => ({ listSalesforceConnections: jest.fn() }));

import JSZip from 'jszip';
import { authedFetch } from '@renkei/delegate-client';
import { EMPTY_POLICY, type SalesforceOrg } from '@renkei/connector-salesforce';
import type { LocalToolContext } from '@/lib/chat/local-tools';
import { orgCall } from '@/lib/mcp-tools/salesforce/org-choice';
import { resetApiUsage, type SalesforceAccess } from '@/lib/mcp-tools/salesforce/client';
import { apexFingerprint } from '@/lib/salesforce-admin/apex';
import { readMetadataPayload } from '@/lib/salesforce-admin/plan';
import {
  PROPOSE_TOOL,
  RETRIEVE_TOOL,
  TEST_TOOL,
  salesforceApexTools,
} from './salesforce-apex-tools';
import {
  apexPanelStatus,
  apexTestStatus,
  proposeApex,
  searchOrgApex,
  startApexTests,
} from './salesforce-apex';

const sandbox = jest.requireMock<{
  sbWorkspaceRead: jest.Mock;
  sbWorkspaceWrite: jest.Mock;
  sbWorkspaceGitStatus: jest.Mock;
  sbWorkspaceFind: jest.Mock;
}>('@renkei/sandbox-client');
const apexAccess = jest.requireMock<{ salesforceApexAvailable: jest.Mock }>(
  './salesforce-apex-access'
);
const grants = jest.requireMock<{ listSalesforceConnections: jest.Mock }>(
  '@/lib/salesforce-grants'
);
const client = jest.requireMock<{ resolveSalesforceAccess: jest.Mock }>(
  '@/lib/mcp-tools/salesforce/client'
);
const app = jest.requireMock<{ listSalesforceConnectors: jest.Mock }>('@/lib/salesforce-app');
const store = jest.requireMock<{ createChangeRequest: jest.Mock; setValidation: jest.Mock }>(
  '@/lib/salesforce-admin/change-requests'
);

const UAT = 'https://acme--uat.sandbox.my.salesforce.com';
const V = '/services/data/v68.0';
const DEPLOY = '0Af000000000001AAA';
const ROOT = 'force-app/main/default';

const BILLING =
  'public class BillingService {\n  public Decimal tax(Decimal x) { return x * 0.1; }\n}';
const BILLING_EDITED =
  'public class BillingService {\n  public Decimal tax(Decimal x) { return x * 0.2; }\n}';
const BILLING_TEST =
  '@isTest\nprivate class BillingServiceTest {\n  @isTest static void taxes() { System.assertEquals(2, new BillingService().tax(10)); }\n}';
const TRIGGER = 'trigger AccountTrigger on Account (before insert) {}';

const uat: SalesforceOrg = {
  key: 'uat',
  name: 'UAT',
  myDomain: UAT,
  host: new URL(UAT).host,
  sandbox: true,
  enabled: true,
  clientId: 'uat-client',
  scopes: ['sfa-read', 'sfa-apex'],
  policy: EMPTY_POLICY,
  productionChanges: false,
};

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

/** The checkout: path → content. */
let repo: Map<string, string>;
/** `git status --porcelain` lines of the uncommitted changes. */
let changes: string[];
/** The org's own Apex: name → { body, status, kind }. */
let live: Map<string, { kind: 'class' | 'trigger'; body: string; status: string }>;
/** What the org's test run reports. */
let testRun: Record<string, unknown>;
let requests: { method: string; path: string; query: string; body: unknown }[];
/** The org and tool each Salesforce connection was resolved for. */
let resolvedFor: ({ org?: string; tool: string } | undefined)[];

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  );
  const method = init?.method ?? 'GET';
  requests.push({ method, path: url.pathname, query: url.search, body: init?.body });
  const q = url.searchParams.get('q') ?? '';
  if (method === 'GET' && url.pathname === `${V}/query`) {
    const exact =
      /FROM (ApexClass|ApexTrigger) WHERE Name = '(\w+)' AND NamespacePrefix = null/.exec(q);
    if (exact) {
      const found = live.get(exact[2]);
      const kind = exact[1] === 'ApexClass' ? 'class' : 'trigger';
      const records =
        found && found.kind === kind
          ? [
              {
                Id: '01p000000000001AAA',
                Name: exact[2],
                ApiVersion: 62,
                Status: found.status,
                Body: found.body,
                ...(kind === 'trigger' ? { TableEnumOrId: 'Account' } : {}),
              },
            ]
          : [];
      return answer(200, { totalSize: records.length, done: true, records });
    }
    return answer(200, { totalSize: 0, done: true, records: [] });
  }
  const done = {
    id: DEPLOY,
    deployResult: {
      id: DEPLOY,
      done: true,
      status: 'Succeeded',
      success: true,
      checkOnly: true,
      details: { componentFailures: [], runTestResult: testRun },
    },
  };
  if (method === 'POST' && url.pathname === `${V}/metadata/deployRequest`) return answer(201, done);
  if (method === 'GET' && url.pathname === `${V}/metadata/deployRequest/${DEPLOY}`)
    return answer(200, done);
  return answer(404, [
    { errorCode: 'NOT_FOUND', message: `no stub for ${method} ${url.pathname}` },
  ]);
}) as typeof fetch;

/** The deploy Salesforce received: its options and the files in its zip. */
async function received() {
  const body = requests.find((r) => r.method === 'POST' && r.path.endsWith('/deployRequest'))?.body;
  if (!(body instanceof Uint8Array)) throw new Error('no deploy');
  const boundary = Buffer.from(body).toString('latin1').split('\r\n', 1)[0]?.slice(2);
  const form = await new Response(new Blob([new Uint8Array(body)]), {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  }).formData();
  const json = form.get('json');
  const file = form.get('file');
  if (typeof json !== 'string' || !(file instanceof Blob)) throw new Error('parts missing');
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const files: Record<string, string> = {};
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!entry.dir) files[name] = await entry.async('string');
  }
  return { options: JSON.parse(json).deployOptions as Record<string, unknown>, files };
}

const context = { subject: 'ada', origin: 'https://renkei.test' } as LocalToolContext;
const tools = () =>
  new Map(
    salesforceApexTools({
      target: { subject: 'code-project:p1' },
      ref: { id: 'ws-1' },
      failed: (error) => ({
        content: [{ type: 'text', text: JSON.stringify(error) }],
        isError: true,
        meta: {},
      }),
    }).map((tool) => [tool.def.name, tool])
  );
async function call(name: string, input: Record<string, unknown>) {
  const tool = tools().get(name);
  if (!tool) throw new Error(`${name} missing`);
  const result = await tool.execute(input, context);
  return { ...result, text: result.content.map((part) => part.text ?? '').join('\n') };
}

const coverage = (name: string, uncovered: number, type = 'Class') => ({
  name,
  type,
  numLocations: 10,
  numLocationsNotCovered: uncovered,
});

beforeEach(() => {
  jest.clearAllMocks();
  resetApiUsage();
  repo = new Map();
  changes = [];
  live = new Map();
  requests = [];
  resolvedFor = [];
  testRun = { numTestsRun: 1, failures: [], codeCoverage: [coverage('BillingService', 1)] };
  app.listSalesforceConnectors.mockResolvedValue([uat]);
  client.resolveSalesforceAccess.mockImplementation(async () => {
    resolvedFor.push(orgCall.getStore());
    return access;
  });
  sandbox.sbWorkspaceRead.mockImplementation(async (_target: unknown, input: { path: string }) => {
    const text = repo.get(input.path);
    return text === undefined
      ? {
          ok: false,
          err: {
            kind: 'op',
            type: 'not_found',
            message: `No such file: ${input.path}`,
            status: 404,
          },
        }
      : {
          ok: true,
          val: {
            path: input.path,
            text,
            sizeBytes: text.length,
            totalLines: 1,
            startLine: 1,
            endLine: 1,
          },
        };
  });
  sandbox.sbWorkspaceWrite.mockImplementation(
    async (_target: unknown, input: { path: string; content: string }) => {
      const created = !repo.has(input.path);
      repo.set(input.path, input.content);
      return { ok: true, val: { path: input.path, created, sizeBytes: input.content.length } };
    }
  );
  sandbox.sbWorkspaceGitStatus.mockImplementation(async () => ({
    ok: true,
    val: {
      branch: 'main',
      status: '## main',
      changes: changes.join('\n'),
      inProgress: null,
      conflicts: [],
    },
  }));
  sandbox.sbWorkspaceFind.mockImplementation(async (_target: unknown, input: { glob: string }) => {
    const pattern =
      input.glob === '**/classes/*.cls' ? /\/classes\/[^/]+\.cls$/ : /\/triggers\/[^/]+\.trigger$/;
    return {
      ok: true,
      val: { paths: [...repo.keys()].filter((p) => pattern.test(p)), truncated: false },
    };
  });
  apexAccess.salesforceApexAvailable.mockResolvedValue(true);
  grants.listSalesforceConnections.mockResolvedValue([
    {
      accountId: 'a',
      connector: 'uat',
      displayName: 'Ada',
      username: 'ada',
      instanceUrl: UAT,
      requestedScopes: ['sfa-read', 'sfa-apex'],
    },
  ]);
  store.createChangeRequest.mockImplementation(async (input: Record<string, unknown>) => ({
    id: '11111111-2222-4333-8444-555555555555',
    ...input,
  }));
});

describe('pulling Apex into the repository', () => {
  it('writes a class and its meta file in the Salesforce DX layout, and the project file the repository lacked', async () => {
    live.set('BillingService', { kind: 'class', body: BILLING, status: 'Active' });
    const result = await call(RETRIEVE_TOOL, { org: 'UAT', names: ['BillingService'] });
    expect(result.isError).toBe(false);
    expect(repo.get(`${ROOT}/classes/BillingService.cls`)).toBe(BILLING);
    expect(repo.get(`${ROOT}/classes/BillingService.cls-meta.xml`)).toContain(
      '<apiVersion>62.0</apiVersion>'
    );
    expect(JSON.parse(repo.get('sfdx-project.json') ?? '{}')).toMatchObject({
      packageDirectories: [{ path: 'force-app', default: true }],
    });
    expect(result.text).toContain(
      'Class BillingService → force-app/main/default/classes/BillingService.cls'
    );
    expect(resolvedFor).toEqual([{ org: 'UAT', tool: RETRIEVE_TOOL }]);
  });

  it('writes under the package directory the project names, and says what it could not find', async () => {
    repo.set(
      'sfdx-project.json',
      JSON.stringify({ packageDirectories: [{ path: 'billing', default: true }] })
    );
    live.set('AccountTrigger', { kind: 'trigger', body: TRIGGER, status: 'Inactive' });
    const result = await call(RETRIEVE_TOOL, { names: ['AccountTrigger', 'Nope'] });
    expect(repo.get('billing/main/default/triggers/AccountTrigger.trigger')).toBe(TRIGGER);
    expect(repo.get('billing/main/default/triggers/AccountTrigger.trigger-meta.xml')).toContain(
      '<status>Inactive</status>'
    );
    expect(result.text).toContain('switched off in the org');
    expect(result.text).toContain(
      'Nope: UAT (sandbox) has no Apex class or trigger of its own by that name.'
    );
  });

  it('refuses when the person’s connection lacks the Apex capability, writing nothing', async () => {
    client.resolveSalesforceAccess.mockResolvedValue(
      'Your connection to UAT does not allow that. Reconnect it with more access.'
    );
    const result = await call(RETRIEVE_TOOL, { names: ['BillingService'] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('does not allow');
    expect(sandbox.sbWorkspaceWrite).not.toHaveBeenCalled();
  });
});

describe('running tests in an org', () => {
  beforeEach(() => {
    live.set('BillingService', { kind: 'class', body: BILLING, status: 'Active' });
    repo.set(`${ROOT}/classes/BillingService.cls`, BILLING_EDITED);
    repo.set(`${ROOT}/classes/BillingServiceTest.cls`, BILLING_TEST);
    changes = [` M ${ROOT}/classes/BillingService.cls`];
  });

  it('sends what changed and the new test as a validation that runs the named tests, and says it would deploy', async () => {
    const result = await call(TEST_TOOL, { tests: ['BillingServiceTest'] });
    const { options, files } = await received();
    expect(options).toMatchObject({
      checkOnly: true,
      testLevel: 'RunSpecifiedTests',
      runTests: ['BillingServiceTest'],
    });
    expect(Object.keys(files).sort()).toEqual([
      'classes/BillingService.cls',
      'classes/BillingService.cls-meta.xml',
      'classes/BillingServiceTest.cls',
      'classes/BillingServiceTest.cls-meta.xml',
      'package.xml',
    ]);
    expect(files['classes/BillingService.cls']).toBe(BILLING_EDITED);
    expect(result.text).toContain('nothing in the org changed');
    expect(result.text).toContain('Coverage of BillingService (class): 90%');
    expect(result.text).toContain('this would be allowed to deploy');
    // The test class itself is run, not measured.
    expect(result.text).not.toContain('Coverage of BillingServiceTest');
  });

  it('says why a run would not deploy: a failing test, and a class under 80%', async () => {
    testRun = {
      numTestsRun: 2,
      failures: { name: 'BillingServiceTest', methodName: 'taxes', message: 'Expected 2, got 1' },
      codeCoverage: [coverage('BillingService', 3)],
    };
    const result = await call(TEST_TOOL, { tests: ['BillingServiceTest'] });
    expect(result.text).toContain('Tests (BillingServiceTest): 1 of 2 passed.');
    expect(result.text).toContain('• BillingServiceTest.taxes failed: Expected 2, got 1');
    expect(result.text).toContain(
      '• BillingService (class) is 70% covered (7 of 10 lines); it needs 80%.'
    );
  });

  it('asks for the tests to run, and for what to send when nothing changed', async () => {
    expect((await call(TEST_TOOL, {})).text).toContain('Name the test classes to run');
    changes = [];
    repo.delete(`${ROOT}/classes/BillingServiceTest.cls`);
    expect((await call(TEST_TOOL, { tests: ['BillingServiceTest'] })).text).toContain(
      'Nothing to send'
    );
  });
});

describe('proposing Apex as a change request', () => {
  beforeEach(() => {
    live.set('BillingService', { kind: 'class', body: BILLING, status: 'Active' });
    live.set('AccountTrigger', { kind: 'trigger', body: TRIGGER, status: 'Active' });
    live.set('OldHelper', { kind: 'class', body: 'public class OldHelper {}', status: 'Active' });
    repo.set(`${ROOT}/classes/BillingService.cls`, BILLING_EDITED);
    repo.set(`${ROOT}/classes/BillingServiceTest.cls`, BILLING_TEST);
    changes = [
      ` M ${ROOT}/classes/BillingService.cls`,
      `?? ${ROOT}/classes/BillingServiceTest.cls`,
    ];
  });

  it('carries the tests, a diff per class and what the org must still be, and links the review', async () => {
    const result = await call(PROPOSE_TOOL, {
      org: 'UAT',
      tests: ['BillingServiceTest'],
      reason: 'Tax rate went up',
    });
    expect(result.isError).toBe(false);
    const stored = store.createChangeRequest.mock.calls[0][0];
    expect(stored).toMatchObject({
      kind: 'apex',
      title: 'Apex: BillingService, BillingServiceTest',
    });
    const payload = readMetadataPayload(stored.payload);
    expect(payload?.apexTests).toEqual(['BillingServiceTest']);
    // The test class deploys, but its own coverage does not count.
    expect(payload?.apexMeasured).toEqual([{ kind: 'class', name: 'BillingService' }]);
    expect(payload?.preconditions).toEqual([
      {
        kind: 'apex-unchanged',
        type: 'class',
        name: 'BillingService',
        fingerprint: apexFingerprint(BILLING, 'Active'),
      },
      { kind: 'apex-absent', type: 'class', name: 'BillingServiceTest' },
    ]);
    const billing = payload?.components.find((c) => c.name === 'BillingService');
    expect(billing?.action).toBe('update');
    expect(billing?.diff).toContain('-  public Decimal tax(Decimal x) { return x * 0.1; }');
    expect(billing?.diff).toContain('+  public Decimal tax(Decimal x) { return x * 0.2; }');
    expect(payload?.components.find((c) => c.name === 'BillingServiceTest')?.action).toBe('create');
    // The validation ran the tests, in a sandbox too.
    expect((await received()).options).toMatchObject({
      checkOnly: true,
      runTests: ['BillingServiceTest'],
    });
    expect(result.text).toContain('Coverage of BillingService: 90%');
    expect(result.text).toContain(
      'Review and approve: https://renkei.test/salesforce-admin/changes/'
    );
  });

  it('switches a trigger off with its source as it is, and deletes a class after the rest', async () => {
    await call(PROPOSE_TOOL, {
      tests: ['BillingServiceTest'],
      names: ['BillingService'],
      deactivateTriggers: ['AccountTrigger'],
      deleteClasses: ['OldHelper'],
    });
    const { files } = await received();
    expect(files['triggers/AccountTrigger.trigger']).toBe(TRIGGER);
    expect(files['triggers/AccountTrigger.trigger-meta.xml']).toContain(
      '<status>Inactive</status>'
    );
    expect(files['destructiveChangesPost.xml']).toContain('<members>OldHelper</members>');
    const payload = readMetadataPayload(store.createChangeRequest.mock.calls[0][0].payload);
    // A switched-off trigger and a deleted class are not measured.
    expect(payload?.apexMeasured).toEqual([{ kind: 'class', name: 'BillingService' }]);
    expect(payload?.components.find((c) => c.name === 'OldHelper')).toMatchObject({
      action: 'delete',
    });
    expect(payload?.components.find((c) => c.name === 'AccountTrigger')?.rows).toContainEqual({
      label: 'Status',
      value: 'Inactive',
      from: 'Active',
    });
  });

  it('leaves out what the org already has, and proposes nothing when that is everything', async () => {
    repo.set(`${ROOT}/classes/BillingService.cls`, BILLING);
    live.set('BillingServiceTest', { kind: 'class', body: BILLING_TEST, status: 'Active' });
    const result = await call(PROPOSE_TOOL, {
      tests: ['BillingServiceTest'],
      names: ['BillingService'],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('BillingService is already as UAT (sandbox) has it.');
    expect(store.createChangeRequest).not.toHaveBeenCalled();
  });

  it('refuses a production org that does not take change requests, before reading anything', async () => {
    app.listSalesforceConnectors.mockResolvedValue([{ ...uat, sandbox: false }]);
    const result = await call(PROPOSE_TOOL, { tests: ['BillingServiceTest'] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('does not take change requests');
    expect(requests).toHaveLength(0);
  });
});

describe('what the code pane’s Apex panel starts from', () => {
  const checkout = { target: { subject: 'code-project:p1' }, workspaceId: 'ws-1' };
  const caller = { subject: 'ada', origin: 'https://renkei.test' };

  it('is not offered for a repository without Apex, nor to someone without the capability', async () => {
    repo.set('README.md', '# hello');
    expect(await apexPanelStatus(checkout, caller)).toMatchObject({
      available: true,
      present: false,
    });
    repo.set(`${ROOT}/classes/BillingService.cls`, BILLING);
    apexAccess.salesforceApexAvailable.mockResolvedValue(false);
    expect(await apexPanelStatus(checkout, caller)).toMatchObject({
      available: false,
      present: true,
      orgs: [],
    });
  });

  it('lists the orgs the capability reaches, what changed, and the test classes there are', async () => {
    repo.set(`${ROOT}/classes/BillingService.cls`, BILLING_EDITED);
    repo.set(`${ROOT}/classes/BillingServiceTest.cls`, BILLING_TEST);
    repo.set(`${ROOT}/classes/TestDataFactory.cls`, 'public class TestDataFactory {}');
    repo.set(`${ROOT}/triggers/AccountTrigger.trigger`, TRIGGER);
    changes = [
      ` M ${ROOT}/classes/BillingService.cls`,
      `?? ${ROOT}/classes/BillingServiceTest.cls`,
    ];
    const status = await apexPanelStatus(checkout, caller);
    expect(status).toMatchObject({
      available: true,
      present: true,
      root: ROOT,
      orgs: [{ key: 'uat', name: 'UAT', sandbox: true, takesChanges: true }],
      changed: [
        { kind: 'class', name: 'BillingService', status: 'modified' },
        { kind: 'class', name: 'BillingServiceTest', status: 'new' },
      ],
      // A helper whose name says Test is not a test class without the annotation.
      testClasses: ['BillingServiceTest'],
    });
    expect('units' in status ? status.units.map((u) => u.name).sort() : []).toEqual([
      'AccountTrigger',
      'BillingService',
      'BillingServiceTest',
      'TestDataFactory',
    ]);
  });

  it('leaves out an org whose connection lacks the capability', async () => {
    repo.set(`${ROOT}/classes/BillingService.cls`, BILLING);
    grants.listSalesforceConnections.mockResolvedValue([
      {
        accountId: 'a',
        connector: 'uat',
        displayName: 'Ada',
        username: 'ada',
        instanceUrl: UAT,
        requestedScopes: ['sfa-read'],
      },
    ]);
    expect(await apexPanelStatus(checkout, caller)).toMatchObject({ orgs: [] });
  });

  it('searches the org’s own classes and triggers by name', async () => {
    const result = await searchOrgApex(caller, { org: 'UAT', query: 'Bill_ing' });
    expect(result).toMatchObject({ where: 'UAT (sandbox)', entries: [] });
    const queries = requests
      .filter((r) => r.path.endsWith('/query'))
      .map((r) => new URLSearchParams(r.query).get('q'));
    expect(queries).toEqual([
      "SELECT Name, Status FROM ApexClass WHERE Name LIKE '%Bill\\_ing%' AND NamespacePrefix = null ORDER BY Name LIMIT 50",
      "SELECT Name, Status, TableEnumOrId FROM ApexTrigger WHERE Name LIKE '%Bill\\_ing%' AND NamespacePrefix = null ORDER BY Name LIMIT 50",
    ]);
  });

  it('starts a run, then reads how it ended, held to what it sent', async () => {
    live.set('BillingService', { kind: 'class', body: BILLING, status: 'Active' });
    repo.set(`${ROOT}/classes/BillingService.cls`, BILLING_EDITED);
    changes = [` M ${ROOT}/classes/BillingService.cls`];
    const started = await startApexTests(checkout, caller, {
      org: 'UAT',
      tests: ['BillingServiceTest'],
      names: [],
    });
    expect(started).toMatchObject({
      deployId: DEPLOY,
      sent: [{ name: 'BillingService', kind: 'class', addedTest: false }],
      measured: [{ kind: 'class', name: 'BillingService' }],
    });
    const report = await apexTestStatus(caller, {
      org: 'UAT',
      deployId: DEPLOY,
      measured: [{ kind: 'class', name: 'BillingService' }],
      waitMs: 0,
    });
    expect(report).toMatchObject({
      done: true,
      ok: true,
      coverage: [{ unit: { kind: 'class', name: 'BillingService' }, percent: 90 }],
      problems: [],
    });
  });

  it('answers a proposal with its id and review link', async () => {
    live.set('BillingService', { kind: 'class', body: BILLING, status: 'Active' });
    repo.set(`${ROOT}/classes/BillingService.cls`, BILLING_EDITED);
    changes = [` M ${ROOT}/classes/BillingService.cls`];
    const proposed = await proposeApex(checkout, caller, {
      org: 'UAT',
      tests: ['BillingServiceTest'],
      names: [],
      deactivateTriggers: [],
      deleteClasses: [],
    });
    expect(proposed).toMatchObject({
      changeId: '11111111-2222-4333-8444-555555555555',
      url: 'https://renkei.test/salesforce-admin/changes/11111111-2222-4333-8444-555555555555',
      title: 'Apex: BillingService',
    });
  });
});
