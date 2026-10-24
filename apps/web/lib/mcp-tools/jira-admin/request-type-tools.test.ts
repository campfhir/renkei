/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * jira_admin_propose_request_type against a fake Jira site and a stand-in
 * change-request store. The tool on two grants: it reads the space on the
 * Jira Administration grant and the service desk on the JSM grant, and
 * writes on neither. What must hold: it registers only with both; it
 * refuses the two connections on different sites, a space that is not a
 * service project, a work type the space lacks, and a name the desk has;
 * and the proposal carries the desk id the JSM create takes.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
jest.mock('../common', () => ({
  withPresentationHint: (body: string) => body,
}));
jest.mock('@renkei/db', () => ({
  getDatabase: () => ({ ok: true, val: {} }),
}));
jest.mock('@renkei/crypto', () => ({ parseEncryptionKey: () => ({ ok: false }) }));
jest.mock('@renkei/provider-grants', () => ({ ATLASSIAN_JSM: 'atlassian-jsm' }));
jest.mock('@/lib/atlassian-app', () => ({ getAtlassianAdminApp: jest.fn() }));
jest.mock('@renkei/settings', () => ({ getPublicBaseUrl: () => null }));
jest.mock('@/lib/jira-admin/change-requests', () => {
  const actual = jest.requireActual<typeof import('@/lib/jira-admin/change-requests')>(
    '@/lib/jira-admin/change-requests'
  );
  return { ...actual, createChangeRequest: jest.fn(), cancelChangeRequest: jest.fn() };
});

import { authedFetch } from '@renkei/delegate-client';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { registerJiraAdminTools } from './index';
import type { JiraAdminAuth } from './jira-admin-auth';
import { FAKE_BASE } from '@/lib/jira-admin/fake-site.fixture';
import { createChangeRequest, type ChangeRequest } from '@/lib/jira-admin/change-requests';
import type { RequestTypePayload } from '@/lib/jira-admin/request-type';

type ToolResult = {
  content: { type: string; text?: string }[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const CHANGE_ID = 'a1b2c3d4-3a6e-4d9c-9e99-6f1e4a3c8b55';

let site: Record<string, [number, unknown]>;
let requests: { method: string; path: string; token: string }[];

const stubAuth: JiraAdminAuth = {
  kind: 'oauth',
  resolve: async () => ({
    cloudId: 'cloud-1',
    siteUrl: 'https://acme.atlassian.net',
    accountId: 'acct-1',
    auth: authedFetch((url, init) => fetch(url, init), 'atlassian-admin:acct-1'),
  }),
};

const JSM_SCOPES = [
  'read:servicedesk:jira-service-management',
  'read:requesttype:jira-service-management',
  'write:requesttype:jira-service-management',
];

function contextWith(jsmGrant: MCPToolContext['jsmGrant']): MCPToolContext {
  return {
    subject: 'subject-1',
    origin: 'https://renkei.example',
    jiraAdminScopes: ['read:jira-user', 'read:jira-work'],
    jsmGrant,
  } as MCPToolContext;
}

const jsmGrant = (cloudId = 'cloud-1'): NonNullable<MCPToolContext['jsmGrant']> => ({
  auth: authedFetch((url, init) => fetch(url, init), 'atlassian-jsm:acct-jsm'),
  cloudId,
  accountId: 'acct-jsm',
  scopes: JSM_SCOPES,
});

async function registered(context: MCPToolContext): Promise<Map<string, ToolHandler>> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    registerTool: (toolName: string, _config: unknown, handler: ToolHandler) => {
      tools.set(toolName, handler);
    },
  } as unknown as McpServer;
  await registerJiraAdminTools(server, context, stubAuth);
  return tools;
}

async function propose(
  args: Record<string, unknown>,
  context = contextWith(jsmGrant())
): Promise<ToolResult> {
  const handler = (await registered(context)).get('jira_admin_propose_request_type');
  if (!handler) throw new Error('jira_admin_propose_request_type is not registered');
  return handler(args);
}

const text = (result: ToolResult) => result.content[0]?.text ?? '';
const stored = () =>
  jest.mocked(createChangeRequest).mock.calls[0]?.[1]?.payload as RequestTypePayload | undefined;

const LISTING =
  '/rest/servicedeskapi/servicedesk/3/requesttype?limit=100&includeHiddenRequestTypesInSearch=true' +
  '&searchQuery=Report%20an%20outage';

function helpSite(): Record<string, [number, unknown]> {
  return {
    '/rest/api/3/project/HELP': [
      200,
      {
        id: '10100',
        key: 'HELP',
        name: 'Help desk',
        projectTypeKey: 'service_desk',
        style: 'classic',
        issueTypes: [
          { id: '10010', name: 'Service request', subtask: false },
          { id: '10011', name: 'Incident', subtask: false },
          { id: '10012', name: 'Sub-task', subtask: true },
        ],
      },
    ],
    '/rest/api/3/project/OPS': [
      200,
      { id: '10000', key: 'OPS', projectTypeKey: 'software', style: 'classic', issueTypes: [] },
    ],
    '/rest/servicedeskapi/servicedesk/HELP': [
      200,
      { id: '3', projectId: '10100', projectKey: 'HELP', projectName: 'Help desk' },
    ],
    [LISTING]: [200, { values: [] }],
  };
}

