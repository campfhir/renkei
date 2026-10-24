/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Asking for a change to the org's setup from the CRM connector: anyone
 * connected to the org through the CRM may ask, and needs no admin
 * connection to do it. What it must guarantee: the request lands on the
 * org's admin connector (matched by My Domain) so an operator can approve
 * it; an org with no admin connector, or one that takes no changes,
 * refuses it before anything is stored; and the tool exists only for
 * someone whose CRM grant carries the read capability.
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
jest.mock('@/lib/admin-changes/notify', () => ({
  notifyOperatorsOfRequest: jest.fn(),
  notifyChangeOutcome: jest.fn(),
}));
jest.mock('@/lib/salesforce-admin/change-requests', () => ({
  ...jest.requireActual('@/lib/salesforce-admin/change-requests'),
  createRequest: jest.fn(),
}));

import type { McpServer } from '@modelcontextprotocol/server';
import { authedFetch } from '@renkei/delegate-client';
import { EMPTY_POLICY, type SalesforceOrg } from '@renkei/connector-salesforce';
import type { MCPToolContext } from '../common';
import type { SalesforceAuth } from './salesforce-auth';
import { registerSalesforceTools } from './index';
import { registerSalesforceAdminTools } from '../salesforce-admin';

const app = jest.requireMock<{ listSalesforceConnectors: jest.Mock }>('@/lib/salesforce-app');
const store = jest.requireMock<{ createRequest: jest.Mock }>(
  '@/lib/salesforce-admin/change-requests'
);
const notify = jest.requireMock<{ notifyOperatorsOfRequest: jest.Mock }>(
  '@/lib/admin-changes/notify'
);

const UAT = 'https://acme--uat.sandbox.my.salesforce.com';

const org = (key: string, myDomain: string, extra: Partial<SalesforceOrg> = {}): SalesforceOrg => ({
  key,
  name: key.toUpperCase(),
  myDomain,
  host: new URL(myDomain).host,
  sandbox: true,
  enabled: true,
  clientId: `${key}-client`,
  scopes: [],
  policy: EMPTY_POLICY,
  productionChanges: false,
  ...extra,
});

const crmAuth: SalesforceAuth = {
  kind: 'oauth',
  resolve: async () => ({
    auth: authedFetch((url, init) => fetch(url, init), 'salesforce:00D/005'),
    accountId: '00D000000000062EAA/005000000000001AAA',
    orgId: '00D000000000062EAA',
    userId: '005000000000001AAA',
    instanceUrl: UAT,
    username: 'ada@acme.org',
    connector: 'crm-uat',
    connectorName: 'CRM UAT',
    sandbox: true,
    policy: EMPTY_POLICY,
  }),
};

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function register(
  context: Partial<MCPToolContext>,
  registrar: (server: McpServer, context: MCPToolContext) => void
) {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registrar(server, {
    subject: 'subject-1',
    origin: 'https://renkei.example',
    db: {},
    ...context,
  } as unknown as MCPToolContext);
  return handlers;
}

const crm = (context: Partial<MCPToolContext>) =>
  register(context, (server, ctx) => registerSalesforceTools(server, ctx, crmAuth));

const text = (result: ToolResult) => result.content[0]?.text ?? '';

beforeEach(() => {
  jest.clearAllMocks();
  app.listSalesforceConnectors.mockImplementation(async (kind: { key: string }) =>
    kind.key === 'salesforce-admin' ? [org('uat', UAT)] : [org('crm-uat', UAT)]
  );
  store.createRequest.mockImplementation(async (_db: unknown, input: Record<string, unknown>) => ({
    id: '99999999-2222-4333-8444-555555555555',
    ...input,
  }));
});

describe('salesforce_request_admin_change', () => {
  const args = {
    title: 'Add an Outcome picklist to Site Visit',
    description: 'Site_Visit__c needs Outcome__c: Completed, No show.',
  };

  it('files the request on the org’s admin connector, and tells the operators, with no admin grant', async () => {
    const handler = crm({ salesforceScopes: ['sf-records-read'] }).get(
      'salesforce_request_admin_change'
    );
    expect(handler).toBeDefined();
    const result = await handler!({ ...args, reason: 'The program tracks outcomes now' });
    expect(result.isError).toBeUndefined();
    // Stored against the ADMIN connector's key for that org, not the CRM's.
    expect(store.createRequest.mock.calls[0][1]).toMatchObject({
      subject: 'subject-1',
      connectorKey: 'uat',
      orgId: '00D000000000062EAA',
      instanceUrl: UAT,
      title: args.title,
      description: args.description,
      reason: 'The program tracks outcomes now',
    });
    expect(notify.notifyOperatorsOfRequest).toHaveBeenCalledWith(
      expect.objectContaining({ connector: 'salesforce-admin', freeText: true })
    );
    expect(text(result)).toContain('nothing has changed in Salesforce');
  });

  it('refuses, before storing anything, when the org has no admin connector to approve it', async () => {
    app.listSalesforceConnectors.mockImplementation(async (kind: { key: string }) =>
      kind.key === 'salesforce-admin' ? [] : [org('crm-uat', UAT)]
    );
    const result = await crm({ salesforceScopes: ['sf-records-read'] }).get(
      'salesforce_request_admin_change'
    )!(args);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('no Salesforce Admin connector');
    expect(store.createRequest).not.toHaveBeenCalled();
    expect(notify.notifyOperatorsOfRequest).not.toHaveBeenCalled();
  });

  it('refuses a production org that takes no change requests', async () => {
    app.listSalesforceConnectors.mockImplementation(async (kind: { key: string }) =>
      kind.key === 'salesforce-admin'
        ? [org('uat', UAT, { sandbox: false, productionChanges: false })]
        : [org('crm-uat', UAT)]
    );
    const result = await crm({ salesforceScopes: ['sf-records-read'] }).get(
      'salesforce_request_admin_change'
    )!(args);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('does not take change requests');
    expect(store.createRequest).not.toHaveBeenCalled();
  });

  it('is not offered without the CRM read capability, nor without a CRM grant at all', async () => {
    expect(crm({ salesforceScopes: ['sf-records-write'] }).has('salesforce_request_admin_change')).toBe(
      false
    );
    expect(crm({}).has('salesforce_request_admin_change')).toBe(false);
  });
});

describe('one request tool per person', () => {
  const adminTools = (context: Partial<MCPToolContext>) =>
    register(context, (server, ctx) =>
      registerSalesforceAdminTools(server, ctx, {
        kind: 'oauth',
        resolve: async () => 'not used here',
      })
    );

  it('offers the admin connector’s own request tool only to someone without the CRM tools', () => {
    const adminOnly = adminTools({
      salesforceAdminScopes: ['sfa-read'],
      roles: ['renkei-user'],
    });
    expect(adminOnly.has('salesforce_admin_request_change')).toBe(true);
    const both = adminTools({
      salesforceAdminScopes: ['sfa-read'],
      salesforceScopes: ['sf-records-read'],
      roles: ['renkei-user'],
    });
    expect(both.has('salesforce_admin_request_change')).toBe(false);
    // They ask through the CRM instead.
    expect(
      crm({ salesforceScopes: ['sf-records-read'] }).has('salesforce_request_admin_change')
    ).toBe(true);
  });
});
