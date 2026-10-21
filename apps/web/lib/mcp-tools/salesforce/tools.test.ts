/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The salesforce_ tools against a fake org with a custom object of its own:
 * which tools a connection's capabilities register (and that none register
 * without them), that writes are checked against the describe before
 * anything is sent, resolve names to ids, update conditionally, and report
 * what the org's automation changed; that a validation rule's field comes
 * back to ask the person about; that bulk work and deletes are cards whose
 * confirm acts on resolved ids, all or none; that report runs carry their
 * scope and per-run changes; that reads stop at the org's API budget; that
 * what a connector keeps away from the model (hidden objects and fields,
 * the Restricted switch) never comes back from any of them; and that files
 * move between the org and the scratch space without passing the model.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
jest.mock('@renkei/provider-grants', () => ({
  SALESFORCE: 'salesforce',
  readSalesforceMetadata: (metadata: Record<string, unknown>) => metadata,
}));
jest.mock('@/lib/sandbox/service-client', () => ({
  sandboxConfig: () => ({ url: 'http://sandbox.test', key: 'k' }),
  sbWriteFile: jest.fn(),
  sbReadFile: jest.fn(),
  clientFailure: () => ({ message: 'sandbox failure' }),
}));
jest.mock('../widgets', () => ({
  APP_ONLY_META: { ui: { visibility: ['app'] } },
  DIRECTORY_ACTION_PREVIEW_URI: 'ui://widget/directory-action-preview.test.html',
  confirmGuard: (tool: string) => ` Only the card invokes this; call ${tool} instead.`,
  newPreviewId: () => 'preview-1',
  previewToolMeta: (uri: string) => ({ ui: { resourceUri: uri, kind: 'approval' } }),
}));

import type { McpServer } from '@modelcontextprotocol/server';
import { authedFetch } from '@renkei/delegate-client';
import type { MCPToolContext } from '../common';
import { registerSalesforceTools } from './index';
import type { SalesforceAuth } from './salesforce-auth';
import { salesforceScopeFor } from './scopes';
import { resetApiUsage } from './client';
import { invalidateDescribe } from './schema';
import { ALL_SALESFORCE_SCOPES } from '@/lib/salesforce-scopes';
import { EMPTY_POLICY, type DataPolicy } from '@renkei/connector-salesforce';
import { resetClassifications } from './policy';

const sandbox = jest.requireMock<{ sbWriteFile: jest.Mock; sbReadFile: jest.Mock }>(
  '@/lib/sandbox/service-client'
);

