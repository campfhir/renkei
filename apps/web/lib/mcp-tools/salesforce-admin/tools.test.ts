/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The salesforce_admin_ tools against a fake org: which tools a
 * connection's capabilities register (none without any); a field proposal
 * that checks names against every existing field, resolves the permission
 * sets it grants, stores a change request with its preconditions, and has
 * Salesforce validate the exact package — a check-only deploy of a zip
 * holding only the new members; a proposal refused in a production org that
 * takes no changes, before anything is stored or sent; a failed validation
 * handed back in Salesforce's words; and a rule change that keeps what the
 * rule was, so the review page shows old against new and apply can tell if
 * it moved.
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
  setValidation: jest.fn(),
  cancelChangeRequest: jest.fn(),
}));

import JSZip from 'jszip';
import type { McpServer } from '@modelcontextprotocol/server';
import { authedFetch } from '@renkei/delegate-client';
import { EMPTY_POLICY, type SalesforceOrg } from '@renkei/connector-salesforce';
import type { MCPToolContext } from '../common';
import type { SalesforceAuth } from '../salesforce/salesforce-auth';
import { invalidateDescribe } from '../salesforce/schema';
import { resetApiUsage } from '../salesforce/client';
import { ALL_SALESFORCE_ADMIN_SCOPES } from '@/lib/salesforce-admin-scopes';
import { registerSalesforceAdminTools } from './index';
import { salesforceAdminScopeFor } from './scopes';

const app = jest.requireMock<{ listSalesforceConnectors: jest.Mock }>('@/lib/salesforce-app');
const store = jest.requireMock<{
  createChangeRequest: jest.Mock;
  setValidation: jest.Mock;
  cancelChangeRequest: jest.Mock;
}>('@/lib/salesforce-admin/change-requests');

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const UAT = 'https://acme--uat.sandbox.my.salesforce.com';
const V = '/services/data/v68.0';
const DEPLOY = '0Af000000000001AAA';

const org = (key: string, sandbox: boolean, productionChanges = false): SalesforceOrg => ({
  key,
  name: key.toUpperCase(),
  myDomain: UAT,
  host: new URL(UAT).host,
  sandbox,
  enabled: true,
  clientId: `${key}-client`,
  scopes: ALL_SALESFORCE_ADMIN_SCOPES,
  policy: EMPTY_POLICY,
  productionChanges,
});

let connector: SalesforceOrg;

const stubAuth: SalesforceAuth = {
  kind: 'oauth',
  resolve: async () => ({
    auth: authedFetch((url, init) => fetch(url, init), 'salesforce-admin:00D/005'),
    accountId: '00D000000000062EAA/005000000000001AAA',
    orgId: '00D000000000062EAA',
    userId: '005000000000001AAA',
    instanceUrl: UAT,
    username: 'ada@acme.org',
    connector: connector.key,
    connectorName: connector.name,
    sandbox: connector.sandbox,
    policy: EMPTY_POLICY,
  }),
};

const SITE_VISIT = {
  name: 'Site_Visit__c',
  label: 'Site Visit',
  labelPlural: 'Site Visits',
  custom: true,
  fields: [
    { name: 'Id', label: 'Record ID', type: 'id' },
    { name: 'Name', label: 'Visit Number', type: 'string', nameField: true },
    { name: 'Stage__c', label: 'Stage', type: 'picklist', custom: true },
    { name: 'Visit_Date__c', label: 'Visit Date', type: 'date', custom: true },
  ],
  childRelationships: [],
  recordTypeInfos: [],
};

let requests: { method: string; path: string; query: string; body: unknown }[];
let checkOnlyAnswer: Record<string, unknown>;
let existingRule: Record<string, unknown> | null;

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeOrg(method: string, path: string, query: string): Response {
  const q = new URLSearchParams(query).get('q') ?? '';
  if (method === 'GET' && path === `${V}/sobjects`) {
    return answer(200, {
      sobjects: [
        {
          name: 'Site_Visit__c',
          label: 'Site Visit',
          keyPrefix: 'a01',
          custom: true,
          queryable: true,
        },
        { name: 'Contact', label: 'Contact', keyPrefix: '003', queryable: true },
      ],
    });
  }
  if (method === 'GET' && path === `${V}/sobjects/Site_Visit__c/describe`)
    return answer(200, SITE_VISIT);
  if (method === 'GET' && path === `${V}/query` && /FROM FieldDefinition/.test(q)) {
    // Every field, including one the person's field-level access hides from the describe.
    return answer(200, {
      totalSize: 5,
      done: true,
      records: ['Id', 'Name', 'Stage__c', 'Visit_Date__c', 'Hidden_Score__c'].map((n) => ({
        QualifiedApiName: n,
      })),
    });
  }
  if (method === 'GET' && path === `${V}/query` && /FROM PermissionSet/.test(q)) {
    return answer(200, {
      totalSize: 1,
      done: true,
      records: [{ Id: '0PS000000000001AAA', Name: 'Program_Staff', Label: 'Program Staff' }],
    });
  }
  if (method === 'GET' && path === `${V}/tooling/query` && /FROM ValidationRule/.test(q)) {
    return answer(200, {
      totalSize: existingRule ? 1 : 0,
      done: true,
      records: existingRule ? [existingRule] : [],
    });
  }
  if (method === 'POST' && path === `${V}/metadata/deployRequest`) {
    return answer(201, {
      id: DEPLOY,
      deployResult: { id: DEPLOY, done: false, status: 'Pending' },
    });
  }
  if (method === 'GET' && path === `${V}/metadata/deployRequest/${DEPLOY}`) {
    return answer(200, { id: DEPLOY, deployResult: { id: DEPLOY, ...checkOnlyAnswer } });
  }
  return answer(404, [{ errorCode: 'NOT_FOUND', message: `no stub for ${method} ${path}` }]);
}

