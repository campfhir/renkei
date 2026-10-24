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
  createRequest: jest.fn(),
  getChangeRequestById: jest.fn(),
  closeRequestAsProposed: jest.fn(),
  listAllChangeRequests: jest.fn(),
  listChangeRequests: jest.fn(),
  setValidation: jest.fn(),
  cancelChangeRequest: jest.fn(),
}));
jest.mock('@/lib/admin-changes/notify', () => ({
  notifyOperatorsOfRequest: jest.fn(),
  notifyChangeOutcome: jest.fn(),
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
  createRequest: jest.Mock;
  getChangeRequestById: jest.Mock;
  closeRequestAsProposed: jest.Mock;
  listAllChangeRequests: jest.Mock;
  listChangeRequests: jest.Mock;
  setValidation: jest.Mock;
  cancelChangeRequest: jest.Mock;
}>('@/lib/salesforce-admin/change-requests');
const notify = jest.requireMock<{
  notifyOperatorsOfRequest: jest.Mock;
  notifyChangeOutcome: jest.Mock;
}>('@/lib/admin-changes/notify');

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
    {
      name: 'Stage__c',
      label: 'Stage',
      type: 'picklist',
      custom: true,
      nillable: true,
      picklistValues: [
        { value: 'Draft', label: 'Draft', active: true, defaultValue: true },
        { value: 'Done', label: 'Done', active: true, defaultValue: false },
      ],
    },
    {
      name: 'Region__c',
      label: 'Region',
      type: 'picklist',
      custom: true,
      nillable: true,
      picklistValues: [{ value: 'North', label: 'North', active: true, defaultValue: false }],
    },
    { name: 'Visit_Date__c', label: 'Visit Date', type: 'date', custom: true },
  ],
  childRelationships: [],
  recordTypeInfos: [],
};

let requests: { method: string; path: string; query: string; body: unknown }[];
let checkOnlyAnswer: Record<string, unknown>;
let existingRule: Record<string, unknown> | null;
let layoutMetadata: Record<string, unknown>;
let fieldMetadata: Record<string, Record<string, unknown>>;
let objectRows: Record<string, unknown>[];
let assigned: string[];

const ENTITY = '01I000000000001AAA';
const HOME_VISIT = '012000000000001AAA';
const GRANT = '012000000000002AAA';
const GRANT_PROCESS = '019000000000001AAA';
let homeVisitMetadata: Record<string, unknown>;

const LEAD = {
  name: 'Lead',
  label: 'Lead',
  labelPlural: 'Leads',
  fields: [
    { name: 'Id', label: 'Lead ID', type: 'id' },
    {
      name: 'LeadSource',
      label: 'Lead Source',
      type: 'picklist',
      nillable: true,
      picklistValues: [
        { value: 'Web', label: 'Web', active: true, defaultValue: false },
        { value: 'Referral', label: 'Referral', active: true, defaultValue: false },
      ],
    },
  ],
  childRelationships: [],
  recordTypeInfos: [],
};