type ToolResult = {
  content: { type: string; text?: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const ORIGIN = 'https://acme.my.salesforce.com';
const V = '/services/data/v68.0';
const ACCOUNT = '001000000000001AAA';
const VISIT = 'a01000000000001AAA';
const VISIT_2 = 'a01000000000002AAA';
const USER = '005000000000001AAA';

/** The connector's data policy for the test at hand. */
let policy: DataPolicy;

const stubAuth: SalesforceAuth = {
  kind: 'oauth',
  resolve: async () => ({
    auth: authedFetch((url, init) => fetch(url, init), 'salesforce:00D/005'),
    accountId: `00D000000000062EAA/${USER}`,
    orgId: '00D000000000062EAA',
    userId: USER,
    instanceUrl: ORIGIN,
    username: 'ada@acme.org',
    connector: 'production',
    connectorName: 'Production',
    sandbox: false,
    policy,
  }),
};

/** The org's schema: Account, and a custom object of the org's own. */
const describes: Record<string, unknown> = {
  Account: {
    name: 'Account',
    label: 'Account',
    labelPlural: 'Accounts',
    fields: [
      { name: 'Id', label: 'Account ID', type: 'id', createable: false, updateable: false },
      {
        name: 'Name',
        label: 'Account Name',
        type: 'string',
        nameField: true,
        createable: true,
        updateable: true,
        nillable: false,
        filterable: true,
      },
    ],
    childRelationships: [
      {
        childSObject: 'Site_Visit__c',
        field: 'Account__c',
        relationshipName: 'Site_Visits__r',
        cascadeDelete: true,
      },
    ],
    recordTypeInfos: [],
  },
  Site_Visit__c: {
    name: 'Site_Visit__c',
    label: 'Site Visit',
    labelPlural: 'Site Visits',
    custom: true,
    fields: [
      { name: 'Id', label: 'Record ID', type: 'id', createable: false, updateable: false },
      {
        name: 'Name',
        label: 'Visit Number',
        type: 'string',
        autoNumber: true,
        nameField: true,
        createable: false,
        updateable: false,
        filterable: true,
      },
      {
        name: 'Account__c',
        label: 'Account',
        type: 'reference',
        referenceTo: ['Account'],
        relationshipName: 'Account__r',
        createable: true,
        updateable: true,
        nillable: false,
        custom: true,
      },
      {
        name: 'Stage__c',
        label: 'Stage',
        type: 'picklist',
        restrictedPicklist: true,
        createable: true,
        updateable: true,
        nillable: true,
        custom: true,
        picklistValues: [
          { value: 'Scheduled', label: 'Scheduled', active: true },
          { value: 'Completed', label: 'Completed', active: true },
        ],
      },
      {
        name: 'Visit_Date__c',
        label: 'Visit Date',
        type: 'date',
        createable: true,
        updateable: true,
        nillable: true,
        custom: true,
      },
      {
        name: 'Stage_Changed__c',
        label: 'Stage Changed',
        type: 'datetime',
        createable: true,
        updateable: true,
        nillable: true,
        custom: true,
      },
      {
        name: 'OwnerId',
        label: 'Owner',
        type: 'reference',
        referenceTo: ['User', 'Group'],
        createable: true,
        updateable: true,
        nillable: false,
        defaultedOnCreate: true,
      },
    ],
    childRelationships: [],
    recordTypeInfos: [],
  },
};

let requests: {
  method: string;
  path: string;
  query: string;
  body: unknown;
  headers: Record<string, string>;
}[];
/** Per-test overrides: return a Response to answer, or undefined to fall through. */
let override: ((method: string, path: string, query: string) => Response | undefined) | null;
let limitInfo: string;

function answer(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'sforce-limit-info': limitInfo },
  });
}

/** A visit record as Salesforce holds it, stage and the org's stamp moving together. */
let visit: Record<string, unknown>;