const fetchSpy = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  );
  const method = init?.method ?? 'GET';
  requests.push({ method, path: url.pathname, query: url.search.slice(1), body: init?.body });
  expect(url.origin).toBe(UAT);
  return fakeOrg(method, url.pathname, url.search.slice(1));
});

async function tools(scopes: string[] | null = ALL_SALESFORCE_ADMIN_SCOPES) {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registerSalesforceAdminTools(
    server,
    {
      subject: 'subject-1',
      origin: 'https://renkei.example',
      db: {},
      salesforceAdminScopes: scopes ?? undefined,
    } as unknown as MCPToolContext,
    stubAuth
  );
  return handlers;
}

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const handler = (await tools()).get(name);
  if (!handler) throw new Error(`${name} is not registered`);
  return handler(args);
}

const text = (result: ToolResult) => result.content[0]?.text ?? '';
const deploys = () =>
  requests.filter((r) => r.method === 'POST' && r.path.endsWith('/deployRequest'));

/** The deploy Salesforce received: its options, and the files in its zip. */
async function received(index = 0) {
  const body = deploys()[index]?.body;
  if (!(body instanceof FormData)) throw new Error('not multipart');
  const json = body.get('json');
  const file = body.get('file');
  if (!(json instanceof Blob) || !(file instanceof Blob)) throw new Error('parts missing');
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const files: Record<string, string> = {};
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!entry.dir) files[name] = await entry.async('string');
  }
  return { options: JSON.parse(await json.text()).deployOptions, files };
}

beforeEach(() => {
  jest.clearAllMocks();
  requests = [];
  existingRule = null;
  connector = org('uat', true);
  checkOnlyAnswer = { done: true, success: true, status: 'Succeeded', checkOnly: true };
  app.listSalesforceConnectors.mockImplementation(async () => [connector]);
  store.createChangeRequest.mockImplementation(
    async (_db: unknown, input: Record<string, unknown>) => ({
      id: '11111111-2222-4333-8444-555555555555',
      ...input,
    })
  );
  resetApiUsage();
  invalidateDescribe();
  global.fetch = fetchSpy as unknown as typeof fetch;
});

describe('registration', () => {
  it('registers by capability, and nothing beyond the org list without any', async () => {
    const all = await tools();
    expect(
      [...all.keys()].every((name) => salesforceAdminScopeFor(name)[0] !== '__unmapped__')
    ).toBe(true);
    expect(all.has('salesforce_admin_propose_fields')).toBe(true);
    const readOnly = await tools(['sfa-read']);
    expect(readOnly.has('salesforce_admin_describe_object')).toBe(true);
    expect(readOnly.has('salesforce_admin_propose_fields')).toBe(false);
    expect([...(await tools(null)).keys()]).toEqual(['salesforce_admin_list_orgs']);
  });
});

