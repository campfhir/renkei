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
import { invalidateDescribe, invalidateOrgDescribes } from '../salesforce/schema';
import { resetApiUsage } from '../salesforce/client';
import { ALL_SALESFORCE_ADMIN_SCOPES } from '@/lib/salesforce-admin-scopes';
import { registerSalesforceAdminTools } from './index';
import { salesforceAdminScopeFor } from './scopes';
import { brokenPreconditions, isMissingReportType } from '@/lib/salesforce-admin/plan';

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
/** The field access the set or profile being changed holds now. */
let fieldAccessRows: Record<string, unknown>[];
/** Whether a profile sees the layout. */
let layoutUsed: boolean;
/** Whether the set being changed may open the Sales app. */
let opensApp: boolean;
/** The system permissions the set or profile being changed has on. */
let systemOn: string[];
/** The permission set groups the set being changed belongs to. */
let inGroups: string[];
/** Whether the name resolves to a permission set group's own row. */
let isGroup: boolean;
/** How many field and object grants the org says the set has. */
let grantRows: { fields: number; objects: number };
/** The tabs it shows now. */
let tabRows: Record<string, unknown>[];
/** Fields the org gained after the describe was first read. */
let deployedSince: Record<string, unknown>[];

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
const PROFILE_SET = '0PS000000000009AAA';
const APP = '0H4000000000001AAA';