const OPPORTUNITY = {
  name: 'Opportunity',
  label: 'Opportunity',
  labelPlural: 'Opportunities',
  fields: [
    { name: 'Id', label: 'Opportunity ID', type: 'id' },
    {
      name: 'StageName',
      label: 'Stage',
      type: 'picklist',
      picklistValues: [
        { value: 'Prospecting', label: 'Prospecting', active: true, defaultValue: true },
      ],
    },
  ],
  childRelationships: [],
  recordTypeInfos: [],
};
const LAYOUT_ID = '00h000000000001AAA';

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
        { name: 'Lead', label: 'Lead', keyPrefix: '00Q', queryable: true },
        { name: 'Opportunity', label: 'Opportunity', keyPrefix: '006', queryable: true },
      ],
    });
  }
  if (method === 'GET' && path === `${V}/sobjects/Lead/describe`) return answer(200, LEAD);
  if (method === 'GET' && path === `${V}/sobjects/Opportunity/describe`)
    return answer(200, OPPORTUNITY);
  if (method === 'GET' && path === `${V}/query` && /FROM RecordType WHERE SobjectType/.test(q)) {
    const rows = /'Site_Visit__c'/.test(q)
      ? [
          {
            Id: HOME_VISIT,
            Name: 'Home Visit',
            DeveloperName: 'Home_Visit',
            IsActive: true,
            BusinessProcessId: null,
          },
        ]
      : /'Opportunity'/.test(q)
        ? [
            {
              Id: GRANT,
              Name: 'Grant',
              DeveloperName: 'Grant',
              IsActive: true,
              BusinessProcessId: GRANT_PROCESS,
            },
          ]
        : [];
    return answer(200, { totalSize: rows.length, done: true, records: rows });
  }
  if (method === 'GET' && path === `${V}/tooling/query` && /FROM RecordType WHERE Id/.test(q)) {
    const home = q.includes(HOME_VISIT);
    return answer(200, {
      totalSize: 1,
      done: true,
      records: [
        home
          ? {
              Id: HOME_VISIT,
              DeveloperName: 'Home_Visit',
              FullName: 'Site_Visit__c.Home_Visit',
              Metadata: homeVisitMetadata,
            }
          : {
              Id: GRANT,
              DeveloperName: 'Grant',
              FullName: 'Opportunity.Grant',
              Metadata: {
                label: 'Grant',
                active: true,
                businessProcess: 'Grants',
                picklistValues: [],
              },
            },
      ],
    });
  }
  if (
    method === 'GET' &&
    path === `${V}/query` &&
    /FROM BusinessProcess WHERE TableEnumOrId/.test(q)
  ) {
    return answer(200, {
      totalSize: 1,
      done: true,
      records: [{ Id: GRANT_PROCESS, Name: 'Grants', IsActive: true }],
    });
  }
  if (
    method === 'GET' &&
    path === `${V}/tooling/query` &&
    /FROM BusinessProcess WHERE Id/.test(q)
  ) {
    return answer(200, {
      totalSize: 1,
      done: true,
      records: [
        {
          Id: GRANT_PROCESS,
          Name: 'Grants',
          FullName: 'Opportunity.Grants',
          Metadata: { isActive: true, values: [{ fullName: 'Prospecting', default: true }] },
        },
      ],
    });
  }
  if (method === 'GET' && path === `${V}/tooling/query` && /FROM GlobalValueSet/.test(q)) {
    return answer(200, {
      totalSize: 1,
      done: true,
      records: [
        {
          Id: '0Nt000000000001AAA',
          DeveloperName: 'Regions',
          MasterLabel: 'Regions',
          NamespacePrefix: null,
          Metadata: {
            masterLabel: 'Regions',
            sorted: false,
            customValue: [{ fullName: 'North', default: false, label: 'North' }],
            urls: null,
          },
        },
      ],
    });
  }
  if (
    method === 'GET' &&
    path === `${V}/tooling/query` &&
    /FROM MetadataComponentDependency/.test(q)
  ) {
    return answer(200, {
      totalSize: 2,
      done: true,
      records: [
        { MetadataComponentName: 'Site_Visit__c.Region__c', MetadataComponentType: 'CustomField' },
        { MetadataComponentName: 'Account.Region__c', MetadataComponentType: 'CustomField' },
      ],
    });
  }
  if (method === 'GET' && path === `${V}/query` && /FROM OpportunityStage/.test(q)) {
    return answer(200, {
      totalSize: 2,
      done: true,
      records: [
        {
          ApiName: 'Prospecting',
          MasterLabel: 'Prospecting',
          IsActive: true,
          IsClosed: false,
          IsWon: false,
          ForecastCategoryName: 'Pipeline',
          DefaultProbability: 10,
        },
        {
          ApiName: 'Old Stage',
          MasterLabel: 'Old Stage',
          IsActive: false,
          IsClosed: false,
          IsWon: false,
          ForecastCategoryName: 'Best Case',
          DefaultProbability: 50,
        },
      ],
    });
  }
  if (method === 'GET' && path === `${V}/tooling/query` && /FROM Profile WHERE Name/.test(q)) {
    return answer(200, {
      totalSize: 1,
      done: true,
      records: [{ Id: '00e000000000001AAA', Name: 'Standard User', FullName: 'Standard' }],
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
        IsNillable: n.endsWith('__c'),
        DataType: 'Text',
      })),
    });
  }
  if (method === 'GET' && path === `${V}/query` && /FROM EntityDefinition/.test(q)) {
    const known = /'(Site_Visit__c|Contact)'/.exec(q);
    return answer(200, {
      totalSize: known ? 1 : 0,
      done: true,
      records: known ? [{ QualifiedApiName: known[1], DurableId: ENTITY }] : [],
    });
  }
  if (
    method === 'GET' &&
    path === `${V}/tooling/query` &&
    /FROM Layout WHERE TableEnumOrId/.test(q)
  ) {
    return answer(200, {
      totalSize: 1,
      done: true,
      records: [{ Id: LAYOUT_ID, Name: 'Site Visit Layout' }],
    });
  }
  if (method === 'GET' && path === `${V}/tooling/query` && /FROM Layout WHERE Id/.test(q)) {
    return answer(200, {
      totalSize: 1,
      done: true,
      records: [
        {
          Id: LAYOUT_ID,
          Name: 'Site Visit Layout',
          FullName: 'Site_Visit__c-Site Visit Layout',
          Metadata: layoutMetadata,
        },
      ],
    });
  }
  if (method === 'GET' && path === `${V}/tooling/query` && /FROM ProfileLayout/.test(q)) {
    return answer(200, {
      totalSize: 1,
      done: true,
      records: [{ LayoutId: LAYOUT_ID, Profile: { Name: 'Standard User' }, RecordType: null }],
    });
  }
  if (method === 'GET' && path === `${V}/tooling/query` && /FROM CustomField/.test(q)) {
    const name = /DeveloperName = '([^']+)'/.exec(q)?.[1] ?? '';
    const metadata = fieldMetadata[`${name}__c`];
    return answer(200, {
      totalSize: metadata ? 1 : 0,
      done: true,
      records: metadata
        ? [{ Id: '00N000000000001AAA', FullName: `Site_Visit__c.${name}__c`, Metadata: metadata }]
        : [],
    });
  }
  if (method === 'GET' && path === `${V}/query` && /FROM ObjectPermissions/.test(q)) {
    return answer(200, { totalSize: objectRows.length, done: true, records: objectRows });
  }
  if (
    method === 'GET' &&
    path === `${V}/query` &&
    /FROM (FieldPermissions|PermissionSetTabSetting)/.test(q)
  ) {
    return answer(200, { totalSize: 0, done: true, records: [] });
  }
  if (method === 'GET' && path === `${V}/query` && /FROM PermissionSetAssignment/.test(q)) {
    return answer(200, {
      totalSize: assigned.length,
      done: true,
      records: assigned.map((id) => ({ AssigneeId: id })),
    });
  }
  if (method === 'GET' && path === `${V}/query` && /FROM User /.test(q)) {
    const people = [
      {
        Id: '005000000000002AAA',
        Name: 'Grace Hopper',
        Username: 'grace@acme.org',
        IsActive: true,
      },
      { Id: '005000000000003AAA', Name: 'Alan Turing', Username: 'alan@acme.org', IsActive: true },
    ].filter((p) => q.includes(`'${p.Username}'`) || q.includes(`'${p.Name}'`));
    return answer(200, { totalSize: people.length, done: true, records: people });
  }
  if (method === 'GET' && path === `${V}/query` && /FROM PermissionSet WHERE Label/.test(q)) {
    // A new set's name: nothing takes it.
    return answer(200, { totalSize: 0, done: true, records: [] });
  }
  if (
    method === 'GET' &&
    path === `${V}/query` &&
    /FROM PermissionSet WHERE Name = 'Site_Visit/.test(q)
  ) {
    return answer(200, { totalSize: 0, done: true, records: [] });
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

async function tools(
  scopes: string[] | null = ALL_SALESFORCE_ADMIN_SCOPES,
  roles?: string[]
) {
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
      ...(roles ? { roles } : {}),
    } as unknown as MCPToolContext,
    stubAuth
  );
  return handlers;
}