describe('salesforce_admin_propose_fields', () => {
  it('stores the exact package and has Salesforce validate it, changing nothing', async () => {
    const result = await call('salesforce_admin_propose_fields', {
      object: 'Site Visit',
      fields: [
        { label: 'Outcome', type: 'Picklist', values: ['Completed', 'No show'] },
        { label: 'Visit Notes', type: 'LongTextArea', helpText: 'What happened & why' },
      ],
      grantTo: [{ permissionSet: 'Program Staff', edit: true }],
      reason: 'The program tracks outcomes now',
    });
    expect(result.isError).toBeUndefined();

    const { options, files } = await received();
    expect(options).toMatchObject({
      checkOnly: true,
      rollbackOnError: true,
      testLevel: 'NoTestRun',
    });
    expect(Object.keys(files).sort()).toEqual(['objects/Site_Visit__c.object', 'package.xml']);
    expect(files['package.xml']).toContain('<members>Site_Visit__c.Outcome__c</members>');
    expect(files['package.xml']).toContain('<members>Site_Visit__c.Visit_Notes__c</members>');
    expect(files['objects/Site_Visit__c.object']).toContain('What happened &amp; why');
    // Nothing on the object but the new fields.
    expect(files['objects/Site_Visit__c.object']).not.toContain('Stage__c');

    const stored = store.createChangeRequest.mock.calls[0][1];
    expect(stored).toMatchObject({
      connectorKey: 'uat',
      orgId: '00D000000000062EAA',
      kind: 'fields',
      title: 'Site Visit: add 2 fields (Outcome, Visit Notes)',
    });
    expect(stored.payload.preconditions).toEqual([
      { kind: 'field-absent', object: 'Site_Visit__c', field: 'Outcome__c' },
      { kind: 'field-absent', object: 'Site_Visit__c', field: 'Visit_Notes__c' },
    ]);
    expect(stored.payload.fieldGrants).toEqual([
      expect.objectContaining({
        permissionSetName: 'Program_Staff',
        field: 'Outcome__c',
        edit: true,
      }),
      expect.objectContaining({
        permissionSetName: 'Program_Staff',
        field: 'Visit_Notes__c',
        edit: true,
      }),
    ]);
    expect(store.setValidation.mock.calls[0][2]).toMatchObject({
      deployId: DEPLOY,
      done: true,
      success: true,
    });
    expect(text(result)).toContain('nothing has changed in Salesforce yet');
    expect(text(result)).toContain('Salesforce validated it');
    expect(text(result)).toContain(
      'Review and apply: https://renkei.example/salesforce-admin/changes/11111111-2222-4333-8444-555555555555'
    );
    // Nothing deployed for real, no data written.
    expect(requests.some((r) => r.method === 'POST' && !r.path.endsWith('/deployRequest'))).toBe(
      false
    );
  });

  it('refuses a name clash with a field the describe does not show, before anything is stored', async () => {
    const result = await call('salesforce_admin_propose_fields', {
      object: 'Site_Visit__c',
      fields: [{ label: 'Hidden Score', type: 'Number' }],
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Site_Visit__c already has a field Hidden_Score__c.');
    expect(store.createChangeRequest).not.toHaveBeenCalled();
    expect(deploys()).toHaveLength(0);
  });

  it('refuses in a production org that takes no changes', async () => {
    connector = org('production', false);
    const result = await call('salesforce_admin_propose_fields', {
      object: 'Site_Visit__c',
      fields: [{ label: 'Outcome', type: 'Text' }],
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('does not take change requests');
    expect(requests).toHaveLength(0);
    expect(store.createChangeRequest).not.toHaveBeenCalled();
  });

  it('hands back a failed validation in Salesforce’s words', async () => {
    checkOnlyAnswer = {
      done: true,
      success: false,
      status: 'Failed',
      details: {
        componentFailures: [
          {
            componentType: 'CustomField',
            fullName: 'Site_Visit__c.Outcome__c',
            problem: 'Picklist value too long',
          },
        ],
      },
    };
    const result = await call('salesforce_admin_propose_fields', {
      object: 'Site_Visit__c',
      fields: [{ label: 'Outcome', type: 'Picklist', values: ['Completed'] }],
    });
    expect(text(result)).toContain('Salesforce’s validation failed');
    expect(text(result)).toContain('CustomField Site_Visit__c.Outcome__c: Picklist value too long');
  });
});

describe('salesforce_admin_propose_validation_rule', () => {
  it('keeps what an existing rule was, for the review page and the apply check', async () => {
    existingRule = {
      Id: '03d000000000001AAA',
      ValidationName: 'Visit_Date_Required',
      Active: true,
      ErrorMessage: 'Enter the visit date.',
      ErrorDisplayField: 'Visit_Date__c',
      Metadata: {
        errorConditionFormula: "ISPICKVAL(Stage__c, 'Completed')",
        errorMessage: 'Enter the visit date.',
      },
    };
    const result = await call('salesforce_admin_propose_validation_rule', {
      object: 'Site_Visit__c',
      name: 'Visit_Date_Required',
      formula: "ISPICKVAL(Stage__c, 'Completed') && ISBLANK(Visit_Date__c)",
      message: 'Enter the visit date before completing the visit.',
      errorDisplayField: 'Visit_Date__c',
    });
    expect(result.isError).toBeUndefined();
    const stored = store.createChangeRequest.mock.calls[0][1];
    expect(stored.title).toBe('Site Visit: change the validation rule Visit_Date_Required');
    expect(stored.payload.preconditions).toEqual([
      expect.objectContaining({ kind: 'rule-unchanged', rule: 'Visit_Date_Required' }),
    ]);
    expect(stored.payload.components[0].rows).toEqual(
      expect.arrayContaining([
        {
          label: 'Formula',
          value: "ISPICKVAL(Stage__c, 'Completed') && ISBLANK(Visit_Date__c)",
          from: "ISPICKVAL(Stage__c, 'Completed')",
        },
      ])
    );
    const { files } = await received();
    expect(files['package.xml']).toContain('<members>Site_Visit__c.Visit_Date_Required</members>');
  });

  it('refuses a message field the object does not have', async () => {
    const result = await call('salesforce_admin_propose_validation_rule', {
      object: 'Site_Visit__c',
      name: 'X',
      formula: 'true',
      message: 'No',
      errorDisplayField: 'Nope__c',
    });
    expect(result.isError).toBe(true);
    expect(deploys()).toHaveLength(0);
  });
});