function fakeOrg(method: string, path: string, query: string, body: unknown): Response {
  const own = override?.(method, path, query);
  if (own) return own;
  if (method === 'GET' && path === `${V}/sobjects`) {
    return answer(200, {
      sobjects: [
        {
          name: 'Account',
          label: 'Account',
          labelPlural: 'Accounts',
          keyPrefix: '001',
          queryable: true,
        },
        {
          name: 'Site_Visit__c',
          label: 'Site Visit',
          labelPlural: 'Site Visits',
          keyPrefix: 'a01',
          custom: true,
          queryable: true,
        },
        {
          name: 'Case_Note__c',
          label: 'Case Note',
          labelPlural: 'Case Notes',
          keyPrefix: 'a02',
          custom: true,
          queryable: true,
        },
        {
          name: 'Site_Visit__History',
          label: 'Site Visit History',
          keyPrefix: null,
          custom: true,
          queryable: true,
        },
      ],
    });
  }
  const describe = /^\/services\/data\/v68\.0\/sobjects\/(\w+)\/describe$/.exec(path);
  if (method === 'GET' && describe) {
    return describes[describe[1]]
      ? answer(200, describes[describe[1]])
      : answer(404, [{ errorCode: 'NOT_FOUND', message: 'nope' }]);
  }
  if (method === 'GET' && path.endsWith('/describe/compactLayouts/primary'))
    return answer(200, { fieldItems: [] });
  if (method === 'GET' && path === `${V}/query`) {
    const q = new URLSearchParams(query).get('q') ?? '';
    if (/FROM Account WHERE Name = 'Acme'/.test(q))
      return answer(200, { totalSize: 1, done: true, records: [{ Id: ACCOUNT, Name: 'Acme' }] });
    if (/FROM Site_Visit__c WHERE Name = 'SV-0001'/.test(q))
      return answer(200, { totalSize: 1, done: true, records: [{ Id: VISIT, Name: 'SV-0001' }] });
    if (/FROM Site_Visit__c WHERE Name = 'SV-0002'/.test(q))
      return answer(200, { totalSize: 1, done: true, records: [{ Id: VISIT_2, Name: 'SV-0002' }] });
    if (/FROM Site_Visit__c WHERE Id IN/.test(q)) {
      return answer(200, {
        totalSize: 2,
        done: true,
        records: [
          {
            Id: VISIT,
            Name: 'SV-0001',
            Stage__c: 'Scheduled',
            LastModifiedDate: '2026-10-20T10:00:00.000+0000',
          },
          {
            Id: VISIT_2,
            Name: 'SV-0002',
            Stage__c: 'Scheduled',
            LastModifiedDate: '2026-10-20T10:00:00.000+0000',
          },
        ],
      });
    }
    if (/SELECT COUNT\(\) FROM Site_Visit__c WHERE Account__c IN/.test(q))
      return answer(200, { totalSize: 3, done: true, records: [] });
    if (/FROM Account WHERE Id = /.test(q))
      return answer(200, { totalSize: 1, done: true, records: [{ Id: ACCOUNT, Name: 'Acme' }] });
    if (/FROM Site_Visit__c WHERE Id = /.test(q))
      return answer(200, { totalSize: 1, done: true, records: [{ Id: VISIT, Name: 'SV-0001' }] });
    return answer(200, { totalSize: 0, done: true, records: [] });
  }
  if (method === 'GET' && path === `${V}/sobjects/Site_Visit__c/${VISIT}`)
    return answer(200, { attributes: {}, ...visit });
  if (method === 'PATCH' && path === `${V}/sobjects/Site_Visit__c/${VISIT}`) {
    // The org's own before-save automation stamps the stage change.
    visit = {
      ...visit,
      ...(body as Record<string, unknown>),
      Stage_Changed__c: '2026-10-21T14:02:00.000+0000',
      LastModifiedDate: '2026-10-21T14:02:00.000+0000',
    };
    return answer(204, null);
  }
  if (method === 'POST' && path === `${V}/sobjects/Site_Visit__c`)
    return answer(201, { id: 'a01000000000009AAA', success: true });
  if (method === 'GET' && path === `${V}/sobjects/Site_Visit__c/a01000000000009AAA`) {
    return answer(200, {
      Id: 'a01000000000009AAA',
      Name: 'SV-0009',
      Account__c: ACCOUNT,
      Stage__c: 'Scheduled',
      OwnerId: USER,
    });
  }
  if ((method === 'PATCH' || method === 'DELETE') && path === `${V}/composite/sobjects`) {
    return answer(200, [
      { id: VISIT, success: true, errors: [] },
      { id: VISIT_2, success: true, errors: [] },
    ]);
  }
  return answer(404, [{ errorCode: 'NOT_FOUND', message: `no stub for ${method} ${path}` }]);
}

const fetchSpy = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  );
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  const body = typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : undefined;
  requests.push({
    method: init?.method ?? 'GET',
    path: url.pathname,
    query: url.search.slice(1),
    body,
    headers,
  });
  expect(url.origin).toBe(ORIGIN);
  return fakeOrg(init?.method ?? 'GET', url.pathname, url.search.slice(1), body);
});

async function tools(
  scopes: string[] | null = ALL_SALESFORCE_SCOPES
): Promise<Map<string, ToolHandler>> {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registerSalesforceTools(
    server,
    { subject: 'subject-1', salesforceScopes: scopes ?? undefined } as MCPToolContext,
    stubAuth
  );
  return handlers;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const handler = (await tools()).get(name);
  if (!handler) throw new Error(`${name} is not registered`);
  return handler(args);
}

const text = (result: ToolResult) => result.content[0]?.text ?? '';
const sent = (method: string, path: string) =>
  requests.filter((r) => r.method === method && r.path === `${V}${path}`);