async function call(
  name: string,
  args: Record<string, unknown>,
  roles?: string[]
): Promise<ToolResult> {
  const handler = (await tools(ALL_SALESFORCE_ADMIN_SCOPES, roles)).get(name);
  if (!handler) throw new Error(`${name} is not registered`);
  return handler(args);
}

const text = (result: ToolResult) => result.content[0]?.text ?? '';
const deploys = () =>
  requests.filter((r) => r.method === 'POST' && r.path.endsWith('/deployRequest'));

/** The deploy Salesforce received: its options, and the files in its zip. */
async function received(index = 0) {
  const body = deploys()[index]?.body;
  if (!(body instanceof Uint8Array)) throw new Error('not multipart');
  // The body is written by hand (the json part must carry no filename), so
  // parse it back the way Salesforce would: the boundary is its first line.
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
  return { options: JSON.parse(json).deployOptions, files };
}

beforeEach(() => {
  jest.clearAllMocks();
  requests = [];
  existingRule = null;
  objectRows = [];
  assigned = [];
  layoutMetadata = {
    layoutSections: [
      {
        label: 'Information',
        style: 'TwoColumnsTopToBottom',
        layoutColumns: [
          { layoutItems: [{ behavior: 'Required', field: 'Name' }] },
          { layoutItems: [{ behavior: 'Edit', field: 'Stage__c' }] },
        ],
      },
      { label: 'System Information', layoutColumns: [{ layoutItems: [] }] },
    ],
    showHighlightsPanel: true,
    urls: null,
  };
  homeVisitMetadata = {
    label: 'Home Visit',
    active: true,
    picklistValues: [
      {
        picklist: 'Stage__c',
        values: [
          { fullName: 'Draft', default: true },
          { fullName: 'Done', default: false },
        ],
      },
    ],
    urls: null,
  };
  fieldMetadata = {
    Region__c: {
      label: 'Region',
      type: 'Picklist',
      valueSet: { restricted: true, valueSetName: 'Regions' },
    },
    Visit_Date__c: { label: 'Visit Date', type: 'Date', required: false, inlineHelpText: null },
    Stage__c: {
      label: 'Stage',
      type: 'Picklist',
      valueSet: {
        restricted: true,
        valueSetName: null,
        valueSetDefinition: {
          sorted: false,
          value: [
            { fullName: 'Draft', default: true, label: 'Draft' },
            { fullName: 'Done', default: false, label: 'Done' },
          ],
        },
      },
    },
  };
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

  it('gives someone known not to be an operator the reads and a request in words, not the proposals', async () => {
    const ordinary = [...(await tools(ALL_SALESFORCE_ADMIN_SCOPES, ['renkei-user'])).keys()];
    expect(ordinary).toContain('salesforce_admin_request_change');
    expect(ordinary).toContain('salesforce_admin_describe_object');
    expect(ordinary).toContain('salesforce_admin_list_permission_sets');
    expect(ordinary).toContain('salesforce_admin_list_change_requests');
    expect(ordinary.filter((name) => name.startsWith('salesforce_admin_propose_'))).toEqual([]);
    // An operator, and a token with no roles recorded (an agent's), keep the proposals.
    expect([...(await tools(ALL_SALESFORCE_ADMIN_SCOPES, ['renkei-operator'])).keys()]).toContain(
      'salesforce_admin_propose_fields'
    );
    expect([...(await tools()).keys()]).toContain('salesforce_admin_propose_fields');
    // The request needs only what looking things up needs.
    expect([...(await tools(['sfa-read'], ['renkei-user'])).keys()]).toContain(
      'salesforce_admin_request_change'
    );
  });
});