beforeEach(() => {
  site = helpSite();
  requests = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).slice(FAKE_BASE.length);
    const headers = new Headers(init?.headers);
    requests.push({
      method: init?.method ?? 'GET',
      path,
      token: headers.get('authorization') ?? headers.get('x-renkei-grant') ?? '',
    });
    const [status, body] = site[path] ?? [404, { errorMessage: 'No such thing.' }];
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  jest.mocked(createChangeRequest).mockReset();
  jest.mocked(createChangeRequest).mockImplementation(async (_db, input) => {
    const now = new Date();
    const change: ChangeRequest = {
      id: CHANGE_ID,
      subject: input.subject,
      agentId: null,
      cloudId: input.cloudId,
      siteUrl: input.siteUrl ?? null,
      kind: input.kind,
      title: input.title,
      reason: input.reason ?? null,
      payload: input.payload,
      status: 'pending',
      results: null,
      expiresAt: new Date(now.getTime() + 24 * 3_600_000),
      createdAt: now,
      updatedAt: now,
      appliedBy: null,
      appliedAt: null,
      cancelledAt: null,
      approvedBy: null,
      approvedAt: null,
      step: null,
      resolution: null,
    };
    return change;
  });
});

it('registers only when the JSM grant is there with its scopes', async () => {
  expect((await registered(contextWith(undefined))).has('jira_admin_propose_request_type')).toBe(
    false
  );
  expect(
    (
      await registered(
        contextWith({ ...jsmGrant(), scopes: ['read:servicedesk:jira-service-management'] })
      )
    ).has('jira_admin_propose_request_type')
  ).toBe(false);
  expect((await registered(contextWith(jsmGrant()))).has('jira_admin_propose_request_type')).toBe(
    true
  );
});

it('proposes a request type, reading the space on one grant and the desk on the other', async () => {
  const result = await propose({
    space: 'help',
    name: 'Report an outage',
    workType: 'incident',
    description: 'Something is down for everyone',
    helpText: 'Tell us what stopped working',
    reason: 'Support asked',
  });
  expect(result.isError).toBeUndefined();
  expect(requests.every((request) => request.method === 'GET')).toBe(true);
  expect(requests.map((request) => request.path)).toEqual([
    '/rest/api/3/project/HELP',
    '/rest/servicedeskapi/servicedesk/HELP',
    LISTING,
  ]);
  expect(stored()).toEqual({
    serviceDesk: { id: '3', projectId: '10100', projectKey: 'HELP', projectName: 'Help desk' },
    operations: [
      {
        op: 'create_request_type',
        name: 'Report an outage',
        description: 'Something is down for everyone',
        helpText: 'Tell us what stopped working',
        workType: { id: '10011', name: 'Incident' },
      },
    ],
  });
  expect(jest.mocked(createChangeRequest).mock.calls[0]?.[1]).toMatchObject({
    kind: 'request_type',
    title: 'New request type “Report an outage” for HELP',
    cloudId: 'cloud-1',
  });
  const body = text(result);
  expect(body).toContain(
    'Add the request type “Report an outage” to HELP, backed by the work type “Incident”'
  );
  expect(body).toContain('stays hidden on the portal until an admin puts it in a portal group');
  expect(body).toContain(`https://renkei.example/jira-admin/changes/${CHANGE_ID}`);
});

it('refuses two connections on different sites', async () => {
  const result = await propose(
    { space: 'HELP', name: 'Report an outage', workType: 'Incident' },
    contextWith(jsmGrant('cloud-2'))
  );
  expect(result.isError).toBe(true);
  expect(text(result)).toContain(
    'on a different Jira site than your Jira Administration connection'
  );
  expect(requests).toEqual([]);
});

it('refuses a space that is not a service project, a work type it lacks, and a subtask type', async () => {
  const software = await propose({ space: 'OPS', name: 'Report an outage', workType: 'Bug' });
  expect(text(software)).toContain('OPS is not a service project');
  const missing = await propose({ space: 'HELP', name: 'Report an outage', workType: 'Bug' });
  expect(text(missing)).toContain(
    'HELP has no work type “Bug”. Its work types: Service request, Incident, Sub-task. Add one ' +
      'with jira_admin_propose_work_type first.'
  );
  const subtask = await propose({ space: 'HELP', name: 'Report an outage', workType: 'Sub-task' });
  expect(text(subtask)).toContain('“Sub-task” is a subtask type');
  expect(createChangeRequest).not.toHaveBeenCalled();
});

it('refuses a name the desk has already, hidden ones included', async () => {
  site[LISTING] = [
    200,
    { values: [{ id: '11000', name: 'Report an Outage', issueTypeId: '10010' }] },
  ];
  const result = await propose({ space: 'HELP', name: 'Report an outage', workType: 'Incident' });
  expect(result.isError).toBe(true);
  expect(text(result)).toContain(
    'HELP has a request type “Report an Outage” already (11000, backed by “Service request”)'
  );
  expect(createChangeRequest).not.toHaveBeenCalled();
});
