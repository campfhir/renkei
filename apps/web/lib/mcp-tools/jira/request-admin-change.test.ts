/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Asking for a change to Jira's configuration from the everyday Jira
 * connector: anyone connected to Jira may ask, with no Jira Administration
 * connection. What it must guarantee: the request is stored against the
 * site it was made on (so approving refuses to run it anywhere else),
 * nothing is stored without a Jira connection, and a person sees one
 * request tool, not two.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@renkei/db', () => ({ getDatabase: () => ({ ok: true, val: {} }) }));
jest.mock('@renkei/settings', () => ({ getPublicBaseUrl: () => null }));
jest.mock('@/lib/admin-changes/notify', () => ({
  notifyOperatorsOfRequest: jest.fn(),
  notifyChangeOutcome: jest.fn(),
}));
jest.mock('@/lib/jira-admin/change-requests', () => ({
  ...jest.requireActual('@/lib/jira-admin/change-requests'),
  createRequest: jest.fn(),
}));

import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { registerJiraTools } from './index';
import { oauthJiraAuth } from './jira-auth';
import { registerRequestAdminChangeTool } from './request-admin-change';
import { registerJiraAdminTools } from '../jira-admin';

const store = jest.requireMock<{ createRequest: jest.Mock }>('@/lib/jira-admin/change-requests');

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function fakeServer() {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  return { handlers, server };
}

const CONNECTED = {
  subject: 'subject-1',
  origin: 'https://renkei.example',
  siteUrl: 'https://acme.atlassian.net',
  apiBaseUrl: 'https://api.atlassian.com/ex/jira/cloud-1',
  jiraAuth: { kind: 'oauth' },
} as unknown as MCPToolContext;

const text = (result: ToolResult) => result.content[0]?.text ?? '';
const args = {
  title: 'Add a Vendor option to the Source field in OPS',
  description: 'The Source field in OPS needs a Vendor option.',
};

beforeEach(() => {
  jest.clearAllMocks();
  store.createRequest.mockImplementation(async (input: Record<string, unknown>) => ({
    id: '99999999-2222-4333-8444-555555555555',
    ...input,
  }));
});

describe('jira_request_admin_change', () => {
  it('stores the request against the site it was made on, with no Jira Administration grant', async () => {
    const { handlers, server } = fakeServer();
    registerRequestAdminChangeTool(server, CONNECTED);
    const result = await handlers.get('jira_request_admin_change')!({
      ...args,
      reason: 'Procurement tags vendor tickets',
    });
    expect(result.isError).toBeUndefined();
    expect(store.createRequest.mock.calls[0][0]).toMatchObject({
      subject: 'subject-1',
      cloudId: 'cloud-1',
      siteUrl: 'https://acme.atlassian.net',
      title: args.title,
      description: args.description,
      reason: 'Procurement tags vendor tickets',
    });
    expect(text(result)).toContain('nothing has changed in Jira');
    expect(text(result)).toContain(
      'https://renkei.example/jira-admin/changes/99999999-2222-4333-8444-555555555555'
    );
  });

  it('stores nothing without a Jira connection', async () => {
    const { handlers, server } = fakeServer();
    registerRequestAdminChangeTool(server, { ...CONNECTED, jiraAuth: null });
    const result = await handlers.get('jira_request_admin_change')!(args);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Jira is not connected');
    expect(store.createRequest).not.toHaveBeenCalled();
  });

  it('comes with the everyday Jira connector', async () => {
    const jira = fakeServer();
    await registerJiraTools(jira.server, CONNECTED, oauthJiraAuth(CONNECTED));
    expect(jira.handlers.has('jira_request_admin_change')).toBe(true);
  });
});

describe('one request tool per person', () => {
  const adminTools = async (context: MCPToolContext) => {
    const { handlers, server } = fakeServer();
    await registerJiraAdminTools(server, context, {
      kind: 'oauth',
      resolve: async () => 'not used here',
    });
    return handlers;
  };

  it('offers the admin connector’s own request tool only to someone without everyday Jira', async () => {
    const adminOnly = await adminTools({
      subject: 'subject-1',
      roles: ['renkei-user'],
    } as MCPToolContext);
    expect(adminOnly.has('jira_admin_request_change')).toBe(true);
    const both = await adminTools({ ...CONNECTED, roles: ['renkei-user'] });
    expect(both.has('jira_admin_request_change')).toBe(false);
  });
});