describe('salesforce_admin_request_change', () => {
  beforeEach(() => {
    store.createRequest.mockImplementation(async (_db: unknown, input: Record<string, unknown>) => ({
      id: '99999999-2222-4333-8444-555555555555',
      ...input,
    }));
  });

  it('stores a request in words, tells the operators, and changes nothing in the org', async () => {
    const result = await call(
      'salesforce_admin_request_change',
      {
        title: 'Add an Outcome picklist to Site Visit',
        description: 'Site_Visit__c needs Outcome__c: Completed, No show.',
        reason: 'The program tracks outcomes now',
      },
      ['renkei-user']
    );
    expect(result.isError).toBeUndefined();
    expect(store.createRequest.mock.calls[0][1]).toMatchObject({
      subject: 'subject-1',
      connectorKey: 'uat',
      orgId: '00D000000000062EAA',
      title: 'Add an Outcome picklist to Site Visit',
      description: 'Site_Visit__c needs Outcome__c: Completed, No show.',
      reason: 'The program tracks outcomes now',
    });
    expect(notify.notifyOperatorsOfRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        connector: 'salesforce-admin',
        changeId: '99999999-2222-4333-8444-555555555555',
        requester: 'subject-1',
        freeText: true,
      })
    );
    expect(text(result)).toContain('nothing has changed in Salesforce');
    expect(text(result)).toContain(
      'https://renkei.example/salesforce-admin/changes/99999999-2222-4333-8444-555555555555'
    );
    // No deploy, no write: it never reaches the org.
    expect(requests.filter((r) => r.method !== 'GET')).toEqual([]);
  });

  it('is refused for a production org that takes no changes, before anything is stored', async () => {
    connector = org('production', false);
    const result = await call(
      'salesforce_admin_request_change',
      { title: 'x', description: 'y' },
      ['renkei-user']
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('does not take change requests');
    expect(store.createRequest).not.toHaveBeenCalled();
    expect(notify.notifyOperatorsOfRequest).not.toHaveBeenCalled();
  });
});

describe('building a request in words', () => {
  it('closes the free-text request it replaces, whoever filed it, and tells its requester', async () => {
    store.getChangeRequestById.mockResolvedValue({
      id: 'b7c2a1d0-1111-4222-8333-944455556666',
      kind: 'request',
      subject: 'asker',
      title: 'Add an Outcome picklist',
    });
    store.closeRequestAsProposed.mockResolvedValue(true);
    await call(
      'salesforce_admin_propose_fields',
      {
        object: 'Site Visit',
        fields: [{ label: 'Outcome', type: 'Picklist', values: ['Completed'] }],
        replaces: 'b7c2a1d0-1111-4222-8333-944455556666',
      },
      ['renkei-operator']
    );
    expect(store.closeRequestAsProposed).toHaveBeenCalledWith(
      expect.anything(),
      'b7c2a1d0-1111-4222-8333-944455556666',
      '11111111-2222-4333-8444-555555555555'
    );
    // It is closed as built, not cancelled as the operator's own.
    expect(store.cancelChangeRequest).not.toHaveBeenCalled();
    expect(notify.notifyChangeOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ requester: 'asker', outcome: 'proposed' })
    );
    // And the operators (the others) hear a proposal is waiting.
    expect(notify.notifyOperatorsOfRequest).toHaveBeenCalledWith(
      expect.objectContaining({ freeText: false, requester: 'subject-1' })
    );
  });
});

