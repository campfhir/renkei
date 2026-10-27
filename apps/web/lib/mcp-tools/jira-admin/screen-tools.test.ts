/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * jira_admin_get_space_screens and jira_admin_propose_screen_changes
 * against a fake Jira site and a stand-in change-request store. What must
 * hold: the read names each screen's tabs, fields and the other spaces
 * showing it; proposing only ever reads Jira; a screen shown by more than
 * one space is refused until told to, naming them; fields are resolved
 * against what the screen shows (to take off or move) or could show (to
 * put on), and a name that matches several is refused, not guessed.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
jest.mock('../common', () => ({
  withPresentationHint: (body: string) => body,
}));
jest.mock('@renkei/crypto', () => ({ parseEncryptionKey: () => ({ ok: false }) }));
jest.mock('@renkei/provider-grants', () => ({}));
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
import { FAKE_BASE, opsScreensSite } from '@/lib/jira-admin/fake-site.fixture';
import { createChangeRequest, type ChangeRequest } from '@/lib/jira-admin/change-requests';
import type { ScreenChangesPayload } from '@/lib/jira-admin/screen-changes';

type ToolResult = {
  content: { type: string; text?: string }[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const CHANGE_ID = '9c4a6f4b-2f5d-4c8b-8d88-5e0d3f2b7a44';

let site: Record<string, [number, unknown]>;
let requests: { method: string; path: string }[];

const stubAuth: JiraAdminAuth = {
  kind: 'oauth',
  resolve: async () => ({
    cloudId: 'cloud-1',
    siteUrl: 'https://acme.atlassian.net',
    accountId: 'acct-1',
    auth: authedFetch((url, init) => fetch(url, init), 'atlassian-admin:acct-1'),
  }),
};

const context = {
  subject: 'subject-1',
  origin: 'https://renkei.example',
  jiraAdminScopes: [
    'read:jira-user',
    'read:jira-work',
    'manage:jira-configuration',
    'manage:jira-project',
  ],
} as MCPToolContext;

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const registered = new Map<string, ToolHandler>();
  const server = {
    registerTool: (toolName: string, _config: unknown, handler: ToolHandler) => {
      registered.set(toolName, handler);
    },
  } as unknown as McpServer;
  await registerJiraAdminTools(server, context, stubAuth);
  const handler = registered.get(name);
  if (!handler) throw new Error(`${name} is not registered`);
  return handler(args);
}

const propose = (args: Record<string, unknown>) => call('jira_admin_propose_screen_changes', args);
const text = (result: ToolResult) => result.content[0]?.text ?? '';
const stored = () =>
  jest.mocked(createChangeRequest).mock.calls[0]?.[0]?.payload as ScreenChangesPayload | undefined;

/** The screens' fields, and the screen lookups by name and id. */
function screenFields(): Record<string, [number, unknown]> {
  return {
    '/rest/api/3/screens/40/tabs/400/fields': [
      200,
      [
        { id: 'summary', name: 'Summary' },
        { id: 'customfield_10001', name: 'Vendor' },
      ],
    ],
    '/rest/api/3/screens/40/tabs/401/fields': [200, [{ id: 'description', name: 'Description' }]],
    '/rest/api/3/screens/41/tabs/410/fields': [200, [{ id: 'summary', name: 'Summary' }]],
    '/rest/api/3/screens/42/tabs/420/fields': [
      200,
      [
        { id: 'summary', name: 'Summary' },
        { id: 'customfield_10001', name: 'Vendor' },
      ],
    ],
    '/rest/api/3/screens?maxResults=100&queryString=OPS%3A%20Create': [
      200,
      { values: [{ id: 41, name: 'OPS: Create' }] },
    ],
    '/rest/api/3/screens?maxResults=100&queryString=Shared%20bug%20screen': [
      200,
      { values: [{ id: 42, name: 'Shared bug screen' }] },
    ],
    '/rest/api/3/screens?id=42': [200, { values: [{ id: 42, name: 'Shared bug screen' }] }],
    '/rest/api/3/screens/41/availableFields': [
      200,
      [
        { id: 'priority', name: 'Priority' },
        { id: 'customfield_10002', name: 'Severity' },
        { id: 'customfield_10003', name: 'Severity' },
      ],
    ],
  };
}

beforeEach(() => {
  site = { ...opsScreensSite(), ...screenFields() };
  requests = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).slice(FAKE_BASE.length);
    requests.push({ method: init?.method ?? 'GET', path });
    const [status, body] = site[path] ?? [404, { errorMessages: ['No such thing.'] }];
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  jest.mocked(createChangeRequest).mockReset();
  jest.mocked(createChangeRequest).mockImplementation(async (input) => {
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

describe('jira_admin_get_space_screens', () => {
  it('lists each screen with its uses, tabs, fields and the spaces sharing it', async () => {
    const result = text(await call('jira_admin_get_space_screens', { space: 'OPS' }));
    expect(result).toContain('OPS shows 3 screens:');
    expect(result).toContain('OPS: Create — id 41 — create — OPS’s alone');
    expect(result).toContain('Tab “Field Tab” (id 410): Summary (summary)');
    expect(result).toContain('OPS: Edit/View — id 40 — edit, view — OPS’s alone');
    expect(result).toContain('Tab “Details” (id 401): Description (description)');
    expect(result).toContain('Shared bug screen — id 42 — create, edit, view — also shown by HR');
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('refuses a work type the space lacks', async () => {
    const result = await call('jira_admin_get_space_screens', {
      space: 'OPS',
      workTypes: ['Epic'],
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('OPS has no work type “Epic”');
  });
});

describe('jira_admin_propose_screen_changes', () => {
  it('refuses a screen more than one space shows until told to, naming them', async () => {
    const result = await propose({ screen: 'Shared bug screen', remove: ['Vendor'] });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(
      'The screen “Shared bug screen” is shown by HR, OPS, and every one of them sees these ' +
        'changes. Pass sharedScreens: true to go ahead.'
    );
    expect(createChangeRequest).not.toHaveBeenCalled();
  });

  it('proposes each change in order, resolving fields by name — writing nothing', async () => {
    const result = await propose({
      screen: 'OPS: Create',
      add: [{ field: 'Priority' }, { field: 'customfield_10003' }],
      move: [{ field: 'Summary', position: 'last' }],
      addTabs: ['More'],
      renameTabs: [{ from: 'Field Tab', to: 'Main' }],
      rename: 'OPS: New issue',
      reason: 'Tidying up',
    });
    expect(result.isError).toBeUndefined();
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
    const payload = stored();
    expect(payload?.screen).toEqual({ id: '41', name: 'OPS: Create' });
    expect(payload?.spaces).toEqual(['OPS']);
    expect(payload?.operations).toEqual([
      {
        op: 'add_field',
        fieldId: 'priority',
        fieldName: 'Priority',
        tabId: '410',
        tabName: 'Field Tab',
      },
      {
        op: 'add_field',
        fieldId: 'customfield_10003',
        fieldName: 'Severity',
        tabId: '410',
        tabName: 'Field Tab',
      },
      {
        op: 'move_field',
        fieldId: 'summary',
        fieldName: 'Summary',
        tabId: '410',
        tabName: 'Field Tab',
        position: 'last',
      },
      { op: 'add_tab', name: 'More' },
      { op: 'rename_tab', tabId: '410', from: 'Field Tab', to: 'Main' },
      { op: 'rename_screen', from: 'OPS: Create', to: 'OPS: New issue' },
    ]);
    expect(jest.mocked(createChangeRequest).mock.calls[0]?.[0]).toMatchObject({
      kind: 'screen_changes',
      title: '6 changes to the screen “OPS: Create”',
      reason: 'Tidying up',
    });
    expect(text(result)).toContain(
      'Where: The screen “OPS: Create” on https://acme.atlassian.net. Only OPS shows it.'
    );
    expect(text(result)).toContain(`https://renkei.example/jira-admin/changes/${CHANGE_ID}`);
  });

  it('takes a field off the tab it is on, and goes ahead on a shared screen when told to', async () => {
    const result = await propose({ screen: '42', remove: ['Vendor'], sharedScreens: true });
    expect(result.isError).toBeUndefined();
    expect(stored()?.spaces).toEqual(['HR', 'OPS']);
    expect(stored()?.operations).toEqual([
      {
        op: 'remove_field',
        fieldId: 'customfield_10001',
        fieldName: 'Vendor',
        tabId: '420',
        tabName: 'Details',
      },
    ]);
    expect(text(result)).toContain('HR and OPS show it, and every one of them sees these changes.');
  });

  it('refuses a name that matches several fields, and a field the screen cannot show', async () => {
    const several = await propose({ screen: 'OPS: Create', add: [{ field: 'Severity' }] });
    expect(several.isError).toBe(true);
    expect(text(several)).toContain(
      '2 fields are named “Severity” — pass the id of the one you mean: customfield_10002, customfield_10003'
    );
    const none = await propose({ screen: 'OPS: Create', add: [{ field: 'Story points' }] });
    expect(text(none)).toContain('No field “Story points” can be put on “OPS: Create”');
    const gone = await propose({
      screen: 'OPS: Create',
      move: [{ field: 'Vendor', position: 'first' }],
    });
    expect(text(gone)).toContain('No field “Vendor” is on “OPS: Create” to move.');
    expect(createChangeRequest).not.toHaveBeenCalled();
  });

  it('says when there is nothing to do', async () => {
    const result = await propose({ screen: 'OPS: Create', add: [{ field: 'Summary' }] });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(
      'Nothing to do on “OPS: Create”. “Summary” is on the screen already.'
    );
  });
});