beforeEach(() => {
  requests = [];
  override = null;
  limitInfo = 'api-usage=10/15000';
  visit = {
    Id: VISIT,
    Name: 'SV-0001',
    Account__c: ACCOUNT,
    Stage__c: 'Scheduled',
    Stage_Changed__c: null,
    RecordTypeId: null,
    LastModifiedDate: '2026-10-20T10:00:00.000+0000',
  };
  policy = EMPTY_POLICY;
  resetApiUsage();
  resetClassifications();
  invalidateDescribe();
  sandbox.sbWriteFile.mockReset();
  sandbox.sbReadFile.mockReset();
  global.fetch = fetchSpy as unknown as typeof fetch;
});

describe('registration', () => {
  it('registers by capability, and nothing without any', async () => {
    const all = await tools();
    expect([...all.keys()].every((name) => salesforceScopeFor(name)[0] !== '__unmapped__')).toBe(
      true
    );
    expect(all.has('salesforce_delete_records_preview')).toBe(true);

    const readOnly = await tools(['sf-records-read', 'sf-reports']);
    expect(readOnly.has('salesforce_get_record')).toBe(true);
    expect(readOnly.has('salesforce_run_report')).toBe(true);
    expect(readOnly.has('salesforce_update_record')).toBe(false);
    expect(readOnly.has('salesforce_delete_records_preview')).toBe(false);

    // No recorded capabilities is no tools — never everything — beyond the
    // list of orgs, which needs none.
    expect([...(await tools(null)).keys()]).toEqual(['salesforce_list_orgs']);
  });
});