describe('salesforce_admin_list_change_requests', () => {
  const row = (overrides: Record<string, unknown>) => ({
    id: '11111111-2222-4333-8444-555555555555',
    title: 'Add an Outcome picklist',
    kind: 'request',
    subject: 'asker',
    connectorKey: 'uat',
    status: 'pending',
    expiresAt: new Date(Date.now() + 3_600_000),
    updatedAt: new Date(),
    results: null,
    validation: null,
    payload: { description: 'Site_Visit__c needs Outcome__c.' },
    step: null,
    resolution: null,
    ...overrides,
  });

  it('shows an operator everyone’s, with what each asked for, and an ordinary user only their own', async () => {
    store.listAllChangeRequests.mockResolvedValue([row({})]);
    store.listChangeRequests.mockResolvedValue([]);
    const operator = await call(
      'salesforce_admin_list_change_requests',
      { everyone: true },
      ['renkei-operator']
    );
    expect(text(operator)).toContain('asked by asker');
    expect(text(operator)).toContain('Asked for: Site_Visit__c needs Outcome__c.');
    const ordinary = await call(
      'salesforce_admin_list_change_requests',
      { everyone: true },
      ['renkei-user']
    );
    expect(store.listAllChangeRequests).toHaveBeenCalledTimes(1);
    expect(text(ordinary)).toBe('No change requests.');
  });

  it('says what a queued change is doing right now', async () => {
    store.listChangeRequests.mockResolvedValue([
      row({
        kind: 'fields',
        status: 'applying',
        step: 'Salesforce is deploying — 2 of 5 components (InProgress)',
      }),
    ]);
    const result = await call('salesforce_admin_list_change_requests', {});
    expect(text(result)).toContain('applying');
    expect(text(result)).toContain('Now: Salesforce is deploying — 2 of 5 components (InProgress)');
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
    expect(stored.payload.dataSteps).toEqual([
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
      'Review and approve: https://renkei.example/salesforce-admin/changes/11111111-2222-4333-8444-555555555555'
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

const stored = () => store.createChangeRequest.mock.calls[0][1];

describe('salesforce_admin_get_layout', () => {
  it('lists the layouts with who uses them, and reads one by section', async () => {
    const list = await call('salesforce_admin_get_layout', { object: 'Site_Visit__c' });
    expect(text(list)).toContain('• Site Visit Layout\n  Used by: Standard User');
    const one = await call('salesforce_admin_get_layout', {
      object: 'Site_Visit__c',
      layout: 'site visit layout',
    });
    expect(text(one)).toContain('1. Information — 2 columns');
    expect(text(one)).toContain('Column 2: Stage__c');
    expect(text(one)).toContain('2. System Information — 1 column\n   Column 1: (empty)');
  });
});

describe('salesforce_admin_propose_layout_changes', () => {
  it('deploys the whole live layout with only the change merged in', async () => {
    const result = await call('salesforce_admin_propose_layout_changes', {
      object: 'Site_Visit__c',
      layout: 'Site Visit Layout',
      add: [{ field: 'visit_date__c', section: 'Information' }],
      addSections: [{ label: 'Follow-up', columns: 1 }],
    });
    expect(result.isError).toBeUndefined();
    const { files } = await received();
    const layout = files['layouts/Site_Visit__c-Site Visit Layout.layout'];
    expect(files['package.xml']).toContain('<members>Site_Visit__c-Site Visit Layout</members>');
    // The org's own spelling, in the shorter column, beside what was there.
    expect(layout).toMatch(/<field>Name<\/field>[\s\S]*<field>Stage__c<\/field>/);
    expect(layout).toContain('<field>Visit_Date__c</field>');
    expect(layout).toContain('<label>Follow-up</label>');
    expect(layout).toContain('<showHighlightsPanel>true</showHighlightsPanel>');
    expect(layout).not.toContain('<urls');
    expect(stored()).toMatchObject({ kind: 'layout' });
    expect(stored().payload.preconditions).toEqual([
      expect.objectContaining({ kind: 'layout-unchanged', layout: 'Site Visit Layout' }),
    ]);
  });

  it('refuses a field the object does not have, and a field already placed', async () => {
    const unknown = await call('salesforce_admin_propose_layout_changes', {
      object: 'Site_Visit__c',
      layout: 'Site Visit Layout',
      add: [{ field: 'Nope__c' }],
    });
    expect(text(unknown)).toContain('has no field Nope__c');
    const twice = await call('salesforce_admin_propose_layout_changes', {
      object: 'Site_Visit__c',
      layout: 'Site Visit Layout',
      add: [{ field: 'Stage__c' }],
    });
    expect(text(twice)).toContain('Stage__c is already on this layout.');
    expect(store.createChangeRequest).not.toHaveBeenCalled();
  });

  it('is not offered, nor reachable through a fields proposal, without the layouts capability', async () => {
    const handlers = await tools(['sfa-read', 'sfa-schema']);
    expect(handlers.has('salesforce_admin_propose_layout_changes')).toBe(false);
    const result = await handlers.get('salesforce_admin_propose_fields')?.({
      object: 'Site_Visit__c',
      fields: [{ label: 'Outcome', type: 'Text' }],
      addToLayouts: [{ layout: 'Site Visit Layout' }],
    });
    expect(result && text(result)).toContain('needs “Propose page layout changes”');
    expect(store.createChangeRequest).not.toHaveBeenCalled();
  });
});

describe('salesforce_admin_propose_field_changes', () => {
  it('deploys the whole field with the change, and keeps what it was', async () => {
    const result = await call('salesforce_admin_propose_field_changes', {
      object: 'Site_Visit__c',
      field: 'Visit_Date__c',
      label: 'Planned Visit Date',
      helpText: 'When the visit is booked for',
    });
    expect(result.isError).toBeUndefined();
    const { files } = await received();
    const object = files['objects/Site_Visit__c.object'];
    expect(object).toContain('<fullName>Visit_Date__c</fullName>');
    expect(object).toContain('<label>Planned Visit Date</label>');
    expect(object).toContain('<type>Date</type>');
    expect(object).toContain('<inlineHelpText>When the visit is booked for</inlineHelpText>');
    expect(stored().payload.components[0].rows).toContainEqual({
      label: 'Label',
      value: 'Planned Visit Date',
      from: 'Visit Date',
    });
    expect(stored().payload.preconditions[0]).toMatchObject({
      kind: 'field-unchanged',
      field: 'Visit_Date__c',
    });
    expect(text(result)).toContain('• Label: Visit Date → Planned Visit Date');
  });

  it('refuses a type change, and standard fields', async () => {
    const type = await call('salesforce_admin_propose_field_changes', {
      object: 'Site_Visit__c',
      field: 'Visit_Date__c',
      type: 'DateTime',
    });
    expect(text(type)).toContain('Changing a field’s type');
    const standard = await call('salesforce_admin_propose_field_changes', {
      object: 'Site_Visit__c',
      field: 'Name',
      label: 'Visit',
    });
    expect(text(standard)).toContain('is a standard field');
    expect(deploys()).toHaveLength(0);
  });
});

describe('salesforce_admin_propose_picklist_changes', () => {
  it('adds and deactivates values without deleting any', async () => {
    const result = await call('salesforce_admin_propose_picklist_changes', {
      object: 'Site_Visit__c',
      field: 'Stage__c',
      add: [{ value: 'Cancelled' }],
      deactivate: ['Draft'],
      defaultValue: '',
    });
    expect(result.isError).toBeUndefined();
    const object = (await received()).files['objects/Site_Visit__c.object'];
    expect(object).toMatch(/<fullName>Draft<\/fullName>[\s\S]*<isActive>false<\/isActive>/);
    expect(object).toContain('<fullName>Done</fullName>');
    expect(object).toContain('<fullName>Cancelled</fullName>');
    expect(object).not.toContain('<default>true</default>');
    expect(stored()).toMatchObject({ kind: 'picklist_changes' });
    // Added values are offered on the record types that list the picklist.
    expect(object).toContain('<recordTypes>');
    expect(object).toMatch(
      /<fullName>Home_Visit<\/fullName>[\s\S]*<fullName>Cancelled<\/fullName>/
    );
    expect(text(result)).toContain('On the record type Home Visit:\n• Offer: Cancelled');
  });
});

describe('salesforce_admin_propose_object', () => {
  it('builds the object, its tab and fields, then gives the named sets access', async () => {
    const result = await call('salesforce_admin_propose_object', {
      label: 'Home Visit',
      nameField: { type: 'AutoNumber', displayFormat: 'HV-{0000}' },
      sharingModel: 'Private',
      fields: [{ label: 'Outcome', type: 'Text' }],
      grantTo: [{ permissionSet: 'Program Staff', edit: true }],
    });
    expect(result.isError).toBeUndefined();
    const { files } = await received();
    expect(Object.keys(files).sort()).toEqual([
      'objects/Home_Visit__c.object',
      'package.xml',
      'tabs/Home_Visit__c.tab',
    ]);
    expect(files['objects/Home_Visit__c.object']).toContain('<sharingModel>Private</sharingModel>');
    expect(files['objects/Home_Visit__c.object']).toContain(
      '<displayFormat>HV-{0000}</displayFormat>'
    );
    expect(stored().payload.preconditions).toEqual([
      { kind: 'object-absent', object: 'Home_Visit__c' },
    ]);
    // Records and the tab before the fields: field access needs the object's.
    expect(stored().payload.dataSteps.map((s: { kind: string }) => s.kind)).toEqual([
      'object-permission',
      'tab-visibility',
      'field-permission',
    ]);
    expect(stored().payload.dataSteps[0]).toMatchObject({
      read: true,
      create: true,
      edit: true,
      delete: true,
      viewAll: false,
    });
  });

  it('refuses an object that exists, even one the person cannot see', async () => {
    const result = await call('salesforce_admin_propose_object', { label: 'Site Visit' });
    expect(text(result)).toContain('There is already an object Site_Visit__c.');
    expect(store.createChangeRequest).not.toHaveBeenCalled();
  });
});

describe('salesforce_admin_propose_permission_set', () => {
  it('adds access to an existing set as data, never taking any away', async () => {
    objectRows = [
      { SobjectType: 'Site_Visit__c', PermissionsRead: true, PermissionsDelete: false },
    ];
    const result = await call('salesforce_admin_propose_permission_set', {
      permissionSet: 'Program Staff',
      objects: [{ object: 'Site_Visit__c', edit: true }],
      fields: [{ object: 'Site_Visit__c', field: 'stage__c' }],
      tabs: ['Site_Visit__c'],
    });
    expect(result.isError).toBeUndefined();
    expect(deploys()).toHaveLength(0);
    expect(stored()).toMatchObject({ kind: 'permission_set' });
    expect(stored().payload.files).toEqual({});
    expect(stored().payload.dataSteps).toEqual([
      expect.objectContaining({ kind: 'object-permission', read: true, edit: true, delete: false }),
      expect.objectContaining({
        kind: 'tab-visibility',
        tab: 'Site_Visit__c',
        visibility: 'DefaultOn',
      }),
      expect.objectContaining({ kind: 'field-permission', field: 'Stage__c', edit: false }),
    ]);
    expect(text(result)).toContain('Site_Visit__c records: read → read, edit');
    expect(text(result)).toContain('Nothing to deploy');
  });

  it('shows a tab alone, without reading access it does not touch', async () => {
    const result = await call('salesforce_admin_propose_permission_set', {
      permissionSet: 'Program Staff',
      tabs: ['Site_Visit__c'],
    });
    expect(result.isError).toBeUndefined();
    expect(stored().payload.dataSteps).toEqual([
      expect.objectContaining({ kind: 'tab-visibility', tab: 'Site_Visit__c' }),
    ]);
    expect(requests.some((r) => /ObjectPermissions/.test(decodeURIComponent(r.query)))).toBe(false);
  });

  it('refuses field access on a required field', async () => {
    const result = await call('salesforce_admin_propose_permission_set', {
      permissionSet: 'Program Staff',
      fields: [{ object: 'Site_Visit__c', field: 'Name' }],
    });
    expect(text(result)).toContain('takes no field access');
  });

  it('deploys a new set with its access inside it', async () => {
    const result = await call('salesforce_admin_propose_permission_set', {
      newSet: { label: 'Site Visit Editors' },
      objects: [{ object: 'Site_Visit__c', edit: true }],
    });
    expect(result.isError).toBeUndefined();
    const { files } = await received();
    const set = files['permissionsets/Site_Visit_Editors.permissionset'];
    expect(set).toContain('<label>Site Visit Editors</label>');
    expect(set).toContain('<object>Site_Visit__c</object>');
    expect(stored().payload.preconditions).toEqual([
      { kind: 'permission-set-absent', name: 'Site_Visit_Editors' },
    ]);
  });
});

describe('salesforce_admin_propose_assignments', () => {
  it('is off unless the connection allows user access', async () => {
    const defaults = await tools(['sfa-read', 'sfa-schema', 'sfa-layouts', 'sfa-permissions']);
    expect(defaults.has('salesforce_admin_propose_assignments')).toBe(false);
    expect(defaults.has('salesforce_admin_propose_permission_set')).toBe(true);
  });

  it('proposes only what would change, and names the rest', async () => {
    assigned = ['005000000000003AAA'];
    const result = await call('salesforce_admin_propose_assignments', {
      assign: [{ permissionSet: 'Program Staff', users: ['grace@acme.org', 'Alan Turing'] }],
    });
    expect(result.isError).toBeUndefined();
    expect(stored()).toMatchObject({ kind: 'assignments' });
    expect(stored().payload.dataSteps).toEqual([
      {
        kind: 'assign',
        permissionSetId: '0PS000000000001AAA',
        permissionSetName: 'Program_Staff',
        userId: '005000000000002AAA',
        userName: 'Grace Hopper (grace@acme.org)',
      },
    ]);
    expect(text(result)).toContain('Alan Turing (alan@acme.org) already has Program_Staff.');
  });
});

describe('picklists beyond a field’s own values', () => {
  it('changes a global value set, saying which fields change with it', async () => {
    const result = await call('salesforce_admin_propose_picklist_changes', {
      object: 'Site_Visit__c',
      field: 'Region__c',
      add: [{ value: 'East' }],
      addToRecordTypes: false,
    });
    expect(result.isError).toBeUndefined();
    const { files } = await received();
    expect(Object.keys(files).sort()).toEqual([
      'globalValueSets/Regions.globalValueSet',
      'package.xml',
    ]);
    const set = files['globalValueSets/Regions.globalValueSet'];
    expect(set).toContain('<GlobalValueSet xmlns=');
    expect(set).toMatch(/<fullName>North<\/fullName>[\s\S]*<fullName>East<\/fullName>/);
    expect(set).not.toContain('<urls');
    expect(stored().payload.preconditions).toEqual([
      expect.objectContaining({
        kind: 'component-unchanged',
        type: 'GlobalValueSet',
        name: 'Regions',
      }),
    ]);
    expect(text(result)).toContain('used by Site_Visit__c.Region__c, Account.Region__c');
  });

  it('adds to a standard picklist through its value set, shared fields named', async () => {
    const result = await call('salesforce_admin_propose_picklist_changes', {
      object: 'Lead',
      field: 'LeadSource',
      add: [{ value: 'Webinar' }],
    });
    expect(result.isError).toBeUndefined();
    const set = (await received()).files['standardValueSets/LeadSource.standardValueSet'];
    expect(set).toContain('<StandardValueSet xmlns=');
    // Every value read goes back, with the new one.
    expect(set).toMatch(
      /<fullName>Web<\/fullName>[\s\S]*Referral[\s\S]*<fullName>Webinar<\/fullName>/
    );
    expect(text(result)).toContain('Contact.LeadSource, Opportunity.LeadSource also use');
    expect(stored().payload.preconditions[0]).toMatchObject({
      type: 'StandardValueSet',
      object: 'Lead',
      name: 'LeadSource',
    });
  });

  it('needs a new stage’s probability, then offers it through the sales process', async () => {
    const missing = await call('salesforce_admin_propose_picklist_changes', {
      object: 'Opportunity',
      field: 'StageName',
      add: [{ value: 'Pledged' }],
    });
    expect(text(missing)).toContain('a new stage needs its probability');
    const result = await call('salesforce_admin_propose_picklist_changes', {
      object: 'Opportunity',
      field: 'StageName',
      add: [{ value: 'Pledged', probability: 75, forecastCategory: 'Forecast' }],
    });
    expect(result.isError).toBeUndefined();
    const { files } = await received();
    const stages = files['standardValueSets/OpportunityStage.standardValueSet'];
    expect(stages).toContain('<probability>75</probability>');
    // The inactive stage the describe cannot see stays, inactive, with its flags.
    expect(stages).toMatch(/<fullName>Old Stage<\/fullName>[\s\S]*<isActive>false<\/isActive>/);
    expect(stages).toContain('<forecastCategory>BestCase</forecastCategory>');
    const object = files['objects/Opportunity.object'];
    expect(object).toContain('<businessProcesses>');
    expect(object).toMatch(/<fullName>Grants<\/fullName>[\s\S]*<fullName>Pledged<\/fullName>/);
    expect(text(result)).toContain('On the sales process Grants (Grant):\n• Offer: Pledged');
  });

  it('changes what one record type offers, and nothing else', async () => {
    const result = await call('salesforce_admin_propose_picklist_changes', {
      object: 'Site_Visit__c',
      field: 'Stage__c',
      recordTypes: [{ recordType: 'Home Visit', remove: ['Done'] }],
    });
    expect(result.isError).toBeUndefined();
    expect(stored().payload.members).toEqual([
      { type: 'RecordType', member: 'Site_Visit__c.Home_Visit' },
    ]);
    const object = (await received()).files['objects/Site_Visit__c.object'];
    expect(object).not.toContain('<fields>');
    expect(object).not.toContain('<fullName>Done</fullName>');
    expect(text(result)).toContain('On the record type Home Visit:\n• Stop offering: Done');
  });

  it('reads a picklist’s values and what each record type offers', async () => {
    const result = await call('salesforce_admin_get_picklist', {
      object: 'Site_Visit__c',
      field: 'Stage__c',
    });
    expect(text(result)).toContain('Site_Visit__c.Stage__c has its own values.');
    expect(text(result)).toContain('• Draft (default)');
    expect(text(result)).toContain('• Home Visit (Home_Visit): Draft (default), Done');
  });
});

describe('salesforce_admin_propose_record_type', () => {
  it('builds a new record type offering every value, and the profile overlay', async () => {
    const result = await call('salesforce_admin_propose_record_type', {
      object: 'Site_Visit__c',
      label: 'Phone Check-in',
      picklists: [{ field: 'Stage__c', values: ['Draft'], default: 'Draft' }],
      profiles: [{ profile: 'Standard User', layout: 'Site Visit Layout' }],
    });
    expect(result.isError).toBeUndefined();
    const { files } = await received();
    const object = files['objects/Site_Visit__c.object'];
    expect(object).toContain('<fullName>Phone_Check_in</fullName>');
    // Named: only Draft. Not named: every active value.
    expect(object).toMatch(
      /<picklist>Stage__c<\/picklist>\s*<values>\s*<fullName>Draft<\/fullName>/
    );
    expect(object).toMatch(
      /<picklist>Region__c<\/picklist>\s*<values>\s*<fullName>North<\/fullName>/
    );
    const profile = files['profiles/Standard.profile'];
    expect(profile).toContain('<recordType>Site_Visit__c.Phone_Check_in</recordType>');
    expect(profile).toContain('<layout>Site_Visit__c-Site Visit Layout</layout>');
    expect(stored()).toMatchObject({ kind: 'record_type' });
    expect(stored().payload.preconditions).toEqual([
      { kind: 'record-type-absent', object: 'Site_Visit__c', name: 'Phone_Check_in' },
    ]);
    expect(stored().payload.members).toContainEqual({ type: 'Profile', member: 'Standard' });
  });

  it('needs a sales process on Opportunity, and keeps Stage to the process', async () => {
    const noProcess = await call('salesforce_admin_propose_record_type', {
      object: 'Opportunity',
      label: 'Donation',
    });
    expect(text(noProcess)).toContain('needs its sales process');
    const stage = await call('salesforce_admin_propose_record_type', {
      object: 'Opportunity',
      label: 'Donation',
      businessProcess: 'Grants',
      picklists: [{ field: 'StageName', values: ['Prospecting'] }],
    });
    expect(text(stage)).toContain('offered through the sales process');
    expect(store.createChangeRequest).not.toHaveBeenCalled();
  });

  it('changes an existing one whole, keeping what it was', async () => {
    const result = await call('salesforce_admin_propose_record_type', {
      object: 'Site_Visit__c',
      recordType: 'Home_Visit',
      label: 'In-home Visit',
      active: false,
    });
    expect(result.isError).toBeUndefined();
    expect(stored().payload.components[0].rows).toEqual([
      { label: 'Label', value: 'In-home Visit', from: 'Home Visit' },
      { label: 'Active', value: 'no', from: 'yes' },
    ]);
    const object = (await received()).files['objects/Site_Visit__c.object'];
    expect(object).toContain('<label>In-home Visit</label>');
    // What it offers is untouched.
    expect(object).toContain('<fullName>Done</fullName>');
    expect(stored().payload.preconditions[0]).toMatchObject({
      kind: 'component-unchanged',
      type: 'RecordType',
      name: 'Home_Visit',
    });
  });

  it('gives record types only to a new permission set', async () => {
    const existing = await call('salesforce_admin_propose_permission_set', {
      permissionSet: 'Program Staff',
      recordTypes: ['Site_Visit__c.Home Visit'],
    });
    expect(text(existing)).toContain('in a new permission set only');
    const created = await call('salesforce_admin_propose_permission_set', {
      newSet: { label: 'Site Visit Home Visits' },
      recordTypes: ['Site_Visit__c.Home Visit'],
    });
    expect(created.isError).toBeUndefined();
    const set = (await received()).files['permissionsets/Site_Visit_Home_Visits.permissionset'];
    expect(set).toContain('<recordType>Site_Visit__c.Home_Visit</recordType>');
  });
});
