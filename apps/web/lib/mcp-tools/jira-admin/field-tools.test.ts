/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * jira_admin_propose_space_field against a fake Jira site and a stand-in
 * change-request store. What must hold: it only ever reads Jira; it reuses
 * a field of the same name and type rather than making a second, and
 * refuses one of the same name and another type; it never changes options
 * every space shares; and it will not put a field on a screen another
 * space shows without being told to, naming that space.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
jest.mock('../common', () => ({
  withPresentationHint: (body: string) => body,
}));
jest.mock('@renkei/db', () => ({
  getDatabase: () => ({
    ok: true,
    val: {
      selectFrom: () => ({
        select: () => ({ where: () => ({ executeTakeFirst: async () => ({ slug: 'acme' }) }) }),
      }),
    },
  }),
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

import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { registerJiraAdminTools } from './index';
import type { JiraAdminAuth } from './jira-admin-auth';
import { FAKE_BASE, opsScreensSite } from '@/lib/jira-admin/fake-site.fixture';
import { createChangeRequest, type ChangeRequest } from '@/lib/jira-admin/change-requests';
import type { SpaceFieldPayload } from '@/lib/jira-admin/space-field';

type ToolResult = {
  content: { type: string; text?: string }[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const CHANGE_ID = '7a2e4d2f-9d2b-4a6f-8b66-3c8b1d0f5e22';

let site: Record<string, [number, unknown]>;
let requests: { method: string; path: string }[];

const stubAuth: JiraAdminAuth = {
  kind: 'oauth',
  resolve: async () => ({
    cloudId: 'cloud-1',
    siteUrl: 'https://acme.atlassian.net',
    accountId: 'acct-1',
    authHeader: 'Bearer t',
  }),
};

const context = {
  tenantId: 'tenant-1',
  subject: 'subject-1',
  origin: 'https://renkei.example',
  jiraAdminScopes: [
    'read:jira-user',
    'read:jira-work',
    'manage:jira-configuration',
    'manage:jira-project',
  ],
} as MCPToolContext;

async function propose(args: Record<string, unknown>): Promise<ToolResult> {
  const registered = new Map<string, ToolHandler>();
  const server = {
    registerTool: (toolName: string, _config: unknown, handler: ToolHandler) => {
      registered.set(toolName, handler);
    },
  } as unknown as McpServer;
  await registerJiraAdminTools(server, context, stubAuth);
  const handler = registered.get('jira_admin_propose_space_field');
  if (!handler) throw new Error('jira_admin_propose_space_field is not registered');
  return handler(args);
}

const text = (result: ToolResult) => result.content[0]?.text ?? '';
const stored = () =>
  jest.mocked(createChangeRequest).mock.calls[0]?.[1]?.payload as SpaceFieldPayload | undefined;

const VENDOR_SEARCH = '/rest/api/3/field/search?type=custom&maxResults=50&query=Vendor';
const BY_NAME =
  '/rest/api/3/field/search?type=custom&expand=lastUsed,screensCount,contextsCount,isLocked&maxResults=50&query=Vendor';

beforeEach(() => {
  site = {
    ...opsScreensSite(),
    [VENDOR_SEARCH]: [200, { values: [] }],
  };
  requests = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).slice(FAKE_BASE.length);
    requests.push({ method: init?.method ?? 'GET', path });
    const [status, body] = site[path] ?? [404, { errorMessages: ['No such thing.'] }];
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
      expiresAt: new Date(now.getTime() + 24 * 3600 * 1000),
      createdAt: now,
      updatedAt: now,
      appliedBy: null,
      appliedAt: null,
      cancelledAt: null,
    };
    return change;
  });
});

/** An existing Vendor select list, on no screens yet. */
function existingVendor(contexts: unknown[], mappings: unknown[]) {
  site[BY_NAME] = [
    200,
    {
      values: [
        {
          id: 'customfield_10500',
          name: 'Vendor',
          schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' },
        },
      ],
    },
  ];
  site[VENDOR_SEARCH] = site[BY_NAME];
  site[VENDOR_SEARCH.replace('query=Vendor', 'query=vendor')] = site[BY_NAME];
  site[BY_NAME.replace('query=Vendor', 'id=customfield_10500')] = site[BY_NAME];
  site['/rest/api/3/field/customfield_10500/context?startAt=0&maxResults=100'] = [
    200,
    { isLast: true, values: contexts },
  ];
  site['/rest/api/3/field/customfield_10500/context/projectmapping?startAt=0&maxResults=100'] = [
    200,
    { isLast: true, values: mappings },
  ];
  site['/rest/api/3/field/customfield_10500/screens?startAt=0&maxResults=100'] = [
    200,
    { isLast: true, values: [] },
  ];
}

describe('jira_admin_propose_space_field', () => {
  it('proposes a new field, a context for the space, and its own screens — reading only', async () => {
    const result = await propose({
      space: 'ops',
      name: 'Vendor',
      type: 'select',
      options: ['Acme', 'Globex', 'acme'],
      workTypes: ['task'],
      tab: 'Details',
      reason: 'Procurement asked',
    });

    expect(result.isError).toBeUndefined();
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
    expect(jest.mocked(createChangeRequest).mock.calls[0]?.[1]).toMatchObject({
      kind: 'space_field',
      title: 'New field “Vendor” for OPS',
      reason: 'Procurement asked',
    });
    expect(stored()).toEqual({
      space: { id: '10000', key: 'OPS' },
      field: { id: null, name: 'Vendor', typeLabel: 'select list (single choice)' },
      operations: [
        { op: 'create_field', name: 'Vendor', description: null, type: 'select' },
        {
          op: 'add_context',
          name: 'Vendor for OPS',
          issueTypes: [{ id: '10001', name: 'Task' }],
          // "acme" is Acme again.
          options: ['Acme', 'Globex'],
        },
        {
          op: 'add_to_screen',
          screenId: '41',
          screenName: 'OPS: Create',
          tabId: '410',
          tabName: 'Field Tab',
          tabNote: 'It has no “Details” tab, so the field goes on its first tab.',
          uses: ['create'],
          sharedWith: [],
          moreShared: false,
        },
        {
          op: 'add_to_screen',
          screenId: '40',
          screenName: 'OPS: Edit/View',
          tabId: '401',
          tabName: 'Details',
          tabNote: null,
          uses: ['edit', 'view'],
          sharedWith: [],
          moreShared: false,
        },
      ],
    });
    const link = `https://renkei.example/acme/jira-admin/changes/${CHANGE_ID}`;
    expect(text(result)).toContain('Proposed — nothing has changed in Jira yet.');
    expect(text(result)).toContain('The screens it goes on are OPS’s alone.');
    expect(text(result)).toContain(`Review and apply: ${link}`);
    expect(result._meta?.['renkei/act']).toEqual({ url: link });
  });

  it('will not use a screen another space shows without being told to, and names the space', async () => {
    const refused = await propose({ space: 'OPS', name: 'Vendor', type: 'select' });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toBe(
      'Some of OPS’s screens are shown by other spaces too, and the field would appear there ' +
        'as well: “Shared bug screen” (HR). Pass sharedScreens: true to go ahead, or give OPS ' +
        'screens of its own first.'
    );
    expect(createChangeRequest).not.toHaveBeenCalled();

    const told = await propose({
      space: 'OPS',
      name: 'Vendor',
      type: 'select',
      sharedScreens: true,
    });
    expect(told.isError).toBeUndefined();
    const shared = stored()?.operations.find(
      (operation) => operation.op === 'add_to_screen' && operation.screenId === '42'
    );
    expect(shared).toMatchObject({ sharedWith: ['HR'], moreShared: false });
    expect(text(told)).toContain('Also shown by HR — the field appears there too');
  });

  it('reuses a field of the same name and type rather than making a second', async () => {
    existingVendor([], []);
    const result = await propose({
      space: 'OPS',
      name: 'vendor',
      type: 'select',
      options: ['Acme'],
      workTypes: ['Task'],
    });
    expect(result.isError).toBeUndefined();
    expect(stored()?.field).toEqual({
      id: 'customfield_10500',
      name: 'Vendor',
      typeLabel: 'select list (single choice)',
    });
    // No context covers OPS yet, so it gets one of its own.
    expect(stored()?.operations.map((operation) => operation.op)).toEqual([
      'add_context',
      'add_to_screen',
      'add_to_screen',
    ]);
    expect(text(result)).toContain(
      'A select list (single choice) named “Vendor” exists already (customfield_10500), so it ' +
        'is used rather than a second one created.'
    );
  });

  it('refuses a new field whose name another type already has', async () => {
    existingVendor([], []);
    const result = await propose({ space: 'OPS', name: 'Vendor', type: 'text' });
    expect(text(result)).toBe(
      'A custom field named “Vendor” exists already (customfield_10500), a select list ' +
        '(single choice). Use it (field: customfield_10500), or choose another name — two ' +
        'fields of one name confuse everyone who searches.'
    );
    expect(createChangeRequest).not.toHaveBeenCalled();
  });

  it('never changes options every space shares', async () => {
    existingVendor(
      [{ id: '20000', name: 'Default', isGlobalContext: true }],
      [{ contextId: '20000', isGlobalContext: true }]
    );
    const result = await propose({
      space: 'OPS',
      field: 'Vendor',
      options: ['Initech'],
      workTypes: ['Task'],
    });
    expect(text(result)).toMatch(
      /^“Vendor” has a context every space shares \(“Default”\), and OPS has none of its own/
    );
    expect(createChangeRequest).not.toHaveBeenCalled();

    // Without options, the shared context covers OPS: only the screens change.
    const placed = await propose({ space: 'OPS', field: 'Vendor', workTypes: ['Task'] });
    expect(placed.isError).toBeUndefined();
    expect(stored()?.operations.map((operation) => operation.op)).toEqual([
      'add_to_screen',
      'add_to_screen',
    ]);
  });

  it('adds only the options OPS’s own context lacks, and skips screens it is on', async () => {
    existingVendor(
      [{ id: '20002', name: 'Ops vendors', isGlobalContext: false }],
      [{ contextId: '20002', projectId: '10000' }]
    );
    site['/rest/api/3/field/customfield_10500/context/20002/option?startAt=0&maxResults=100'] = [
      200,
      { isLast: true, values: [{ id: '1', value: 'Acme', disabled: false }] },
    ];
    site['/rest/api/3/field/customfield_10500/screens?startAt=0&maxResults=100'] = [
      200,
      { isLast: true, values: [{ id: 41, name: 'OPS: Create' }] },
    ];
    const result = await propose({
      space: 'OPS',
      field: 'customfield_10500',
      options: ['acme', 'Initech'],
      workTypes: ['Task'],
    });
    expect(result.isError).toBeUndefined();
    expect(stored()?.operations).toEqual([
      { op: 'add_options', contextId: '20002', contextName: 'Ops vendors', options: ['Initech'] },
      expect.objectContaining({ op: 'add_to_screen', screenId: '40' }),
    ]);
    expect(text(result)).toContain('1 of those options OPS offers already.');
    expect(text(result)).toContain('It is on “OPS: Create” already.');
  });

  it.each([
    [{ space: 'OPS', field: 'Vendor', name: 'Vendor' }, /^Pass exactly one of field/],
    [{ space: 'OPS', name: 'Vendor' }, /^A new field needs a type/],
    [
      { space: 'OPS', name: 'Vendor', type: 'number', options: ['1'] },
      /^“Vendor” is a number; options are set here only on select lists/,
    ],
    [
      { space: 'OPS', name: 'Vendor', type: 'select', workTypes: ['Epic'] },
      /^OPS has no work type “Epic”\. Its work types: Task, Bug\.$/,
    ],
  ])('refuses what it cannot do: %#', async (args, reason) => {
    const result = await propose(args);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(reason);
    expect(createChangeRequest).not.toHaveBeenCalled();
  });

  it('refuses a team-managed space, whose fields live inside it', async () => {
    site['/rest/api/3/project/OPS'] = [200, { id: '10000', key: 'OPS', simplified: true }];
    expect(text(await propose({ space: 'OPS', name: 'Vendor', type: 'text' }))).toMatch(
      /^OPS is team-managed/
    );
  });
});