describe('single-record writes', () => {
  it('updates a custom record named by its auto-number, conditionally, and reports the org automation', async () => {
    const result = await call('salesforce_update_record', {
      object: 'Site Visit',
      record: 'SV-0001',
      fields: { Stage: 'completed' },
    });
    expect(result.isError).toBeUndefined();
    const patch = sent('PATCH', `/sobjects/Site_Visit__c/${VISIT}`)[0];
    expect(patch.body).toEqual({ Stage__c: 'Completed' });
    expect(patch.headers['if-unmodified-since']).toBe(
      new Date('2026-10-20T10:00:00.000Z').toUTCString()
    );
    expect(text(result)).toContain('Stage (Stage__c): Scheduled → Completed');
    expect(text(result)).toContain('Also set by the org’s automation:');
    expect(text(result)).toContain(
      'Stage Changed (Stage_Changed__c): (blank) → 2026-10-21T14:02:00.000+0000'
    );
  });

  it('refuses a bad picklist value before sending anything', async () => {
    const result = await call('salesforce_update_record', {
      object: 'Site_Visit__c',
      record: VISIT,
      fields: { Stage__c: 'Retired' },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Valid values: Scheduled, Completed');
    expect(sent('PATCH', `/sobjects/Site_Visit__c/${VISIT}`)).toHaveLength(0);
  });

  it('resolves a lookup given by name on create', async () => {
    const result = await call('salesforce_create_record', {
      object: 'Site_Visit__c',
      fields: { Account: 'Acme', Stage__c: 'Scheduled', 'Visit Date': '2026-11-02' },
    });
    expect(result.isError).toBeUndefined();
    expect(sent('POST', '/sobjects/Site_Visit__c')[0].body).toEqual({
      Account__c: ACCOUNT,
      Stage__c: 'Scheduled',
      Visit_Date__c: '2026-11-02',
    });
    expect(text(result)).toContain(`${ORIGIN}/a01000000000009AAA`);
  });

  it('hands back a validation rule’s field to ask the person about', async () => {
    override = (method, path) =>
      method === 'PATCH' && path.endsWith(VISIT)
        ? answer(400, [
            {
              errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
              message: 'Enter the visit date before completing the visit.',
              fields: ['Visit_Date__c'],
            },
          ])
        : undefined;
    const result = await call('salesforce_update_record', {
      object: 'Site_Visit__c',
      record: VISIT,
      fields: { Stage__c: 'Completed' },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(
      'FIELD_CUSTOM_VALIDATION_EXCEPTION: Enter the visit date before completing the visit. (field: Visit_Date__c)'
    );
    expect(text(result)).toContain('Ask the person for Visit_Date__c rather than guessing a value');
  });
});

describe('reads', () => {
  it('bounds a query and refuses anything but one SELECT', async () => {
    await call('salesforce_query', { soql: 'SELECT Id FROM Site_Visit__c' });
    expect(new URLSearchParams(sent('GET', '/query')[0].query).get('q')).toBe(
      'SELECT Id FROM Site_Visit__c LIMIT 200'
    );
    const refused = await call('salesforce_query', { soql: 'DELETE FROM Site_Visit__c' });
    expect(refused.isError).toBe(true);
  });

  it('finds how two objects connect', async () => {
    const result = await call('salesforce_find_relationship_path', {
      from: 'Account',
      to: 'Site Visits',
    });
    expect(text(result)).toContain('subquery FROM Site_Visits__r');
  });

  it("pauses reads once the org's API budget is mostly spent, but not writes", async () => {
    limitInfo = 'api-usage=13000/15000';
    await call('salesforce_query', { soql: 'SELECT Id FROM Account' });
    const paused = await call('salesforce_query', { soql: 'SELECT Id FROM Account' });
    expect(paused.isError).toBe(true);
    expect(text(paused)).toContain('13,000 of its 15,000');
    // A write still goes through — the reads it makes included.
    const write = await call('salesforce_update_record', {
      object: 'Site_Visit__c',
      record: VISIT,
      fields: { Stage__c: 'Completed' },
    });
    expect(write.isError).toBeUndefined();
    expect(sent('PATCH', `/sobjects/Site_Visit__c/${VISIT}`)).toHaveLength(1);
  });
});

describe('cards first', () => {
  it('previews a delete with what goes with it, and confirms on ids, all or none', async () => {
    const preview = await call('salesforce_delete_records_preview', {
      object: 'Account',
      records: ['Acme'],
    });
    const card = preview.structuredContent ?? {};
    expect(card.confirmTool).toBe('salesforce_delete_records_confirm');
    // The confirm acts in the org the preview resolved, on its ids.
    expect(card.confirmArgs).toEqual({ org: 'production', object: 'Account', ids: [ACCOUNT] });
    expect(JSON.stringify(card.groupLists)).toContain('3 Site Visits');
    expect(requests.some((r) => r.method === 'DELETE')).toBe(false);

    const confirmed = await call(
      'salesforce_delete_records_confirm',
      card.confirmArgs as Record<string, unknown>
    );
    expect(confirmed.isError).toBeUndefined();
    const del = requests.find((r) => r.method === 'DELETE');
    expect(del?.path).toBe(`${V}/composite/sobjects`);
    expect(new URLSearchParams(del?.query).get('allOrNone')).toBe('true');
    expect(new URLSearchParams(del?.query).get('ids')).toBe(ACCOUNT);
  });

  it('previews a bulk update with old and new values and applies it in one request', async () => {
    const preview = await call('salesforce_update_records_preview', {
      object: 'Site Visit',
      updates: [
        { record: 'SV-0001', fields: { Stage__c: 'Completed' } },
        { record: 'SV-0002', fields: { Stage__c: 'Completed' } },
      ],
    });
    const card = preview.structuredContent ?? {};
    expect(card.fields).toEqual([
      { label: 'SV-0001 · Stage', value: 'Completed', oldValue: 'Scheduled' },
      { label: 'SV-0002 · Stage', value: 'Completed', oldValue: 'Scheduled' },
    ]);
    await call('salesforce_update_records_confirm', card.confirmArgs as Record<string, unknown>);
    expect(sent('PATCH', '/composite/sobjects')[0].body).toEqual({
      allOrNone: true,
      records: [
        { attributes: { type: 'Site_Visit__c' }, Id: VISIT, Stage__c: 'Completed' },
        { attributes: { type: 'Site_Visit__c' }, Id: VISIT_2, Stage__c: 'Completed' },
      ],
    });
  });
});

describe('reports', () => {
  it('runs a report with a filter for this run only and states its scope', async () => {
    const REPORT = '00O000000000001AAA';
    override = (method, path) => {
      if (method === 'GET' && path === `${V}/analytics/reports/${REPORT}/describe`) {
        return answer(200, {
          reportMetadata: {
            name: 'Visits by stage',
            reportFormat: 'SUMMARY',
            reportFilters: [],
            standardDateFilter: { column: 'CREATED_DATE', durationValue: 'THIS_QUARTER' },
          },
        });
      }
      if (method === 'POST' && path === `${V}/analytics/reports/${REPORT}`) {
        return answer(200, {
          attributes: { reportId: REPORT, reportName: 'Visits by stage' },
          allData: true,
          reportMetadata: {
            reportFormat: 'SUMMARY',
            aggregates: ['RowCount'],
            reportFilters: [
              { column: 'Site_Visit__c.Region__c', operator: 'equals', value: 'West' },
            ],
            standardDateFilter: { column: 'CREATED_DATE', durationValue: 'LAST_QUARTER' },
          },
          reportExtendedMetadata: { aggregateColumnInfo: { RowCount: { label: 'Record Count' } } },
          groupingsDown: { groupings: [{ key: '0', label: 'Completed', groupings: [] }] },
          factMap: {
            '0!T': { aggregates: [{ label: '12' }] },
            'T!T': { aggregates: [{ label: '12' }] },
          },
        });
      }
      return undefined;
    };
    const result = await call('salesforce_run_report', {
      report: REPORT,
      addFilters: [{ column: 'Site_Visit__c.Region__c', operator: 'equals', value: 'West' }],
      dateRange: { duration: 'LAST_QUARTER' },
    });
    const post = sent('POST', `/analytics/reports/${REPORT}`)[0];
    expect(post.body).toMatchObject({
      reportMetadata: {
        reportFilters: [{ column: 'Site_Visit__c.Region__c', operator: 'equals', value: 'West' }],
        standardDateFilter: { column: 'CREATED_DATE', durationValue: 'LAST_QUARTER' },
      },
    });
    expect(text(result)).toContain('Filters: Site_Visit__c.Region__c equals West');
    expect(text(result)).toContain('Date range: CREATED_DATE: last quarter');
    expect(text(result)).toContain('For this run only:');
    expect(text(result)).toContain('Completed: Record Count 12');
  });
});

describe('what the connector keeps away from the model', () => {
  const queries = () =>
    sent('GET', '/query').map((r) => new URLSearchParams(r.query).get('q') ?? '');

  it('hides an object from listings, describes, record lookups and queries', async () => {
    policy = { ...EMPTY_POLICY, excludedObjects: ['Case_Note__c'] };
    const listed = await call('salesforce_list_objects');
    expect(text(listed)).toContain('Site_Visit__c');
    expect(text(listed)).not.toContain('Case_Note__c');

    for (const result of [
      await call('salesforce_describe_object', { object: 'Case_Note__c' }),
      await call('salesforce_get_record', { record: 'a02000000000001AAA' }),
      await call('salesforce_query', { soql: 'SELECT Id FROM Case_Note__c' }),
      await call('salesforce_query', {
        soql: 'SELECT Id, (SELECT Id FROM Case_Notes__r) FROM Account WHERE Id IN (SELECT Account__c FROM Case_Note__c)',
      }),
    ]) {
      expect(result.isError).toBe(true);
    }
    expect(queries().some((q) => /Case_Note__c/.test(q))).toBe(false);
  });

  it('hides a listed field from describes, whole-record reads, queries, writes and write receipts', async () => {
    policy = { ...EMPTY_POLICY, excludedFields: ['Site_Visit__c.Stage_Changed__c'] };
    const described = await call('salesforce_describe_object', { object: 'Site_Visit__c' });
    expect(text(described)).toContain('Stage__c');
    expect(text(described)).not.toContain('Stage_Changed__c');

    // A whole-record read names the describe's fields instead of FIELDS(ALL),
    // and what comes back is scrubbed by type besides.
    override = (method, path, query) => {
      const q = new URLSearchParams(query).get('q') ?? '';
      if (method === 'GET' && path === `${V}/query` && /^SELECT Id, Name, Account__c/.test(q)) {
        return answer(200, {
          totalSize: 1,
          done: true,
          records: [
            {
              attributes: { type: 'Site_Visit__c' },
              Id: VISIT,
              Name: 'SV-0001',
              Stage_Changed__c: '2026-10-21T14:02:00.000+0000',
            },
          ],
        });
      }
      return undefined;
    };
    const record = await call('salesforce_get_record', { record: VISIT });
    expect(record.isError).toBeUndefined();
    expect(text(record)).toContain('SV-0001');
    expect(text(record)).not.toContain('Stage_Changed__c');
    expect(queries().some((q) => /FIELDS\(ALL\)/.test(q))).toBe(false);
    override = null;

    const filtered = await call('salesforce_query', {
      soql: 'SELECT Id FROM Site_Visit__c WHERE Stage_Changed__c = LAST_N_DAYS:7',
    });
    expect(filtered.isError).toBe(true);
    expect(text(filtered)).toContain('stage_changed__c');

    const write = await call('salesforce_update_record', {
      object: 'Site_Visit__c',
      record: VISIT,
      fields: { Stage_Changed__c: '2026-10-21T00:00:00Z' },
    });
    expect(write.isError).toBe(true);

    // The org's automation still stamps the hidden field; the receipt does not say so.
    const update = await call('salesforce_update_record', {
      object: 'Site_Visit__c',
      record: VISIT,
      fields: { Stage__c: 'Completed' },
    });
    expect(update.isError).toBeUndefined();
    expect(text(update)).toContain('Stage (Stage__c): Scheduled → Completed');
    expect(text(update)).not.toContain('Stage_Changed__c');
  });

  it('hides fields classified Restricted, and refuses the object when the classification cannot be read', async () => {
    policy = { ...EMPTY_POLICY, hideRestricted: true };
    override = (method, path, query) => {
      const q = new URLSearchParams(query).get('q') ?? '';
      if (method === 'GET' && path === `${V}/query` && /FROM FieldDefinition/.test(q)) {
        return /'Site_Visit__c'/.test(q)
          ? answer(200, {
              totalSize: 2,
              done: true,
              records: [
                { QualifiedApiName: 'Visit_Date__c', SecurityClassification: 'Restricted' },
                { QualifiedApiName: 'Stage__c', SecurityClassification: 'Internal' },
              ],
            })
          : answer(400, [{ errorCode: 'INVALID_TYPE', message: 'no FieldDefinition access' }]);
      }
      return undefined;
    };
    const described = await call('salesforce_describe_object', { object: 'Site_Visit__c' });
    expect(text(described)).toContain('Stage__c');
    expect(text(described)).not.toContain('Visit_Date__c');

    const account = await call('salesforce_describe_object', { object: 'Account' });
    expect(account.isError).toBe(true);
    expect(text(account)).toContain('could not be read');
  });

  it('refuses a report with a hidden column', async () => {
    policy = { ...EMPTY_POLICY, excludedFields: ['Site_Visit__c.Visit_Date__c'] };
    const REPORT = '00O000000000002AAA';
    override = (method, path) =>
      method === 'GET' && path === `${V}/analytics/reports/${REPORT}/describe`
        ? answer(200, {
            reportMetadata: {
              name: 'Visits',
              reportType: { type: 'CustomEntity$Site_Visit__c' },
              detailColumns: ['Site_Visit__c.Name', 'Site_Visit__c.Visit_Date__c'],
            },
          })
        : undefined;
    const run = await call('salesforce_run_report', { report: REPORT });
    expect(run.isError).toBe(true);
    expect(text(run)).toContain('Site_Visit__c.Visit_Date__c');
    expect(sent('GET', `/analytics/reports/${REPORT}`)).toHaveLength(0);
  });
});

describe('files', () => {
  const DOC = '069000000000001AAA';
  const VERSION = '068000000000001AAA';

  it('stages a record’s files in the scratch space, bytes server to server', async () => {
    override = (method, path, query) => {
      const q = new URLSearchParams(query).get('q') ?? '';
      if (
        method === 'GET' &&
        path === `${V}/query` &&
        /FROM ContentDocumentLink WHERE LinkedEntityId/.test(q)
      )
        return answer(200, { totalSize: 1, done: true, records: [{ ContentDocumentId: DOC }] });
      if (
        method === 'GET' &&
        path === `${V}/query` &&
        /FROM ContentVersion WHERE ContentDocumentId IN/.test(q)
      ) {
        return answer(200, {
          totalSize: 1,
          done: true,
          records: [
            {
              Id: VERSION,
              ContentDocumentId: DOC,
              Title: 'Visit photo',
              FileExtension: 'png',
              ContentSize: 4,
            },
          ],
        });
      }
      if (method === 'GET' && path === `${V}/sobjects/ContentVersion/${VERSION}/VersionData`) {
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': '4' },
        });
      }
      return undefined;
    };
    sandbox.sbWriteFile.mockResolvedValue({
      ok: true,
      val: {
        id: 'f-1',
        filename: 'Visit photo.png',
        sizeBytes: 4,
        createdAt: '2026-10-21T00:00:00Z',
        expiresAt: '2026-10-22T00:00:00Z',
      },
    });
    const result = await call('salesforce_download_file', { record: VISIT });
    expect(result.isError).toBeUndefined();
    expect(sandbox.sbWriteFile).toHaveBeenCalledWith(
      { subject: 'subject-1' },
      {
        filename: 'Visit photo.png',
        contentType: 'image/png',
        source: `salesforce:production:${VERSION}`,
      },
      new Uint8Array([137, 80, 78, 71])
    );
    expect(text(result)).toContain('1 of 1 file(s) staged');
  });

  it('refuses a file attached to a hidden object’s record', async () => {
    policy = { ...EMPTY_POLICY, excludedObjects: ['Case_Note__c'] };
    override = (method, path, query) => {
      const q = new URLSearchParams(query).get('q') ?? '';
      if (
        method === 'GET' &&
        path === `${V}/query` &&
        /FROM ContentVersion WHERE ContentDocumentId = /.test(q)
      ) {
        return answer(200, {
          totalSize: 1,
          done: true,
          records: [
            {
              Id: VERSION,
              ContentDocumentId: DOC,
              Title: 'Note',
              FileExtension: 'pdf',
              ContentSize: 9,
            },
          ],
        });
      }
      if (
        method === 'GET' &&
        path === `${V}/query` &&
        /FROM ContentDocumentLink WHERE ContentDocumentId/.test(q)
      ) {
        return answer(200, {
          totalSize: 2,
          done: true,
          records: [{ LinkedEntityId: ACCOUNT }, { LinkedEntityId: 'a02000000000001AAA' }],
        });
      }
      return undefined;
    };
    const result = await call('salesforce_download_file', { file: DOC });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Case_Note__c');
    expect(sent('GET', `/sobjects/ContentVersion/${VERSION}/VersionData`)).toHaveLength(0);
    expect(sandbox.sbWriteFile).not.toHaveBeenCalled();
  });

  it('attaches a staged file to a record and shares it to another', async () => {
    sandbox.sbReadFile.mockResolvedValue({
      ok: true,
      val: {
        filename: 'consent.pdf',
        contentType: 'application/pdf',
        bytes: new Uint8Array([1, 2, 3]),
      },
    });
    override = (method, path, query) => {
      const q = new URLSearchParams(query).get('q') ?? '';
      if (method === 'POST' && path === `${V}/sobjects/ContentVersion`)
        return answer(201, { id: VERSION, success: true });
      if (method === 'GET' && path === `${V}/query` && /FROM ContentVersion WHERE Id = /.test(q))
        return answer(200, { totalSize: 1, done: true, records: [{ ContentDocumentId: DOC }] });
      if (method === 'POST' && path === `${V}/sobjects/ContentDocumentLink`)
        return answer(201, { id: '06A000000000001AAA', success: true });
      return undefined;
    };
    const result = await call('salesforce_attach_file', {
      fileId: 'f-1',
      record: VISIT,
      alsoOn: [{ record: ACCOUNT }],
    });
    expect(result.isError).toBeUndefined();
    expect(sent('POST', '/sobjects/ContentVersion')[0].body).toEqual({
      Title: 'consent',
      PathOnClient: 'consent.pdf',
      VersionData: Buffer.from([1, 2, 3]).toString('base64'),
      FirstPublishLocationId: VISIT,
    });
    expect(sent('POST', '/sobjects/ContentDocumentLink')[0].body).toEqual({
      ContentDocumentId: DOC,
      LinkedEntityId: ACCOUNT,
      ShareType: 'V',
      Visibility: 'InternalUsers',
    });
    expect(text(result)).toContain('Shared to Account Acme');
  });
});