const VISIT_NOTE = {
  name: 'Visit_Note__c',
  label: 'Visit Note',
  labelPlural: 'Visit Notes',
  custom: true,
  fields: [
    { name: 'Id', label: 'Record ID', type: 'id' },
    { name: 'Name', label: 'Note Number', type: 'string', nameField: true },
    { name: 'Body__c', label: 'Body', type: 'textarea', custom: true },
  ],
  childRelationships: [],
  recordTypeInfos: [],
};

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The body of the request being answered (the last one recorded). */
const lastBody = () => {
  const body = requests.at(-1)?.body;
  return typeof body === 'string' ? body : '';
};

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
    return answer(200, {
      ...SITE_VISIT,
      fields: [...SITE_VISIT.fields, ...deployedSince],
      childRelationships: [
        { relationshipName: 'Visit_Notes__r', childSObject: 'Visit_Note__c', field: 'Visit__c' },
      ],
    });
  if (method === 'GET' && path === `${V}/sobjects/Visit_Note__c/describe`)
    return answer(200, VISIT_NOTE);
  if (method === 'GET' && path === `${V}/analytics/reportTypes`) {
    return answer(200, [
      {
        label: 'Opportunities',
        reportTypes: [{ label: 'Opportunities', type: 'Opportunity' }],
      },
      {
        label: 'Other Reports',
        reportTypes: [{ label: 'Site Visits', type: 'Site_Visits__c' }],
      },
    ]);
  }
  if (method === 'GET' && path === `${V}/analytics/reportTypes/Opportunity`) {
    return answer(200, {
      reportMetadata: { reportType: { type: 'Opportunity', label: 'Opportunities' } },
      reportTypeMetadata: {
        scopeInfo: {
          defaultValue: 'user',
          values: [
            { value: 'user', label: 'My opportunities' },
            { value: 'organization', label: 'All opportunities' },
          ],
        },
        categories: [
          {
            label: 'Opportunity Information',
            columns: {
              OPPORTUNITY_NAME: { label: 'Opportunity Name', dataType: 'string' },
              AMOUNT: { label: 'Amount', dataType: 'currency' },
              STAGE_NAME: { label: 'Stage', dataType: 'picklist' },
              CLOSE_DATE: { label: 'Close Date', dataType: 'date' },
            },
          },
        ],
      },
    });
  }
  if (method === 'GET' && path === `${V}/analytics/reportTypes/Site_Visits__c`) {
    return answer(200, {
      reportMetadata: { reportType: { type: 'Site_Visits__c', label: 'Site Visits' } },
      reportTypeMetadata: {
        categories: [
          {
            label: 'Site Visits',
            columns: {
              'Site_Visit__c.Name': { label: 'Visit Number', dataType: 'string' },
              'Site_Visit__c.Owner.Email': { label: 'Owner: Email', dataType: 'email' },
              'Site_Visit__c.Owner.Name': { label: 'Owner: Full Name', dataType: 'string' },
            },
          },
          {
            label: 'Visit Notes',
            // A joined table's columns go by its object, not the join path.
            columns: {
              'Visit_Note__c.Body__c': { label: 'Body', dataType: 'textarea' },
            },
          },
        ],
      },
    });
  }
  if (method === 'GET' && path === `${V}/query` && /FROM Folder WHERE Type = 'Report'/.test(q)) {
    const all = [
      {
        Id: '00l000000000001AAA',
        Name: 'Program Reports',
        DeveloperName: 'Program_Reports',
        AccessType: 'Public',
      },
    ];
    const match = /DeveloperName = '([^']*)' OR Name = '([^']*)'/.exec(q);
    const rows = match
      ? all.filter((f) => f.DeveloperName === match[1] || f.Name === match[2])
      : all;
    return answer(200, { totalSize: rows.length, done: true, records: rows });
  }
  if (method === 'GET' && path === `${V}/query` && /FROM Report WHERE DeveloperName/.test(q)) {
    const rows = /'(Pipeline|Open Pipeline)'/.test(q)
      ? [
          {
            Id: '00O000000000001AAA',
            Name: 'Open Pipeline',
            DeveloperName: 'Pipeline',
            OwnerId: '00l000000000001AAA',
          },
        ]
      : [];
    return answer(200, { totalSize: rows.length, done: true, records: rows });
  }
  if (method === 'GET' && path === `${V}/query` && /FROM Report WHERE OwnerId/.test(q)) {
    const rows = /DeveloperName = 'Pipeline'/.test(q) ? [{ Id: '00O000000000001AAA' }] : [];
    return answer(200, { totalSize: rows.length, done: true, records: rows });
  }
  if (method === 'GET' && path === `${V}/query` && /FROM FieldDefinition/.test(q)) {
    // Every field, including one the person's field-level access hides from the describe.
    // A query for one field answers with that field, or nothing.
    const one = /AND QualifiedApiName = '([^']+)'/.exec(q)?.[1];
    const records = ['Id', 'Name', 'Stage__c', 'Visit_Date__c', 'Hidden_Score__c']
      .filter((n) => !one || n === one)
      .map((n) => ({ QualifiedApiName: n, IsNillable: n.endsWith('__c'), DataType: 'Text' }));
    return answer(200, { totalSize: records.length, done: true, records });
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
      totalSize: layoutUsed ? 1 : 0,
      done: true,
      records: layoutUsed
        ? [{ LayoutId: LAYOUT_ID, Profile: { Name: 'Standard User' }, RecordType: null }]
        : [],
    });
  }
  if (method === 'GET' && path === `${V}/tooling/query` && /FROM CustomField/.test(q)) {
    // SOQL compares names without regard to case; no name asked for is every field.
    const asked = /DeveloperName = '([^']+)'/.exec(q)?.[1];
    const rows = Object.entries(fieldMetadata)
      .filter(([name]) => !asked || name.toLowerCase() === `${asked}__c`.toLowerCase())
      .map(([name, metadata]) => ({
        Id: '00N000000000001AAA',
        DeveloperName: name.replace(/__c$/, ''),
        FullName: `Site_Visit__c.${name}`,
        Metadata: metadata,
      }));
    return answer(200, { totalSize: rows.length, done: true, records: rows });
  }
  if (
    method === 'GET' &&
    path === `${V}/query` &&
    /COUNT\(Id\) n FROM (FieldPermissions|ObjectPermissions)/.test(q)
  ) {
    // The org's own count of what the set grants.
    const fields = /FROM FieldPermissions/.test(q);
    return answer(200, {
      totalSize: 1,
      done: true,
      records: [{ n: fields ? grantRows.fields : grantRows.objects }],
    });
  }
  if (method === 'GET' && path === `${V}/query` && /FROM ObjectPermissions/.test(q)) {
    return answer(200, { totalSize: objectRows.length, done: true, records: objectRows });
  }
  if (method === 'GET' && path === `${V}/query` && /FROM FieldPermissions/.test(q)) {
    return answer(200, {
      totalSize: fieldAccessRows.length,
      done: true,
      records: fieldAccessRows,
    });
  }
  if (method === 'GET' && path === `${V}/query` && /FROM PermissionSetTabSetting/.test(q)) {
    return answer(200, { totalSize: tabRows.length, done: true, records: tabRows });
  }
  if (method === 'GET' && path === `${V}/sobjects/PermissionSet/describe`) {
    return answer(200, {
      name: 'PermissionSet',
      label: 'Permission Set',
      fields: [
        { name: 'Id', label: 'ID', type: 'id' },
        { name: 'PermissionsViewSetup', label: 'View Setup and Configuration', type: 'boolean' },
        { name: 'PermissionsManageUsers', label: 'Manage Users', type: 'boolean' },
        { name: 'PermissionsModifyAllData', label: 'Modify All Data', type: 'boolean' },
      ],
    });
  }
  if (method === 'GET' && path === `${V}/query` && /FROM UserLicense/.test(q)) {
    const known = /'Salesforce'/.test(q);
    return answer(200, {
      totalSize: known ? 1 : 0,
      done: true,
      records: known ? [{ Name: 'Salesforce' }] : [],
    });
  }
  if (
    method === 'GET' &&
    path === `${V}/query` &&
    /FROM Profile WHERE Name = '/.test(q) &&
    !/'Standard User'/.test(q)
  ) {
    return answer(200, { totalSize: 0, done: true, records: [] });
  }
  if (method === 'GET' && path === `${V}/query` && /FROM Profile( |$)/.test(q)) {
    return answer(200, {
      totalSize: 1,
      done: true,
      records: [
        { Id: '00e000000000001AAA', Name: 'Standard User', UserLicense: { Name: 'Salesforce' } },
      ],
    });
  }
  if (method === 'GET' && path === `${V}/query` && /FROM User WHERE (ProfileId|IsActive)/.test(q)) {
    const grouped = /GROUP BY ProfileId/.test(q);
    return answer(200, {
      totalSize: 1,
      done: true,
      records: grouped
        ? [{ ProfileId: '00e000000000001AAA', n: 4 }]
        : [{ Name: 'Grace Hopper', Username: 'grace@acme.org' }],
    });
  }
  if (
    method === 'GET' &&
    path === `${V}/query` &&
    /FROM PermissionSet WHERE IsOwnedByProfile = true/.test(q)
  ) {
    // A profile's own permission set, which its access hangs from.
    const known = /Profile\.Name = 'Standard User'/.test(q);
    return answer(200, {
      totalSize: known ? 1 : 0,
      done: true,
      records: known
        ? [{ Id: PROFILE_SET, ProfileId: '00e000000000001AAA', Profile: { Name: 'Standard User' } }]
        : [],
    });
  }
  if (method === 'GET' && path === `${V}/query` && /FROM PermissionSetGroup( |$)/.test(q)) {
    return answer(200, {
      totalSize: 1,
      done: true,
      records: [{ DeveloperName: 'PACE_Staff', MasterLabel: 'PACE Staff' }],
    });
  }
  if (
    method === 'GET' &&
    path === `${V}/query` &&
    /FROM PermissionSetGroupComponent WHERE PermissionSetGroupId/.test(q)
  ) {
    // The sets a group is made of.
    return answer(200, {
      totalSize: 2,
      done: true,
      records: [
        { PermissionSet: { Name: 'Visit_Fields', Label: 'Visit Fields' } },
        { PermissionSet: { Name: 'Visit_Objects', Label: 'Visit Objects' } },
      ],
    });
  }
  if (method === 'GET' && path === `${V}/query` && /FROM PermissionSetGroupComponent/.test(q)) {
    return answer(200, {
      totalSize: inGroups.length,
      done: true,
      records: inGroups.map((label) => ({ PermissionSetGroup: { MasterLabel: label } })),
    });
  }
  if (
    method === 'GET' &&
    path === `${V}/query` &&
    /COUNT\(Id\) n FROM PermissionSetAssignment WHERE PermissionSetId/.test(q)
  ) {
    return answer(200, { totalSize: 1, done: true, records: [{ n: assigned.length }] });
  }
  if (method === 'GET' && path === `${V}/query` && /FROM AppDefinition/.test(q)) {
    const known = /'(Sales|0H4000000000001AAA)'/.test(q);
    return answer(200, {
      totalSize: known ? 1 : 0,
      done: true,
      records: known ? [{ DurableId: APP, DeveloperName: 'Sales', Label: 'Sales' }] : [],
    });
  }
  if (method === 'GET' && path === `${V}/query` && /FROM SetupEntityAccess/.test(q)) {
    return answer(200, {
      totalSize: opensApp ? 1 : 0,
      done: true,
      records: opensApp ? [{ SetupEntityId: APP }] : [],
    });
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
      records: [
        {
          Id: '0PS000000000001AAA',
          Name: 'Program_Staff',
          Label: 'Program Staff',
          ...(isGroup ? { Type: 'Group', PermissionSetGroupId: '0PG000000000001AAA' } : {}),
          // The system permissions it has on, for a query that asks for them.
          ...Object.fromEntries(systemOn.map((field) => [field, true])),
        },
      ],
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
  // readMetadata, through the delegate's SOAP envelope (here, straight to the org).
  if (method === 'POST' && path === '/services/Soap/m/68.0') {
    const known = /<fullNames>Site_Visits<\/fullNames>/.test(lastBody());
    const record = /<type>Report<\/type><fullNames>Program_Reports\/Pipeline<\/fullNames>/.test(
      lastBody()
    )
      ? '<records xsi:type="Report"><fullName>Program_Reports/Pipeline</fullName><chart><chartType>HorizontalBar</chartType></chart><columns><field>OPPORTUNITY_NAME</field></columns><columns><aggregateTypes>Sum</aggregateTypes><field>AMOUNT</field></columns><filter><criteriaItems><column>STAGE_NAME</column><columnToColumn>false</columnToColumn><isUnlocked>true</isUnlocked><operator>notEqual</operator><value>Closed Lost</value></criteriaItems></filter><format>Tabular</format><name>Open Pipeline</name><reportType>Opportunity</reportType><scope>organization</scope><showDetails>true</showDetails><timeFrameFilter><dateColumn>CLOSE_DATE</dateColumn><interval>INTERVAL_CUSTOM</interval><startDate>2025-11-11</startDate></timeFrameFilter></records>'
      : /<type>Profile<\/type><fullNames>Standard<\/fullNames>/.test(lastBody())
        ? '<records xsi:type="Profile"><fullName>Standard</fullName><custom>false</custom><loginHours><mondayEnd>1080</mondayEnd><mondayStart>480</mondayStart></loginHours><loginIpRanges><description>Office</description><endAddress>203.0.113.255</endAddress><startAddress>203.0.113.0</startAddress></loginIpRanges><objectPermissions><allowRead>true</allowRead><object>Site_Visit__c</object></objectPermissions><userLicense>Salesforce</userLicense></records>'
        : /<type>PermissionSet<\/type><fullNames>Program_Staff<\/fullNames>/.test(lastBody())
          ? '<records xsi:type="PermissionSet"><fullName>Program_Staff</fullName><hasActivationRequired>false</hasActivationRequired><label>Program Staff</label><objectPermissions><allowCreate>false</allowCreate><allowRead>true</allowRead><object>Site_Visit__c</object></objectPermissions><recordTypeVisibilities><recordType>Opportunity.Grant</recordType><visible>true</visible></recordTypeVisibilities><userPermissions><enabled>true</enabled><name>ViewSetup</name></userPermissions></records>'
          : known
            ? `<records xsi:type="ReportType"><fullName>Site_Visits</fullName><baseObject>Site_Visit__c</baseObject><category>other</category><deployed>true</deployed><description>Visits</description><label>Site Visits</label><sections><columns><checkedByDefault>true</checkedByDefault><field>Name</field><table>Site_Visit__c</table></columns><columns><checkedByDefault>false</checkedByDefault><displayNameOverride>Visit Stage</displayNameOverride><field>Stage__c</field><table>Site_Visit__c</table></columns><columns><checkedByDefault>false</checkedByDefault><field>Owner</field><table>Site_Visit__c</table></columns><masterLabel>Visits</masterLabel></sections><join><outerJoin>false</outerJoin><relationship>Visit_Notes__r</relationship></join><sections><columns><checkedByDefault>true</checkedByDefault><field>Body__c</field><table>Site_Visit__c.Visit_Notes__r</table></columns><masterLabel>Visit Notes</masterLabel></sections></records>`
            : '<records xsi:nil="true"/>';
    return new Response(
      `<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Body><readMetadataResponse><result>${record}</result></readMetadataResponse></soapenv:Body></soapenv:Envelope>`,
      { status: 200, headers: { 'content-type': 'text/xml' } }
    );
  }
  // A name that names no report type: Salesforce answers 400, not 404.
  if (method === 'GET' && path.startsWith(`${V}/analytics/reportTypes/`)) {
    const type = decodeURIComponent(path.slice(`${V}/analytics/reportTypes/`.length));
    return answer(400, [
      {
        errorCode: 'BAD_REQUEST',
        message: `Specify a valid report type. ${type} is not a report type.`,
      },
    ]);
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

async function tools(scopes: string[] | null = ALL_SALESFORCE_ADMIN_SCOPES, roles?: string[]) {
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
  fieldAccessRows = [];
  layoutUsed = true;
  opensApp = false;
  systemOn = [];
  inGroups = [];
  isGroup = false;
  grantRows = { fields: 0, objects: 1 };
  tabRows = [];
  deployedSince = [];
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
  store.createChangeRequest.mockImplementation(async (input: Record<string, unknown>) => ({
    id: '11111111-2222-4333-8444-555555555555',
    ...input,
  }));
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
    store.createRequest.mockImplementation(async (input: Record<string, unknown>) => ({
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
    expect(store.createRequest.mock.calls[0][0]).toMatchObject({
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
    const result = await call('salesforce_admin_request_change', { title: 'x', description: 'y' }, [
      'renkei-user',
    ]);
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
    const operator = await call('salesforce_admin_list_change_requests', { everyone: true }, [
      'renkei-operator',
    ]);
    expect(text(operator)).toContain('asked by asker');
    expect(text(operator)).toContain('Asked for: Site_Visit__c needs Outcome__c.');
    const ordinary = await call('salesforce_admin_list_change_requests', { everyone: true }, [
      'renkei-user',
    ]);
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

describe('salesforce_admin_get_change_request', () => {
  const applied = {
    id: '11111111-2222-4333-8444-555555555555',
    title: 'Site Visit: add the field Years Enrolled',
    kind: 'fields',
    subject: 'subject-1',
    connectorKey: 'uat',
    instanceUrl: UAT,
    reason: 'Ticket ENG-920',
    status: 'applied',
    createdAt: new Date('2026-11-11T15:44:00Z'),
    approvedAt: new Date('2026-11-11T15:44:20Z'),
    appliedAt: new Date('2026-11-11T15:44:40Z'),
    expiresAt: new Date('2026-11-12T15:44:00Z'),
    updatedAt: new Date('2026-11-11T15:44:40Z'),
    step: null,
    resolution: null,
    validation: {
      deployId: DEPLOY,
      done: true,
      success: true,
      status: 'Succeeded',
      failures: [],
      checkedAt: '2026-11-11T15:44:05Z',
    },
    payload: {
      files: { 'package.xml': '<Package/>' },
      members: [{ type: 'CustomField', member: 'Site_Visit__c.Years_Enrolled__c' }],
      components: [
        {
          type: 'CustomField',
          name: 'Site_Visit__c.Years_Enrolled__c',
          action: 'create',
          rows: [
            { label: 'Label', value: 'Years Enrolled' },
            { label: 'Formula', value: 'FLOOR((TODAY() - Visit_Date__c) / 365.25)' },
          ],
        },
      ],
      preconditions: [],
      dataSteps: [],
    },
    results: {
      deployId: DEPLOY,
      operations: [{ label: 'Deploy 1 component(s)', outcome: 'done', detail: `Deploy ${DEPLOY}` }],
    },
  };

  it('says an approved change went in, still shows what it deployed, and lists each step', async () => {
    store.getChangeRequestById.mockResolvedValue(applied);
    const result = await call('salesforce_admin_get_change_request', {
      id: `https://renkei.example/salesforce-admin/changes/${applied.id}`,
    });
    expect(result.isError).toBeUndefined();
    expect(store.getChangeRequestById).toHaveBeenCalledWith(applied.id);
    expect(text(result)).toContain('Status: applied');
    expect(text(result)).toContain('Applied: 2026-11-11T15:44:40.000Z');
    expect(text(result)).toContain('New CustomField Site_Visit__c.Years_Enrolled__c');
    expect(text(result)).toContain('Formula: FLOOR((TODAY() - Visit_Date__c) / 365.25)');
    expect(text(result)).toContain('Deploy 1 component(s) — done');
    expect(text(result)).toContain(`salesforce-admin/changes/${applied.id}`);
  });

  it('says a change nobody has approved is still waiting, and that nothing changed', async () => {
    store.getChangeRequestById.mockResolvedValue({
      ...applied,
      status: 'pending',
      approvedAt: null,
      appliedAt: null,
      results: null,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const result = await call('salesforce_admin_get_change_request', { id: applied.id });
    expect(text(result)).toContain('Status: pending — waiting for an operator to approve it');
    expect(text(result)).not.toContain('What happened');
  });

  it('reads someone else’s request as none, unless an operator asks', async () => {
    store.getChangeRequestById.mockResolvedValue({ ...applied, subject: 'someone-else' });
    const ordinary = await call('salesforce_admin_get_change_request', { id: applied.id }, [
      'renkei-user',
    ]);
    expect(ordinary.isError).toBe(true);
    expect(text(ordinary)).toContain('There is no change request');
    const operator = await call('salesforce_admin_get_change_request', { id: applied.id }, [
      'renkei-operator',
    ]);
    expect(text(operator)).toContain('Status: applied');
  });
});

describe('a field the person’s field-level access hides', () => {
  beforeEach(() => {
    // Deployed, with no permission set given access: Setup has it, the
    // describe and FieldDefinition do not show it to this person.
    fieldMetadata.Years_Enrolled__c = {
      label: 'Years Enrolled',
      type: 'Number',
      formula: 'FLOOR((TODAY() - Visit_Date__c) / 365.25)',
    };
  });

  it('is found by salesforce_admin_get_field, with its formula, and said to be hidden', async () => {
    const result = await call('salesforce_admin_get_field', {
      object: 'Site_Visit__c',
      field: 'Years_Enrolled__c',
    });
    expect(result.isError).toBeUndefined();
    const field = JSON.parse(text(result));
    expect(field.visibleToYou).toBe(false);
    expect(field.formula).toBe('FLOOR((TODAY() - Visit_Date__c) / 365.25)');
    expect(field.note).toContain('salesforce_admin_propose_permission_set');
  });

  it('is refused for a report type with the reason, not as a field that does not exist', async () => {
    const result = await call('salesforce_admin_propose_report_type_changes', {
      reportType: 'Site_Visits',
      add: [{ fields: ['Years_Enrolled__c'] }],
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Site_Visit__c.Years_Enrolled__c exists');
    expect(text(result)).toContain('no field-level access');
    expect(deploys()).toHaveLength(0);
  });

  it('can be given to a permission set — the way out of being hidden', async () => {
    const result = await call('salesforce_admin_propose_permission_set', {
      permissionSet: 'Program Staff',
      fields: [{ object: 'Site_Visit__c', field: 'years_enrolled__c' }],
    });
    expect(result.isError).toBeUndefined();
    expect(stored().payload.dataSteps).toContainEqual(
      expect.objectContaining({
        kind: 'field-permission',
        object: 'Site_Visit__c',
        field: 'Years_Enrolled__c',
        read: true,
        edit: false,
      })
    );
  });

  it('can be placed on a page layout', async () => {
    const result = await call('salesforce_admin_propose_layout_changes', {
      object: 'Site_Visit__c',
      layout: 'Site Visit Layout',
      add: [{ field: 'years_enrolled__c', behavior: 'Readonly' }],
    });
    expect(result.isError).toBeUndefined();
    const layout = (await received()).files['layouts/Site_Visit__c-Site Visit Layout.layout'];
    expect(layout).toContain('<field>Years_Enrolled__c</field>');
  });

  it('is a name taken: a new field cannot be proposed over it', async () => {
    const result = await call('salesforce_admin_propose_fields', {
      object: 'Site_Visit__c',
      fields: [{ label: 'Years Enrolled', type: 'Number' }],
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Years Enrolled');
    expect(store.createChangeRequest).not.toHaveBeenCalled();
  });

  it('counts as existing when a proposal checks the org has not changed', async () => {
    const access = await stubAuth.resolve();
    if (typeof access === 'string') throw new Error(access);
    expect(
      await brokenPreconditions({ subject: 'subject-1' }, access, [
        { kind: 'field-absent', object: 'Site_Visit__c', field: 'Years_Enrolled__c' },
      ])
    ).toEqual([
      'Site_Visit__c.Years_Enrolled__c exists now — someone created it since this was proposed.',
    ]);
  });
});

describe('a field that does not exist', () => {
  it('is said so by salesforce_admin_get_field, pointing at the change request’s status', async () => {
    const result = await call('salesforce_admin_get_field', {
      object: 'Site_Visit__c',
      field: 'Nowhere__c',
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Site_Visit__c has no field Nowhere__c');
    expect(text(result)).toContain('salesforce_admin_get_change_request');
  });
});

describe('a field deployed since the describe was read', () => {
  it('shows in the next describe once a deploy in that org says the schema moved', async () => {
    await call('salesforce_admin_describe_object', { object: 'Site_Visit__c' });
    deployedSince = [
      { name: 'Years_Enrolled__c', label: 'Years Enrolled', type: 'double', custom: true },
    ];
    const stale = await call('salesforce_admin_describe_object', { object: 'Site_Visit__c' });
    expect(text(stale)).not.toContain('Years_Enrolled__c');
    invalidateOrgDescribes('another-org');
    const access = await stubAuth.resolve();
    if (typeof access === 'string') throw new Error(access);
    invalidateOrgDescribes(access.orgId);
    const fresh = await call('salesforce_admin_describe_object', { object: 'Site_Visit__c' });
    expect(text(fresh)).toContain('Years_Enrolled__c');
  });

  it('is added to a report type: the describe is asked for again before a field is called missing', async () => {
    // The describe is read, and cached, before the field exists.
    await call('salesforce_admin_describe_object', { object: 'Site_Visit__c' });
    deployedSince = [
      { name: 'Years_Enrolled__c', label: 'Years Enrolled', type: 'double', custom: true },
    ];
    const result = await call('salesforce_admin_propose_report_type_changes', {
      reportType: 'Site_Visits',
      add: [{ fields: ['Years_Enrolled__c'] }],
    });
    expect(result.isError).toBeUndefined();
    const { files } = await received();
    expect(files['reportTypes/Site_Visits.reportType']).toContain(
      '<field>Years_Enrolled__c</field>'
    );
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

    const stored = store.createChangeRequest.mock.calls[0][0];
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
    expect(store.setValidation.mock.calls[0][1]).toMatchObject({
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

  it('proposes a formula field, read only for the permission sets it is given to', async () => {
    const result = await call('salesforce_admin_propose_fields', {
      object: 'Site Visit',
      fields: [
        {
          label: 'Days Since Visit',
          type: 'Formula',
          returnType: 'Number',
          formula: 'TODAY() - Visit_Date__c',
        },
      ],
      grantTo: [{ permissionSet: 'Program Staff', edit: true }],
    });
    expect(result.isError).toBeUndefined();
    const { files } = await received();
    const object = files['objects/Site_Visit__c.object'];
    expect(object).toContain('<formula>TODAY() - Visit_Date__c</formula>');
    expect(object).toContain('<type>Number</type>');
    const stored = store.createChangeRequest.mock.calls[0][0];
    expect(stored.payload.components[0].rows).toEqual(
      expect.arrayContaining([
        { label: 'Type', value: 'Formula (Number)' },
        { label: 'Formula', value: 'TODAY() - Visit_Date__c' },
      ])
    );
    // Nobody edits a calculated field, whatever the grant asked for.
    expect(stored.payload.dataSteps).toEqual([
      expect.objectContaining({ field: 'Days_Since_Visit__c', read: true, edit: false }),
    ]);
    expect(text(result)).toContain('Site_Visit__c.Days_Since_Visit__c — Formula (Number)');
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
    const stored = store.createChangeRequest.mock.calls[0][0];
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

const stored = () => store.createChangeRequest.mock.calls[0][0];

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

describe('salesforce_admin_get_layout, beyond the fields', () => {
  it('marks a field required on the layout, and lists the related lists', async () => {
    layoutMetadata.relatedLists = [{ fields: ['FULL_NAME'], relatedList: 'RelatedContactList' }];
    const result = await call('salesforce_admin_get_layout', {
      object: 'Site_Visit__c',
      layout: 'Site Visit Layout',
    });
    expect(text(result)).toContain('Column 1: Name (required)');
    expect(text(result)).toContain('• RelatedContactList — FULL_NAME');
  });
});

describe('salesforce_admin_propose_layout', () => {
  it('creates a layout as a copy of one the object has, refused at apply if the name is taken by then', async () => {
    const result = await call('salesforce_admin_propose_layout', {
      object: 'Site_Visit__c',
      create: { name: 'Home Visit Layout', copyFrom: 'Site Visit Layout' },
    });
    expect(result.isError).toBeUndefined();
    const { files } = await received();
    expect(Object.keys(files).sort()).toEqual([
      'layouts/Site_Visit__c-Home Visit Layout.layout',
      'package.xml',
    ]);
    expect(files['layouts/Site_Visit__c-Home Visit Layout.layout']).toContain(
      '<field>Stage__c</field>'
    );
    expect(stored().payload.components[0]).toMatchObject({ action: 'create' });
    expect(stored().payload.preconditions).toEqual([
      { kind: 'layout-absent', object: 'Site_Visit__c', layout: 'Home Visit Layout' },
    ]);
    const access = await stubAuth.resolve();
    if (typeof access === 'string') throw new Error(access);
    expect(
      await brokenPreconditions({ subject: 'subject-1' }, access, [
        { kind: 'layout-absent', object: 'Site_Visit__c', layout: 'site visit layout' },
      ])
    ).toEqual([
      'The layout “site visit layout” exists now — someone created it since this was proposed.',
    ]);
  });

  it('refuses a name the object already has', async () => {
    const result = await call('salesforce_admin_propose_layout', {
      object: 'Site_Visit__c',
      create: { name: 'site visit layout' },
    });
    expect(text(result)).toContain('already has a layout “site visit layout”');
    expect(store.createChangeRequest).not.toHaveBeenCalled();
  });

  it('refuses to delete a layout a profile still sees, naming who', async () => {
    const result = await call('salesforce_admin_propose_layout', {
      object: 'Site_Visit__c',
      delete: 'Site Visit Layout',
    });
    expect(text(result)).toContain('is still the layout for Standard User');
    expect(store.createChangeRequest).not.toHaveBeenCalled();
  });

  it('deletes an unused layout as a destructive deploy, guarded by what was read', async () => {
    layoutUsed = false;
    const result = await call('salesforce_admin_propose_layout', {
      object: 'Site_Visit__c',
      delete: 'Site Visit Layout',
    });
    expect(result.isError).toBeUndefined();
    const { files } = await received();
    expect(Object.keys(files).sort()).toEqual(['destructiveChanges.xml', 'package.xml']);
    expect(files['destructiveChanges.xml']).toContain(
      '<members>Site_Visit__c-Site Visit Layout</members>'
    );
    expect(files['package.xml']).not.toContain('<members>');
    expect(stored().payload.components[0]).toMatchObject({ type: 'Layout', action: 'delete' });
    expect(stored().payload.preconditions).toEqual([
      expect.objectContaining({ kind: 'layout-unchanged', layout: 'Site Visit Layout' }),
    ]);
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

  it('moves a field, changes how one behaves, renames a section and adds a related list, in one layout', async () => {
    layoutMetadata.relatedLists = [{ fields: ['FULL_NAME'], relatedList: 'RelatedContactList' }];
    const result = await call('salesforce_admin_propose_layout_changes', {
      object: 'Site_Visit__c',
      layout: 'Site Visit Layout',
      move: [{ field: 'Stage__c', section: 'System Information' }],
      setBehavior: [{ field: 'Name', behavior: 'Readonly' }],
      renameSections: [{ section: 'Information', label: 'Visit' }],
      // The object's child relationship, spelled as the layout spells it.
      addRelatedLists: [{ relatedList: 'visit_notes__r', fields: ['NAME', 'Body__c'] }],
      removeRelatedLists: ['RelatedContactList'],
    });
    expect(result.isError).toBeUndefined();
    const { files } = await received();
    const layout = files['layouts/Site_Visit__c-Site Visit Layout.layout'];
    expect(layout).toContain('<label>Visit</label>');
    expect(layout).toMatch(/<behavior>Readonly<\/behavior>\s*<field>Name<\/field>/);
    expect(layout).toMatch(/<label>System Information<\/label>[\s\S]*<field>Stage__c<\/field>/);
    expect(layout).toContain('<relatedList>Visit_Note__c.Visit__c</relatedList>');
    expect(layout).not.toContain('RelatedContactList');
    expect(stored().payload.components[0].rows.map((r: { value: string }) => r.value)).toEqual(
      expect.arrayContaining([
        'Move Stage__c to “System Information”',
        'Make Name read only here',
        'Rename the section “Information” to “Visit”',
        'Add the related list Visit_Note__c.Visit__c showing NAME, Body__c',
      ])
    );
  });

  it('gives a profile the layout for a record type as a Profile file holding only that', async () => {
    const result = await call('salesforce_admin_propose_layout_changes', {
      object: 'Site_Visit__c',
      layout: 'Site Visit Layout',
      assignTo: [{ profile: 'Standard User', recordType: 'Home Visit' }],
    });
    expect(result.isError).toBeUndefined();
    const { files } = await received();
    expect(Object.keys(files).sort()).toEqual(['package.xml', 'profiles/Standard.profile']);
    const profile = files['profiles/Standard.profile'];
    expect(profile).toContain('<layout>Site_Visit__c-Site Visit Layout</layout>');
    expect(profile).toContain('<recordType>Site_Visit__c.Home_Visit</recordType>');
    expect(profile).not.toContain('fieldPermissions');
    expect(stored().title).toBe('Site Visit: give profiles the layout “Site Visit Layout”');
    expect(stored().payload.components).toEqual([
      {
        type: 'Profile',
        name: 'Standard User',
        action: 'update',
        rows: [{ label: 'Layout for Home Visit records', value: 'Site Visit Layout' }],
      },
    ]);
  });

  it('reorders a field, replaces a related list’s columns, and adds a button and an action', async () => {
    layoutMetadata.relatedLists = [{ fields: ['NAME'], relatedList: 'Visit_Note__c.Visit__c' }];
    const result = await call('salesforce_admin_propose_layout_changes', {
      object: 'Site_Visit__c',
      layout: 'Site Visit Layout',
      move: [{ field: 'Stage__c', before: 'Name' }],
      setRelatedListColumns: [{ relatedList: 'Visit_Notes__r', fields: ['NAME', 'Body__c'] }],
      addButtons: ['Print_Visit'],
      addActions: [{ name: 'Site_Visit__c.Log_Outcome' }],
    });
    expect(result.isError).toBeUndefined();
    const { files } = await received();
    const layout = files['layouts/Site_Visit__c-Site Visit Layout.layout'];
    expect(layout.indexOf('<field>Stage__c</field>')).toBeLessThan(
      layout.indexOf('<field>Name</field>')
    );
    expect(layout).toMatch(/<fields>NAME<\/fields>\s*<fields>Body__c<\/fields>/);
    expect(layout).toContain('<customButtons>Print_Visit</customButtons>');
    expect(layout).toContain('<actionName>Site_Visit__c.Log_Outcome</actionName>');
    // The layout had no action list of its own, and the proposal says what that means.
    expect(text(result)).toContain('will show only the ones listed here');
  });

  it('refuses to give a profile the layout it already sees', async () => {
    const result = await call('salesforce_admin_propose_layout_changes', {
      object: 'Site_Visit__c',
      layout: 'Site Visit Layout',
      assignTo: [{ profile: 'Standard User' }],
    });
    expect(text(result)).toContain(
      'Standard User already sees “Site Visit Layout” for records with no record type.'
    );
    expect(store.createChangeRequest).not.toHaveBeenCalled();
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

describe('salesforce_admin_list_permission_sets, for profiles', () => {
  it('lists the org’s profiles with how many people are on each', async () => {
    const result = await call('salesforce_admin_list_permission_sets', { profiles: true });
    expect(text(result)).toBe('• Standard User — 4 active people, Salesforce licence');
  });

  it('reads what a profile grants — records, fields on an object, tabs — and who is on it', async () => {
    objectRows = [{ SobjectType: 'Site_Visit__c', PermissionsRead: true, PermissionsEdit: true }];
    fieldAccessRows = [
      { Field: 'Site_Visit__c.Stage__c', PermissionsRead: true, PermissionsEdit: true },
    ];
    tabRows = [{ Name: 'Site_Visit__c', Visibility: 'DefaultOn' }];
    const result = await call('salesforce_admin_list_permission_sets', {
      profile: 'Standard User',
      object: 'Site_Visit__c',
    });
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('Profile Standard User');
    expect(text(result)).toContain('• Site_Visit__c: read, edit');
    expect(text(result)).toContain('• Site_Visit__c.Stage__c: read and edit');
    expect(text(result)).toContain('• Grace Hopper (grace@acme.org)');
    // Its access is read from the profile's own permission set.
    expect(
      requests.some((r) => decodeURIComponent(r.query).includes(`ParentId = '${PROFILE_SET}'`))
    ).toBe(true);
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

  it('gives a profile field access through the profile’s own permission set', async () => {
    const result = await call('salesforce_admin_propose_permission_set', {
      profile: 'Standard User',
      fields: [{ object: 'Site_Visit__c', field: 'stage__c', edit: true }],
    });
    expect(result.isError).toBeUndefined();
    expect(deploys()).toHaveLength(0);
    expect(stored().title).toBe('The profile Standard User: more access');
    expect(stored().payload.components[0]).toMatchObject({
      type: 'Profile',
      name: 'Standard User',
    });
    expect(stored().payload.dataSteps).toContainEqual({
      kind: 'field-permission',
      permissionSetId: PROFILE_SET,
      permissionSetName: 'the profile Standard User',
      object: 'Site_Visit__c',
      field: 'Stage__c',
      read: true,
      edit: true,
    });
  });

  it('says so when the profile is not in the org, or when two things are named to change', async () => {
    const missing = await call('salesforce_admin_propose_permission_set', {
      profile: 'Nobody',
      fields: [{ object: 'Site_Visit__c', field: 'Stage__c' }],
    });
    expect(text(missing)).toContain('No profile "Nobody" in this org.');
    const both = await call('salesforce_admin_propose_permission_set', {
      profile: 'Standard User',
      permissionSet: 'Program Staff',
      fields: [{ object: 'Site_Visit__c', field: 'Stage__c' }],
    });
    expect(text(both)).toContain('Name one of permissionSet');
    expect(store.createChangeRequest).not.toHaveBeenCalled();
  });

  it('takes field access away only where it is named: all of it, or edit alone', async () => {
    fieldAccessRows = [
      { Field: 'Site_Visit__c.Stage__c', PermissionsRead: true, PermissionsEdit: true },
      { Field: 'Site_Visit__c.Visit_Date__c', PermissionsRead: true, PermissionsEdit: true },
    ];
    const result = await call('salesforce_admin_propose_permission_set', {
      permissionSet: 'Program Staff',
      removeFields: [
        { object: 'Site_Visit__c', field: 'stage__c' },
        { object: 'Site_Visit__c', field: 'Visit_Date__c', keepRead: true },
      ],
    });
    expect(result.isError).toBeUndefined();
    expect(stored().title).toBe('Program_Staff: less access');
    expect(stored().payload.dataSteps).toEqual([
      expect.objectContaining({ field: 'Stage__c', read: false, edit: false, remove: 'all' }),
      expect.objectContaining({ field: 'Visit_Date__c', read: true, edit: false, remove: 'edit' }),
    ]);
    expect(stored().payload.components[0].rows).toEqual([
      { label: 'Site_Visit__c.Stage__c', value: 'none', from: 'read and edit' },
      { label: 'Site_Visit__c.Visit_Date__c', value: 'read', from: 'read and edit' },
    ]);
    expect(text(result)).toContain('people keep any access another set or their profile gives');
  });

  it('takes records’ access and a tab away after the field access that stands on them', async () => {
    objectRows = [
      {
        SobjectType: 'Site_Visit__c',
        PermissionsRead: true,
        PermissionsCreate: true,
        PermissionsEdit: true,
        PermissionsDelete: true,
      },
    ];
    fieldAccessRows = [
      { Field: 'Site_Visit__c.Stage__c', PermissionsRead: true, PermissionsEdit: false },
    ];
    tabRows = [{ Name: 'Site_Visit__c', Visibility: 'DefaultOn' }];
    const result = await call('salesforce_admin_propose_permission_set', {
      profile: 'Standard User',
      removeObjects: [{ object: 'Site Visit', rights: ['edit'] }],
      removeFields: [{ object: 'Site_Visit__c', field: 'Stage__c' }],
      removeTabs: ['Site_Visit__c'],
    });
    expect(result.isError).toBeUndefined();
    expect(stored().title).toBe('The profile Standard User: less access');
    expect(stored().payload.dataSteps).toEqual([
      expect.objectContaining({ kind: 'field-permission', field: 'Stage__c', remove: 'all' }),
      // Delete stands on edit, so it goes with it; read and create stay.
      expect.objectContaining({
        kind: 'object-permission',
        object: 'Site_Visit__c',
        read: true,
        create: true,
        edit: false,
        delete: false,
        remove: true,
      }),
      expect.objectContaining({ kind: 'tab-visibility', tab: 'Site_Visit__c', remove: true }),
    ]);
    expect(stored().payload.components[0].rows).toEqual([
      { label: 'Site_Visit__c.Stage__c', value: 'none', from: 'read' },
      { label: 'Site_Visit__c records', value: 'read, create', from: 'read, create, edit, delete' },
      { label: 'Site_Visit__c tab', value: 'hidden', from: 'shown' },
    ]);
  });

  it('refuses to take away records’ access or a tab it does not give', async () => {
    const result = await call('salesforce_admin_propose_permission_set', {
      permissionSet: 'Program Staff',
      removeObjects: [{ object: 'Site_Visit__c' }],
      removeTabs: ['Site_Visit__c'],
    });
    expect(text(result)).toContain('gives no access to Site_Visit__c records to take away');
    expect(text(result)).toContain('does not show the Site_Visit__c tab');
    expect(store.createChangeRequest).not.toHaveBeenCalled();
  });

  it('refuses a removal that changes nothing, one from a new set, and a field given and taken at once', async () => {
    const none = await call('salesforce_admin_propose_permission_set', {
      permissionSet: 'Program Staff',
      removeFields: [{ object: 'Site_Visit__c', field: 'Stage__c' }],
    });
    expect(text(none)).toContain('gives no access to Site_Visit__c.Stage__c to take away');
    const fresh = await call('salesforce_admin_propose_permission_set', {
      newSet: { label: 'Site Visit Editors' },
      removeFields: [{ object: 'Site_Visit__c', field: 'Stage__c' }],
    });
    expect(text(fresh)).toContain('has no access to take away');
    const twice = await call('salesforce_admin_propose_permission_set', {
      permissionSet: 'Program Staff',
      fields: [{ object: 'Site_Visit__c', field: 'Stage__c' }],
      removeFields: [{ object: 'Site_Visit__c', field: 'stage__c' }],
    });
    expect(text(twice)).toContain('is both given and taken away');
    expect(store.createChangeRequest).not.toHaveBeenCalled();
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

describe('apps a permission set or profile may open', () => {
  it('lets a set open an app, and stops it, as one access row each', async () => {
    const give = await call('salesforce_admin_propose_permission_set', {
      permissionSet: 'Program Staff',
      apps: ['Sales'],
    });
    expect(give.isError).toBeUndefined();
    expect(stored().payload.dataSteps).toEqual([
      {
        kind: 'app-visibility',
        permissionSetId: '0PS000000000001AAA',
        permissionSetName: 'Program_Staff',
        appId: APP,
        app: 'Sales',
      },
    ]);
    store.createChangeRequest.mockClear();
    opensApp = true;
    const take = await call('salesforce_admin_propose_permission_set', {
      profile: 'Standard User',
      removeApps: ['Sales'],
    });
    expect(take.isError).toBeUndefined();
    expect(stored().payload.dataSteps).toEqual([
      expect.objectContaining({ kind: 'app-visibility', appId: APP, remove: true }),
    ]);
    expect(stored().payload.components[0].rows).toEqual([
      { label: 'Sales app', value: 'may not', from: 'may open' },
    ]);
  });

  it('refuses an app the org does not have, and one for a set that does not exist yet', async () => {
    const missing = await call('salesforce_admin_propose_permission_set', {
      permissionSet: 'Program Staff',
      apps: ['Nowhere'],
    });
    expect(text(missing)).toContain('No app "Nowhere" in this org.');
    const fresh = await call('salesforce_admin_propose_permission_set', {
      newSet: { label: 'Site Visit Editors' },
      apps: ['Sales'],
    });
    expect(text(fresh)).toContain('once it exists');
    expect(store.createChangeRequest).not.toHaveBeenCalled();
  });
});

describe('salesforce_admin_propose_permission_set_details', () => {
  it('renames a set, keeping its API name', async () => {
    const result = await call('salesforce_admin_propose_permission_set_details', {
      permissionSet: 'Program Staff',
      label: 'Programme Staff',
      description: 'People who run programmes',
    });
    expect(result.isError).toBeUndefined();
    expect(deploys()).toHaveLength(0);
    expect(stored().payload.dataSteps).toEqual([
      {
        kind: 'permission-set-details',
        permissionSetId: '0PS000000000001AAA',
        permissionSetName: 'Program_Staff',
        label: 'Programme Staff',
        description: 'People who run programmes',
      },
    ]);
    expect(stored().payload.components[0].rows).toContainEqual({
      label: 'Label',
      value: 'Programme Staff',
      from: 'Program Staff',
    });
  });

  it('deletes a set nobody has, and refuses one people still have', async () => {
    const result = await call('salesforce_admin_propose_permission_set_details', {
      permissionSet: 'Program Staff',
      delete: true,
    });
    expect(result.isError).toBeUndefined();
    expect(stored().payload.components[0]).toMatchObject({ action: 'delete' });
    expect(stored().payload.dataSteps).toEqual([
      expect.objectContaining({ kind: 'permission-set-delete' }),
    ]);
    store.createChangeRequest.mockClear();
    assigned = ['005000000000002AAA', '005000000000003AAA'];
    const held = await call('salesforce_admin_propose_permission_set_details', {
      permissionSet: 'Program Staff',
      delete: true,
    });
    expect(text(held)).toContain('2 people have Program_Staff');
    expect(store.createChangeRequest).not.toHaveBeenCalled();
  });

  it('wants one thing: a change, or a delete', async () => {
    const result = await call('salesforce_admin_propose_permission_set_details', {
      permissionSet: 'Program Staff',
      label: 'X',
      delete: true,
    });
    expect(text(result)).toContain('one or the other');
  });
});

describe('salesforce_admin_propose_system_permissions', () => {
  it('turns one on in a set and one off, by Setup name or API name, each its own write', async () => {
    systemOn = ['PermissionsViewSetup'];
    const result = await call('salesforce_admin_propose_system_permissions', {
      permissionSet: 'Program Staff',
      enable: ['manage users'],
      disable: ['ViewSetup'],
    });
    expect(result.isError).toBeUndefined();
    expect(deploys()).toHaveLength(0);
    expect(stored()).toMatchObject({ kind: 'security' });
    expect(stored().payload.dataSteps).toEqual([
      {
        kind: 'system-permission',
        permissionSetId: '0PS000000000001AAA',
        permissionSetName: 'Program_Staff',
        target: 'PermissionSet',
        targetId: '0PS000000000001AAA',
        permission: 'PermissionsManageUsers',
        label: 'Manage Users',
        enabled: true,
      },
      expect.objectContaining({ permission: 'PermissionsViewSetup', enabled: false }),
    ]);
    expect(stored().payload.components[0].rows).toEqual([
      { label: 'Manage Users', value: 'on', from: 'off' },
      { label: 'View Setup and Configuration', value: 'off', from: 'on' },
    ]);
  });

  it('writes a profile’s to the profile’s own row', async () => {
    const result = await call('salesforce_admin_propose_system_permissions', {
      profile: 'Standard User',
      enable: ['Modify All Data'],
    });
    expect(result.isError).toBeUndefined();
    expect(stored().payload.dataSteps).toEqual([
      expect.objectContaining({
        target: 'Profile',
        targetId: '00e000000000001AAA',
        permission: 'PermissionsModifyAllData',
        permissionSetName: 'the profile Standard User',
      }),
    ]);
  });

  it('refuses a permission the org does not have, naming the near ones, and one already so', async () => {
    const unknown = await call('salesforce_admin_propose_system_permissions', {
      permissionSet: 'Program Staff',
      enable: ['Manage'],
    });
    expect(text(unknown)).toContain('did you mean Manage Users (ManageUsers)');
    const already = await call('salesforce_admin_propose_system_permissions', {
      permissionSet: 'Program Staff',
      disable: ['Manage Users'],
    });
    expect(text(already)).toContain('already has “Manage Users” off');
    expect(store.createChangeRequest).not.toHaveBeenCalled();
  });

  it('is its own capability: not offered with the permission-set one alone', async () => {
    const handlers = await tools(['sfa-read', 'sfa-permissions']);
    expect(handlers.has('salesforce_admin_propose_permission_set')).toBe(true);
    expect(handlers.has('salesforce_admin_propose_system_permissions')).toBe(false);
    expect(handlers.has('salesforce_admin_propose_profile_login')).toBe(false);
    expect(handlers.has('salesforce_admin_propose_profile')).toBe(false);
  });
});

describe('salesforce_admin_propose_profile_login', () => {
  it('adds an IP range to those the profile has, as a Profile file holding only the ranges', async () => {
    const result = await call('salesforce_admin_propose_profile_login', {
      profile: 'Standard User',
      addIpRanges: [{ start: '198.51.100.0', end: '198.51.100.255', description: 'VPN' }],
    });
    expect(result.isError).toBeUndefined();
    const { files } = await received();
    const profile = files['profiles/Standard.profile'];
    expect(profile.match(/<loginIpRanges>/g)).toHaveLength(2);
    expect(profile).toContain('<startAddress>203.0.113.0</startAddress>');
    expect(profile).toContain('<startAddress>198.51.100.0</startAddress>');
    expect(profile).not.toContain('objectPermissions');
    expect(profile).not.toContain('loginHours');
    expect(stored().payload.preconditions).toEqual([
      expect.objectContaining({ kind: 'component-unchanged', type: 'Profile', name: 'Standard' }),
    ]);
    expect(stored().payload.components[0].rows).toEqual([
      {
        label: 'Login IP ranges',
        value: '203.0.113.0–203.0.113.255 (Office); 198.51.100.0–198.51.100.255 (VPN)',
        from: '203.0.113.0–203.0.113.255 (Office)',
      },
    ]);
  });

  it('sets login hours only with every day given, and lifts them with an empty element', async () => {
    const some = await call('salesforce_admin_propose_profile_login', {
      profile: 'Standard User',
      loginHours: [{ day: 'monday', start: '08:00', end: '18:00' }],
    });
    expect(text(some)).toContain('Give every day');
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const all = await call('salesforce_admin_propose_profile_login', {
      profile: 'Standard User',
      loginHours: days.map((day) => ({ day, start: '07:30', end: '24:00' })),
    });
    expect(all.isError).toBeUndefined();
    const set = (await received()).files['profiles/Standard.profile'];
    expect(set).toContain('<sundayStart>450</sundayStart>');
    expect(set).toContain('<sundayEnd>1440</sundayEnd>');
    expect(set).not.toContain('loginIpRanges');

    const lifted = await call('salesforce_admin_propose_profile_login', {
      profile: 'Standard User',
      clearLoginHours: true,
    });
    expect(lifted.isError).toBeUndefined();
    expect((await received(1)).files['profiles/Standard.profile']).toContain('<loginHours/>');
  });

  it('refuses a range that is not one, one it does not have, and removing the last', async () => {
    const bad = await call('salesforce_admin_propose_profile_login', {
      profile: 'Standard User',
      addIpRanges: [
        { start: '10.0.0.9', end: '10.0.0.1' },
        { start: 'office', end: '10.0.0.1' },
      ],
      removeIpRanges: [{ start: '192.0.2.0', end: '192.0.2.255' }],
    });
    expect(text(bad)).toContain('has no login range 192.0.2.0–192.0.2.255');
    expect(text(bad)).toContain('10.0.0.9–10.0.0.1 ends before it starts');
    expect(text(bad)).toContain('office–10.0.0.1 is not a range of IP addresses');
    const last = await call('salesforce_admin_propose_profile_login', {
      profile: 'Standard User',
      removeIpRanges: [{ start: '203.0.113.0', end: '203.0.113.255' }],
    });
    expect(text(last)).toContain('remove the last range in Setup');
    expect(store.createChangeRequest).not.toHaveBeenCalled();
  });
});

describe('salesforce_admin_propose_profile', () => {
  it('creates a profile as a copy of one, whole, marked custom', async () => {
    const result = await call('salesforce_admin_propose_profile', {
      name: 'Program Staff Profile',
      copyFrom: 'Standard User',
    });
    expect(result.isError).toBeUndefined();
    const { files } = await received();
    const profile = files['profiles/Program Staff Profile.profile'];
    expect(profile).toContain('<custom>true</custom>');
    expect(profile).toContain('<userLicense>Salesforce</userLicense>');
    expect(profile).toContain('<object>Site_Visit__c</object>');
    expect(stored().payload.preconditions).toEqual([
      { kind: 'profile-absent', name: 'Program Staff Profile' },
    ]);
  });

  it('creates one from a licence alone, and refuses a name or a licence that will not do', async () => {
    const result = await call('salesforce_admin_propose_profile', {
      name: 'Volunteers',
      userLicense: 'Salesforce',
    });
    expect(result.isError).toBeUndefined();
    const profile = (await received()).files['profiles/Volunteers.profile'];
    expect(profile).toContain('<userLicense>Salesforce</userLicense>');
    expect(profile).not.toContain('objectPermissions');
    store.createChangeRequest.mockClear();
    const taken = await call('salesforce_admin_propose_profile', {
      name: 'Standard User',
      userLicense: 'Salesforce',
    });
    expect(text(taken)).toContain('already a profile Standard User');
    const licence = await call('salesforce_admin_propose_profile', {
      name: 'Volunteers',
      userLicense: 'Nope',
    });
    expect(text(licence)).toContain('no user licence "Nope"');
    expect(store.createChangeRequest).not.toHaveBeenCalled();
  });
});

describe('salesforce_admin_list_permission_sets, with security', () => {
  it('lists a profile’s system permissions, login hours and IP ranges', async () => {
    systemOn = ['PermissionsViewSetup'];
    const result = await call('salesforce_admin_list_permission_sets', {
      profile: 'Standard User',
      security: true,
    });
    expect(text(result)).toContain('System permissions:\n• View Setup and Configuration');
    expect(text(result)).toContain('Login hours: Mon 08:00–18:00');
    expect(text(result)).toContain('• 203.0.113.0–203.0.113.255 (Office)');
  });
});

describe('a permission set in a permission set group', () => {
  beforeEach(() => {
    inGroups = ['PACE Staff'];
  });

  it('is changed like any other set, a row at a time, and the proposal says who else gets it', async () => {
    const result = await call('salesforce_admin_propose_permission_set', {
      permissionSet: 'Program Staff',
      fields: [{ object: 'Site_Visit__c', field: 'Visit_Date__c' }],
    });
    expect(result.isError).toBeUndefined();
    // No whole-set deploy: the set keeps everything it has, untouched.
    expect(deploys()).toHaveLength(0);
    expect(stored().payload.dataSteps).toContainEqual(
      expect.objectContaining({ kind: 'field-permission', field: 'Visit_Date__c', read: true })
    );
    expect(text(result)).toContain(
      'is in the permission set group PACE Staff: everyone with the group gets this change'
    );
  });

  it('is named with its groups when the set is read', async () => {
    const result = await call('salesforce_admin_list_permission_sets', {
      permissionSet: 'Program Staff',
    });
    expect(text(result)).toContain('In the permission set group: PACE Staff');
  });
});

describe('a permission set group, named where a permission set is asked for', () => {
  beforeEach(() => {
    // The group's own row: what it grants in total, which Salesforce derives.
    isGroup = true;
  });

  it('is refused for a change, naming the sets in it to change instead', async () => {
    const result = await call('salesforce_admin_propose_permission_set', {
      permissionSet: 'Program Staff',
      fields: [{ object: 'Site_Visit__c', field: 'Visit_Date__c' }],
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Program_Staff is a permission set group');
    expect(text(result)).toContain(
      'Make the change in one of its sets, and everyone with the group gets it: Visit Fields (Visit_Fields), Visit Objects (Visit_Objects).'
    );
    expect(store.createChangeRequest).not.toHaveBeenCalled();
  });

  it('is refused the same way for access given with new fields, and for system permissions', async () => {
    const fields = await call('salesforce_admin_propose_fields', {
      object: 'Site_Visit__c',
      fields: [{ label: 'Outcome', type: 'Text', length: 80 }],
      grantTo: [{ permissionSet: 'Program Staff' }],
    });
    expect(text(fields)).toContain('is a permission set group');
    const system = await call('salesforce_admin_propose_system_permissions', {
      permissionSet: 'Program Staff',
      enable: ['Manage Users'],
    });
    expect(text(system)).toContain('is a permission set group');
    expect(store.createChangeRequest).not.toHaveBeenCalled();
  });

  it('is listed apart from the permission sets', async () => {
    const result = await call('salesforce_admin_list_permission_sets', {});
    expect(text(result)).toContain('Permission set groups');
    expect(text(result)).toContain('• PACE Staff (PACE_Staff)');
  });

  it('can be read: what it grants in total, said to be a group, with its sets', async () => {
    const result = await call('salesforce_admin_list_permission_sets', {
      permissionSet: 'Program Staff',
    });
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('Permission set group Program_Staff');
    expect(text(result)).toContain('It cannot be changed directly');
    expect(text(result)).toContain(
      'Its permission sets: Visit Fields (Visit_Fields), Visit Objects (Visit_Objects)'
    );
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

  it('gives an existing set a record type by deploying the set whole, as read, with it added', async () => {
    const result = await call('salesforce_admin_propose_permission_set', {
      permissionSet: 'Program Staff',
      recordTypes: ['Site_Visit__c.Home Visit'],
    });
    expect(result.isError).toBeUndefined();
    const set = (await received()).files['permissionsets/Program_Staff.permissionset'];
    // Everything it granted stays, system permission and all.
    expect(set).toContain('<object>Site_Visit__c</object>');
    expect(set).toContain('<name>ViewSetup</name>');
    expect(set).toContain('<recordType>Opportunity.Grant</recordType>');
    expect(set).toContain('<recordType>Site_Visit__c.Home_Visit</recordType>');
    expect(stored().payload.preconditions).toEqual([
      {
        kind: 'component-unchanged',
        type: 'PermissionSet',
        object: '',
        name: 'Program_Staff',
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
    const already = await call('salesforce_admin_propose_permission_set', {
      permissionSet: 'Program Staff',
      recordTypes: ['Opportunity.Grant'],
    });
    expect(text(already)).toContain('may already use the record type Opportunity.Grant');
  });

  it('gives a new permission set its record types in its own file', async () => {
    const created = await call('salesforce_admin_propose_permission_set', {
      newSet: { label: 'Site Visit Home Visits' },
      recordTypes: ['Site_Visit__c.Home Visit'],
    });
    expect(created.isError).toBeUndefined();
    const set = (await received()).files['permissionsets/Site_Visit_Home_Visits.permissionset'];
    expect(set).toContain('<recordType>Site_Visit__c.Home_Visit</recordType>');
  });
});

describe('salesforce_admin_propose_report_type', () => {
  it('joins down the child relationship, one section per object, and deploys it alone', async () => {
    const result = await call('salesforce_admin_propose_report_type', {
      label: 'Visits with Notes',
      baseObject: 'Site Visit',
      joins: [{ relationship: 'visit_notes__r', outerJoin: true }],
    });
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('Visits_with_Notes__c');
    const { files } = await received();
    expect(Object.keys(files).sort()).toEqual([
      'package.xml',
      'reportTypes/Visits_with_Notes.reportType',
    ]);
    const xml = files['reportTypes/Visits_with_Notes.reportType'];
    expect(xml).toContain('<baseObject>Site_Visit__c</baseObject>');
    expect(xml).toContain('<relationship>Visit_Notes__r</relationship>');
    expect(xml).toContain('<table>Site_Visit__c.Visit_Notes__r</table>');
    expect(xml).toContain('<field>Body__c</field>');
    expect(files['package.xml']).toContain('<name>ReportType</name>');
    expect(stored().kind).toBe('report_type');
    expect(stored().payload.preconditions).toEqual([
      { kind: 'report-type-absent', name: 'Visits_with_Notes' },
    ]);
    expect(stored().payload.components[0]).toMatchObject({
      type: 'ReportType',
      name: 'Visits_with_Notes__c',
      action: 'create',
    });
  });

  it('refuses a report type that exists, and a relationship the object does not have', async () => {
    const taken = await call('salesforce_admin_propose_report_type', {
      label: 'Site Visits',
      baseObject: 'Site_Visit__c',
    });
    expect(text(taken)).toContain('there is already a report type Site_Visits__c');
    const nowhere = await call('salesforce_admin_propose_report_type', {
      label: 'Visit Things',
      baseObject: 'Site_Visit__c',
      joins: [{ relationship: 'Things__r' }],
    });
    expect(text(nowhere)).toContain('Site_Visit__c has no child relationship Things__r');
    expect(store.createChangeRequest).not.toHaveBeenCalled();
    expect(deploys()).toHaveLength(0);
  });
});

describe('report reads', () => {
  it('lists report types, one type’s columns and scopes, and the folders', async () => {
    const list = await call('salesforce_admin_list_report_types', { search: 'visit' });
    expect(text(list)).toBe('Other Reports:\n  Site Visits — Site_Visits__c');
    const one = await call('salesforce_admin_list_report_types', { type: 'Opportunity' });
    expect(text(one)).toContain('AMOUNT — Amount (currency)');
    expect(text(one)).toContain('organization — All opportunities');
    const folders = await call('salesforce_admin_list_report_folders', {});
    expect(text(folders)).toBe('Program Reports — Program_Reports (Public)');
  });
});

describe('salesforce_admin_propose_report', () => {
  it('builds a summary report in an existing folder, column names spelled the type’s way', async () => {
    const result = await call('salesforce_admin_propose_report', {
      name: 'Open Pipeline by Stage',
      reportType: 'Opportunity',
      format: 'Summary',
      columns: [{ field: 'opportunity_name' }, { field: 'AMOUNT', aggregates: ['Sum'] }],
      groupingsDown: [{ field: 'STAGE_NAME' }],
      dateFilter: { column: 'close_date', interval: 'INTERVAL_CURRENTQ' },
      scope: 'organization',
      folder: 'Program Reports',
    });
    expect(result.isError).toBeUndefined();
    const { files } = await received();
    expect(Object.keys(files).sort()).toEqual([
      'package.xml',
      'reports/Program_Reports/Open_Pipeline_by_Stage.report',
    ]);
    const xml = files['reports/Program_Reports/Open_Pipeline_by_Stage.report'];
    expect(xml).toContain('<field>OPPORTUNITY_NAME</field>');
    expect(xml).toContain('<dateColumn>CLOSE_DATE</dateColumn>');
    expect(xml).toContain('<format>Summary</format>');
    expect(files['package.xml']).toContain(
      '<members>Program_Reports/Open_Pipeline_by_Stage</members>'
    );
    expect(stored().kind).toBe('report');
    expect(stored().payload.preconditions).toEqual([
      { kind: 'report-absent', folder: 'Program_Reports', name: 'Open_Pipeline_by_Stage' },
    ]);
  });

  it('saves a rolling date range as a filter on the date column, and says it rolls', async () => {
    const result = await call('salesforce_admin_propose_report', {
      name: 'Pipeline, rolling year',
      reportType: 'Opportunity',
      columns: [{ field: 'OPPORTUNITY_NAME' }],
      dateFilter: { column: 'close_date', relative: 'last 12 months' },
      folder: 'Program Reports',
    });
    expect(result.isError).toBeUndefined();
    const xml = (await received()).files['reports/Program_Reports/Pipeline_rolling_year.report'];
    expect(xml).toMatch(
      /<column>CLOSE_DATE<\/column>[\s\S]*<operator>equals<\/operator>\s*<value>LAST_N_MONTHS:12<\/value>/
    );
    expect(xml).not.toContain('<timeFrameFilter>');
    expect(stored().payload.components[0].rows).toContainEqual({
      label: 'Date range',
      value:
        'CLOSE_DATE: last 12 months (LAST_N_MONTHS:12), counted from the day the report is run',
    });
  });

  it('creates a new folder with a report on a custom report type', async () => {
    const result = await call('salesforce_admin_propose_report', {
      name: 'All Visits',
      reportType: 'Site_Visits__c',
      columns: [{ field: 'Site_Visit__c$Name' }],
      newFolder: { label: 'Field Team', access: 'Hidden' },
    });
    expect(result.isError).toBeUndefined();
    const { files } = await received();
    expect(files['reports/Field_Team-meta.xml']).toContain('<accessType>Hidden</accessType>');
    expect(stored().payload.components.map((c: { type: string }) => c.type)).toEqual([
      'ReportFolder',
      'Report',
    ]);
    expect(stored().payload.preconditions[0]).toEqual({
      kind: 'report-folder-absent',
      folder: 'Field_Team',
    });
  });

  it('names a report type the org does not have, from Salesforce’s 400', async () => {
    const result = await call('salesforce_admin_propose_report', {
      name: 'Referrals',
      reportType: 'No_Such_Type__c',
      columns: [{ field: 'X$Name' }],
      folder: 'Program_Reports',
    });
    expect(text(result)).toContain('There is no report type No_Such_Type__c');
    expect(store.createChangeRequest).not.toHaveBeenCalled();
  });

  it('names a custom report type’s columns the way its report file does, and takes either spelling', async () => {
    const listed = text(
      await call('salesforce_admin_list_report_types', { type: 'Site_Visits__c' })
    );
    expect(listed).toContain('Site_Visit__c$Name — Visit Number (string)');
    // A lookup path stays in the field; a child relationship joins the table.
    expect(listed).toContain('Site_Visit__c$Owner.Email — Owner: Email (email)');
    // A joined table's column, described by its object, is named by the join path.
    expect(listed).toContain('Site_Visit__c.Visit_Notes__r$Body__c — Body (textarea)');
    expect(listed).not.toContain('Visit_Note__c$Body__c');
    // A lookup the layout offers as itself is named as itself, not by its name field.
    expect(listed).toContain('Site_Visit__c$Owner — Owner: Full Name (string)');

    const result = await call('salesforce_admin_propose_report', {
      name: 'Visits and Owners',
      reportType: 'Site_Visits__c',
      columns: [
        { field: 'Site_Visit__c.Name' },
        { field: 'Site_Visit__c.Owner.Email' },
        { field: 'Site_Visit__c.Visit_Notes__r$Body__c' },
        { field: 'Site_Visit__c.Owner.Name' },
      ],
      filters: [{ column: 'site_visit__c.owner.email', operator: 'contains', value: '@acme' }],
      folder: 'Program_Reports',
    });
    expect(result.isError).toBeUndefined();
    const { files } = await received();
    const xml = files['reports/Program_Reports/Visits_and_Owners.report'];
    expect(xml).toContain('<field>Site_Visit__c$Name</field>');
    expect(xml).toContain('<field>Site_Visit__c$Owner.Email</field>');
    expect(xml).toContain('<field>Site_Visit__c.Visit_Notes__r$Body__c</field>');
    expect(xml).toContain('<field>Site_Visit__c$Owner</field>');
    expect(xml).toContain('<column>Site_Visit__c$Owner.Email</column>');
  });

  it('refuses a custom report type’s column it does not have, before anything is stored', async () => {
    const result = await call('salesforce_admin_propose_report', {
      name: 'Bad Visits',
      reportType: 'Site_Visits__c',
      columns: [{ field: 'Site_Visit__c.Owner$Email' }],
      folder: 'Program_Reports',
    });
    expect(text(result)).toContain('Site_Visits__c has no column Site_Visit__c.Owner$Email');
    expect(store.createChangeRequest).not.toHaveBeenCalled();
    expect(deploys()).toHaveLength(0);
  });

  it('refuses unknown columns, a taken name, and a missing folder, before anything is stored', async () => {
    const unknown = await call('salesforce_admin_propose_report', {
      name: 'Bad',
      reportType: 'Opportunity',
      columns: [{ field: 'NOPE' }],
      folder: 'Program_Reports',
    });
    expect(text(unknown)).toContain('Opportunity has no column NOPE');
    const taken = await call('salesforce_admin_propose_report', {
      name: 'Pipeline',
      reportType: 'Opportunity',
      columns: [{ field: 'AMOUNT' }],
      folder: 'Program_Reports',
    });
    expect(text(taken)).toContain('already has a report Pipeline');
    const nowhere = await call('salesforce_admin_propose_report', {
      name: 'Lost',
      reportType: 'Opportunity',
      columns: [{ field: 'AMOUNT' }],
      folder: 'Nowhere',
    });
    expect(text(nowhere)).toContain('there is no report folder "Nowhere"');
    expect(store.createChangeRequest).not.toHaveBeenCalled();
  });
});

describe('isMissingReportType', () => {
  it('reads a 404 and Salesforce’s 400 "not a report type" as absent, and nothing else', () => {
    const failed = (status: number, errorCode: string, message: string) => ({
      ok: false as const,
      status,
      error: message,
      errors: [{ errorCode, message, fields: [] }],
    });
    expect(
      isMissingReportType(
        failed(
          400,
          'BAD_REQUEST',
          'Specify a valid report type. Accounts_with_Referrals__c is not a report type.'
        )
      )
    ).toBe(true);
    expect(isMissingReportType(failed(404, 'NOT_FOUND', 'Not found'))).toBe(true);
    expect(isMissingReportType(failed(400, 'BAD_REQUEST', 'Something else went wrong'))).toBe(
      false
    );
    expect(isMissingReportType(failed(403, 'INSUFFICIENT_ACCESS', 'No access'))).toBe(false);
    expect(isMissingReportType({ ok: true, status: 200, body: {} })).toBe(false);
  });
});

describe('salesforce_admin_propose_report_type_changes', () => {
  it('reads the report type whole, adds the fields, and deploys it with everything else as it was', async () => {
    const result = await call('salesforce_admin_propose_report_type_changes', {
      reportType: 'Site_Visits__c',
      add: [
        { section: 'visits', fields: ['visit_date__c'], checked: ['Visit_Date__c'] },
        { section: 'Regions', fields: ['Region__c'] },
      ],
    });
    expect(result.isError).toBeUndefined();
    // The read went out as one readMetadata, for the delegate to wrap.
    const read = requests.find((r) => r.path === '/services/Soap/m/68.0');
    expect(read?.body).toBe(
      '<readMetadata xmlns="http://soap.sforce.com/2006/04/metadata"><type>ReportType</type><fullNames>Site_Visits</fullNames></readMetadata>'
    );
    const { files } = await received();
    expect(Object.keys(files).sort()).toEqual([
      'package.xml',
      'reportTypes/Site_Visits.reportType',
    ]);
    const xml = files['reportTypes/Site_Visits.reportType'];
    // What was there stays, rename and all; the new columns follow it.
    expect(xml).toContain('<displayNameOverride>Visit Stage</displayNameOverride>');
    expect(xml).toContain('<description>Visits</description>');
    expect(xml.indexOf('<field>Stage__c</field>')).toBeLessThan(
      xml.indexOf('<field>Visit_Date__c</field>')
    );
    expect(xml).toMatch(
      /<checkedByDefault>true<\/checkedByDefault>\s*<field>Visit_Date__c<\/field>/
    );
    expect(xml).toContain('<masterLabel>Regions</masterLabel>');
    expect(xml).not.toContain('<fullName>');
    expect(stored().payload.preconditions).toEqual([
      {
        kind: 'component-unchanged',
        type: 'ReportType',
        object: '',
        name: 'Site_Visits',
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
    expect(stored().payload.components[0]).toMatchObject({
      type: 'ReportType',
      name: 'Site_Visits__c',
      action: 'update',
    });
  });

  it('stops the apply when the report type changed since it was read, or is gone', async () => {
    await call('salesforce_admin_propose_report_type_changes', {
      reportType: 'Site_Visits',
      add: [{ fields: ['Region__c'] }],
    });
    const [precondition] = stored().payload.preconditions;
    const access = await stubAuth.resolve();
    if (typeof access === 'string') throw new Error(access);
    const context = { subject: 'subject-1' } as unknown as MCPToolContext;
    expect(await brokenPreconditions(context, access, [precondition])).toEqual([]);
    expect(
      await brokenPreconditions(context, access, [{ ...precondition, fingerprint: 'moved' }])
    ).toEqual([
      'The report type Site_Visits__c was changed since this was proposed; propose again from what it is now.',
    ]);
    expect(
      await brokenPreconditions(context, access, [{ ...precondition, name: 'Elsewhere' }])
    ).toEqual([
      'The report type Elsewhere__c is gone — someone deleted it since this was proposed.',
    ]);
  });

  it('takes a field out and renames the report type, leaving the rest as it was', async () => {
    const result = await call('salesforce_admin_propose_report_type_changes', {
      reportType: 'Site_Visits__c',
      remove: [{ fields: ['Site_Visit__c$Stage__c'] }],
      label: 'Field Visits',
    });
    expect(result.isError).toBeUndefined();
    const xml = (await received()).files['reportTypes/Site_Visits.reportType'];
    expect(xml).not.toContain('<field>Stage__c</field>');
    expect(xml).toContain('<field>Name</field>');
    expect(xml).toContain('<label>Field Visits</label>');
    expect(stored().title).toContain('change the report type Site_Visits__c');
    expect(stored().payload.components[0].rows.map((row: { label: string }) => row.label)).toEqual([
      'Label',
      expect.stringContaining('Section'),
    ]);
  });

  it('refuses taking out a field the report type does not offer, and a change of nothing', async () => {
    const absent = await call('salesforce_admin_propose_report_type_changes', {
      reportType: 'Site_Visits',
      remove: [{ fields: ['Region__c'] }],
    });
    expect(text(absent)).toContain('Region__c (Site_Visit__c) is not in the report type');
    const nothing = await call('salesforce_admin_propose_report_type_changes', {
      reportType: 'Site_Visits',
    });
    expect(text(nothing)).toContain('Nothing in that changes the report type');
    expect(store.createChangeRequest).not.toHaveBeenCalled();
  });

  it('refuses a field already offered, one the object lacks, and a report type that is not there', async () => {
    const twice = await call('salesforce_admin_propose_report_type_changes', {
      reportType: 'Site_Visits',
      add: [{ fields: ['Name'] }],
    });
    expect(text(twice)).toContain('Name (Site_Visit__c) is already in the section “Visits”');
    const missing = await call('salesforce_admin_propose_report_type_changes', {
      reportType: 'Site_Visits',
      add: [{ fields: ['Nope__c'] }],
    });
    expect(text(missing)).toContain('Site_Visit__c has no field Nope__c');
    const nowhere = await call('salesforce_admin_propose_report_type_changes', {
      reportType: 'Elsewhere__c',
      add: [{ fields: ['Name'] }],
    });
    expect(text(nowhere)).toContain('there is no custom report type Elsewhere__c');
    expect(store.createChangeRequest).not.toHaveBeenCalled();
    expect(deploys()).toHaveLength(0);
  });
});

describe('salesforce_admin_propose_report_changes', () => {
  it('shows a report as it is built, its filters numbered', async () => {
    const shown = text(await call('salesforce_admin_get_report', { report: 'Open Pipeline' }));
    expect(shown).toContain('Program Reports / Open Pipeline (Program_Reports/Pipeline)');
    expect(shown).toContain('Report type: Opportunity');
    expect(shown).toContain('  AMOUNT (Sum)');
    expect(shown).toContain('  1. STAGE_NAME notEqual Closed Lost');
    expect(shown).toContain('Date range: CLOSE_DATE: 2025-11-11 to …');
  });

  it('makes a fixed cutoff a rolling year and adds a column, leaving the rest as it was', async () => {
    const result = await call('salesforce_admin_propose_report_changes', {
      report: 'Pipeline',
      folder: 'Program Reports',
      addColumns: [{ field: 'stage_name' }],
      dateFilter: { column: 'close_date', relative: 'LAST_N_DAYS:365' },
    });
    expect(result.isError).toBeUndefined();
    const { files } = await received();
    expect(Object.keys(files).sort()).toEqual([
      'package.xml',
      'reports/Program_Reports/Pipeline.report',
    ]);
    const xml = files['reports/Program_Reports/Pipeline.report'];
    // What the change does not name stays: the chart, the first filter, the name.
    expect(xml).toContain('<chartType>HorizontalBar</chartType>');
    expect(xml).toContain('<value>Closed Lost</value>');
    expect(xml).toContain('<name>Open Pipeline</name>');
    expect(xml).toContain('<field>STAGE_NAME</field>');
    expect(xml).toMatch(
      /<column>CLOSE_DATE<\/column>[\s\S]*<operator>equals<\/operator>\s*<value>LAST_N_DAYS:365<\/value>/
    );
    expect(xml).not.toContain('<timeFrameFilter>');
    expect(xml).not.toContain('<fullName>');
    expect(stored().kind).toBe('report');
    expect(stored().payload.components[0]).toMatchObject({
      type: 'Report',
      name: 'Program_Reports/Pipeline',
      action: 'update',
    });
    const [precondition] = stored().payload.preconditions;
    expect(precondition).toEqual({
      kind: 'component-unchanged',
      type: 'Report',
      object: '',
      name: 'Program_Reports/Pipeline',
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const access = await stubAuth.resolve();
    if (typeof access === 'string') throw new Error(access);
    const context = { subject: 'subject-1' } as unknown as MCPToolContext;
    expect(await brokenPreconditions(context, access, [precondition])).toEqual([]);
    expect(
      await brokenPreconditions(context, access, [{ ...precondition, fingerprint: 'moved' }])
    ).toEqual([
      'The report Program_Reports/Pipeline was changed since this was proposed; propose again from what it is now.',
    ]);
  });

  it('refuses a report that is not there, a column the type lacks, and a change of nothing', async () => {
    const nowhere = await call('salesforce_admin_propose_report_changes', {
      report: 'No Such Report',
      name: 'Renamed',
    });
    expect(text(nowhere)).toContain('There is no report "No Such Report"');
    const unknown = await call('salesforce_admin_propose_report_changes', {
      report: 'Pipeline',
      addColumns: [{ field: 'NOPE' }],
    });
    expect(text(unknown)).toContain('Opportunity has no column NOPE');
    const nothing = await call('salesforce_admin_propose_report_changes', {
      report: 'Pipeline',
      name: 'Open Pipeline',
    });
    expect(text(nothing)).toContain('Nothing in that changes the report');
    expect(store.createChangeRequest).not.toHaveBeenCalled();
    expect(deploys()).toHaveLength(0);
  });
});
