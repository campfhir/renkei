/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * jira_admin_propose_option_changes and jira_admin_list_changes against a
 * fake Jira site and a stand-in change-request store. The property that
 * matters above all: proposing reads Jira and writes only Renkei's own
 * change request — it never sends a single write to Jira.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
jest.mock('../common', () => ({
  withPresentationHint: (body: string) => body,
}));
jest.mock('@renkei/db', () => ({
  // The one query the tools make themselves: the tenant's slug, for links.
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
  return {
    ...actual,
    createChangeRequest: jest.fn(),
    cancelChangeRequest: jest.fn(),
    getChangeRequest: jest.fn(),
    listChangeRequests: jest.fn(),
  };
});

import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { registerJiraAdminTools } from './index';
import type { JiraAdminAuth } from './jira-admin-auth';
import {
  cancelChangeRequest,
  createChangeRequest,
  getChangeRequest,
  listChangeRequests,
  type ChangeRequest,
} from '@/lib/jira-admin/change-requests';

type ToolResult = {
  content: { type: string; text?: string }[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const BASE = 'https://api.atlassian.com/ex/jira/cloud-1';
const CHANGE_ID = '6f1d3c1e-8c1a-4f5e-9a55-2b7a0c9e4d11';

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
  jiraAdminScopes: ['read:jira-user', 'read:jira-work', 'manage:jira-configuration'],
} as MCPToolContext;

async function call(
  name: string,
  args: Record<string, unknown> = {},
  ctx: MCPToolContext = context
): Promise<ToolResult> {
  const registered = new Map<string, ToolHandler>();
  const server = {
    registerTool: (toolName: string, _config: unknown, handler: ToolHandler) => {
      registered.set(toolName, handler);
    },
  } as unknown as McpServer;
  await registerJiraAdminTools(server, ctx, stubAuth);
  const handler = registered.get(name);
  if (!handler) throw new Error(`${name} is not registered`);
  return handler(args);
}

const text = (result: ToolResult) => result.content[0]?.text ?? '';

const FIELD = {
  id: 'customfield_10100',
  name: 'Source',
  schema: { type: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' },
};
const FIELD_SEARCH =
  '/rest/api/3/field/search?type=custom&expand=lastUsed,screensCount,contextsCount,isLocked' +
  '&maxResults=50&query=Source';
const CONTEXTS = '/rest/api/3/field/customfield_10100/context?maxResults=50';
const MAPPINGS = '/rest/api/3/field/customfield_10100/context/projectmapping?maxResults=50';
const optionsOf = (contextId: string) =>
  `/rest/api/3/field/customfield_10100/context/${contextId}/option?startAt=0&maxResults=100`;

function storedChange(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  const now = new Date();
  return {
    id: CHANGE_ID,
    subject: 'subject-1',
    agentId: null,
    cloudId: 'cloud-1',
    siteUrl: 'https://acme.atlassian.net',
    kind: 'field_options',
    title: 'Source (Ops context): add option “Vendor”',
    reason: null,
    payload: {},
    status: 'pending',
    results: null,
    expiresAt: new Date(now.getTime() + 24 * 3_600_000),
    createdAt: now,
    updatedAt: now,
    appliedBy: null,
    appliedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.mocked(createChangeRequest).mockReset();
  jest.mocked(cancelChangeRequest).mockReset();
  jest.mocked(getChangeRequest).mockReset();
  jest.mocked(listChangeRequests).mockReset();
  jest
    .mocked(createChangeRequest)
    .mockImplementation(async (_db, input) =>
      storedChange({ title: input.title, payload: input.payload, kind: input.kind })
    );

  site = {
    [FIELD_SEARCH]: [200, { values: [FIELD] }],
    [CONTEXTS]: [200, { values: [{ id: '10200', name: 'Ops context', isGlobalContext: false }] }],
    [MAPPINGS]: [200, { values: [{ contextId: '10200', projectId: '10000' }] }],
    '/rest/api/3/project/search?maxResults=50&id=10000': [
      200,
      { values: [{ id: '10000', key: 'OPS' }] },
    ],
    [optionsOf('10200')]: [
      200,
      {
        isLast: true,
        values: [
          { id: '1', value: 'Customer', disabled: false },
          { id: '2', value: 'Partner', disabled: false },
          { id: '3', value: 'Legacy', disabled: false },
        ],
      },
    ],
  };
  requests = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.startsWith(BASE) ? url.slice(BASE.length) : url;
    requests.push({ method: init?.method ?? 'GET', path });
    const [status, body] = site[path] ?? [404, { errorMessages: ['No such thing.'] }];
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
});

describe('jira_admin_propose_option_changes', () => {
  it('stores the exact operations and links the review page — and writes nothing to Jira', async () => {
    const result = await call('jira_admin_propose_option_changes', {
      field: 'Source',
      add: ['Vendor'],
      disable: ['Legacy'],
      reason: 'Procurement needs to tag vendor tickets',
    });

    expect(result.isError).toBeUndefined();
    expect(requests.every((request) => request.method === 'GET')).toBe(true);

    const input = jest.mocked(createChangeRequest).mock.calls[0]?.[1];
    expect(input).toMatchObject({
      tenantId: 'tenant-1',
      subject: 'subject-1',
      cloudId: 'cloud-1',
      kind: 'field_options',
      reason: 'Procurement needs to tag vendor tickets',
      payload: {
        field: { id: 'customfield_10100', name: 'Source' },
        context: { id: '10200', name: 'Ops context', global: false, spaces: ['OPS'] },
        parent: null,
        operations: [
          { op: 'add', values: ['Vendor'] },
          { op: 'disable', options: [{ optionId: '3', value: 'Legacy' }] },
        ],
      },
    });

    const link = `https://renkei.example/acme/jira-admin/changes/${CHANGE_ID}`;
    expect(text(result)).toContain('Proposed — nothing has changed in Jira yet.');
    expect(text(result)).toContain('• Add option “Vendor”');
    expect(text(result)).toContain('• Disable “Legacy”');
    expect(text(result)).toContain('Where: The context “Ops context”, used by OPS.');
    expect(text(result)).toContain(`Review and apply: ${link}`);
    // The receipt carries the link, so an agent run's notification opens the review.
    expect(result._meta?.['renkei/act']).toEqual({ url: link });
  });

  it('records the agent when an agent run proposes', async () => {
    await call(
      'jira_admin_propose_option_changes',
      { field: 'Source', add: ['Vendor'] },
      { ...context, agent: { agentId: 'agent-7' } }
    );
    expect(jest.mocked(createChangeRequest).mock.calls[0]?.[1].agentId).toBe('agent-7');
  });

  it('refuses what could never apply, and stores nothing', async () => {
    const result = await call('jira_admin_propose_option_changes', {
      field: 'Source',
      add: ['partner'],
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('“Partner” already exists.');
    expect(createChangeRequest).not.toHaveBeenCalled();
  });

  it('asks which context when the field has several, rather than guessing', async () => {
    site[CONTEXTS] = [
      200,
      {
        values: [
          { id: '10200', name: 'Ops context', isGlobalContext: false },
          { id: '10300', name: 'Default', isGlobalContext: true },
        ],
      },
    ];
    const result = await call('jira_admin_propose_option_changes', {
      field: 'Source',
      add: ['Vendor'],
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      'This field has 2 contexts — pass context (its id or name) or space: ' +
        'Ops context (id 10200), Default (id 10300, global)'
    );
    expect(createChangeRequest).not.toHaveBeenCalled();
  });

  it('takes a space to mean its own context, and says so when that is the global one', async () => {
    site[CONTEXTS] = [
      200,
      {
        values: [
          { id: '10200', name: 'Ops context', isGlobalContext: false },
          { id: '10300', name: 'Default', isGlobalContext: true },
        ],
      },
    ];
    site['/rest/api/3/project/ENG'] = [200, { id: '10001', key: 'ENG' }];
    site[optionsOf('10300')] = [
      200,
      { isLast: true, values: [{ id: '5', value: 'Customer', disabled: false }] },
    ];

    const result = await call('jira_admin_propose_option_changes', {
      field: 'Source',
      space: 'eng',
      add: ['Vendor'],
    });

    expect(result.isError).toBeUndefined();
    expect(jest.mocked(createChangeRequest).mock.calls[0]?.[1].payload).toMatchObject({
      context: { id: '10300', global: true, spaces: [] },
    });
    expect(text(result)).toContain(
      'ENG has no context of its own for this field, so this changes the global context'
    );
    expect(text(result)).toContain('it reaches every space that has no context of its own');
  });

  it('refuses a field without options, and a locked one', async () => {
    site[FIELD_SEARCH] = [
      200,
      {
        values: [
          {
            ...FIELD,
            schema: {
              type: 'string',
              custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield',
            },
          },
        ],
      },
    ];
    expect(
      text(await call('jira_admin_propose_option_changes', { field: 'Source', add: ['x'] }))
    ).toBe('Source is a short text field, which has no options to change.');

    site[FIELD_SEARCH] = [200, { values: [{ ...FIELD, isLocked: true }] }];
    expect(
      text(await call('jira_admin_propose_option_changes', { field: 'Source', add: ['x'] }))
    ).toMatch(/is locked/);
    expect(createChangeRequest).not.toHaveBeenCalled();
  });

  it('cancels the request it replaces, and says whether it could', async () => {
    jest.mocked(cancelChangeRequest).mockResolvedValueOnce(true);
    const result = await call('jira_admin_propose_option_changes', {
      field: 'Source',
      add: ['Vendor', 'Reseller'],
      replaces: 'b7c2a1d0-1111-4222-8333-944455556666',
    });
    expect(jest.mocked(cancelChangeRequest).mock.calls[0]?.slice(1)).toEqual([
      'tenant-1',
      'subject-1',
      'b7c2a1d0-1111-4222-8333-944455556666',
    ]);
    expect(text(result)).toContain('Cancelled the request it replaces');
  });
});

describe('jira_admin_list_changes', () => {
  it('lists the user’s requests with their state and review links', async () => {
    jest.mocked(listChangeRequests).mockResolvedValueOnce([
      storedChange(),
      storedChange({
        id: 'a1b2c3d4-0000-4000-8000-000000000000',
        title: 'Source (Ops context): disable “Legacy”',
        status: 'applied',
        appliedAt: new Date('2026-09-23T14:02:00Z'),
        results: [{ label: 'Disable “Legacy”', outcome: 'done' }],
      }),
    ]);
    const result = text(await call('jira_admin_list_changes'));
    expect(result).toContain('• Source (Ops context): add option “Vendor” — waiting for review');
    expect(result).toContain(`https://renkei.example/acme/jira-admin/changes/${CHANGE_ID}`);
    expect(result).toContain(
      '• Source (Ops context): disable “Legacy” — applied 2026-09-23 14:02 UTC — 1 of 1 done'
    );
  });

  it('shows one request with what each operation returned', async () => {
    jest.mocked(getChangeRequest).mockResolvedValueOnce(
      storedChange({
        status: 'partial',
        results: [
          { label: 'Add option “Vendor”', outcome: 'done' },
          { label: 'Disable “Legacy”', outcome: 'failed', detail: 'Jira answered 400.' },
        ],
      })
    );
    const result = text(await call('jira_admin_list_changes', { change: CHANGE_ID }));
    expect(result).toContain('Status: partly applied');
    expect(result).toContain('• Add option “Vendor” — done');
    expect(result).toContain('• Disable “Legacy” — failed: Jira answered 400.');
  });

  it('says so when a request is not the user’s', async () => {
    jest.mocked(getChangeRequest).mockResolvedValueOnce(null);
    const result = await call('jira_admin_list_changes', { change: CHANGE_ID });
    expect(result.isError).toBe(true);
  });
});
