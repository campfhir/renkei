/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The space template tools and jira_admin_propose_space against a fake
 * Jira site and stand-in stores. What must hold: saving keeps groups and
 * never people, a template is only ever used on its own site, and
 * proposing a space reads Jira without writing to it — everything it could
 * check now (key, name, lead, members, a template's schemes) it checks
 * before saving the proposal.
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
jest.mock('@/lib/jira-admin/space-templates', () => {
  const actual = jest.requireActual<typeof import('@/lib/jira-admin/space-templates')>(
    '@/lib/jira-admin/space-templates'
  );
  return {
    ...actual,
    saveSpaceTemplate: jest.fn(),
    findSpaceTemplate: jest.fn(),
    listSpaceTemplates: jest.fn(),
    deleteSpaceTemplate: jest.fn(),
  };
});

import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { registerJiraAdminTools } from './index';
import type { JiraAdminAuth } from './jira-admin-auth';
import { FAKE_BASE, opsSite } from '@/lib/jira-admin/fake-site.fixture';
import { createChangeRequest, type ChangeRequest } from '@/lib/jira-admin/change-requests';
import {
  documentFromSpace,
  findSpaceTemplate,
  listSpaceTemplates,
  saveSpaceTemplate,
  type SpaceTemplate,
} from '@/lib/jira-admin/space-templates';
import type { SpaceConfiguration } from '@/lib/jira-admin/space-config';

type ToolResult = {
  content: { type: string; text?: string }[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

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

const text = (result: ToolResult) => result.content[0]?.text ?? '';

/** OPS as the fake site describes it, for building a template from. */
const OPS: SpaceConfiguration = {
  id: '10000',
  key: 'OPS',
  name: 'Operations',
  projectTypeKey: 'software',
  assigneeType: 'UNASSIGNED',
  category: { id: '10100', name: 'Internal' },
  lead: { accountId: 'acct-lead', displayName: 'Lee Lead' },
  schemes: {
    issueTypeScheme: { id: '11', name: 'OPS work types' },
    issueTypeScreenScheme: { id: '12', name: 'OPS screens' },
    workflowScheme: { id: '13', name: 'OPS workflows' },
    fieldConfigurationScheme: null,
    permissionScheme: { id: '15', name: 'Internal permissions' },
    notificationScheme: { id: '16', name: 'Quiet notifications' },
    issueSecurityScheme: null,
  },
  roles: [
    {
      roleId: '10002',
      roleName: 'Administrators',
      groups: [{ groupId: 'g-admins', name: 'ops-admins' }],
      users: [{ accountId: 'acct-dana', displayName: 'Dana Admin' }],
    },
    {
      roleId: '10001',
      roleName: 'Developers',
      groups: [{ groupId: 'g-users', name: 'jira-software-users' }],
      users: [],
    },
  ],
};

function template(overrides: Partial<SpaceTemplate> = {}): SpaceTemplate {
  const now = new Date('2026-09-20T10:00:00Z');
  return {
    id: 'a0a0a0a0-1111-4222-8333-444455556666',
    cloudId: 'cloud-1',
    siteUrl: 'https://acme.atlassian.net',
    name: 'Ops standard',
    description: 'How operations spaces are set up',
    sourceSpaceKey: 'OPS',
    document: documentFromSpace(OPS),
    createdBy: 'subject-1',
    updatedBy: 'subject-1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  jest.mocked(createChangeRequest).mockReset();
  jest.mocked(saveSpaceTemplate).mockReset();
  jest.mocked(findSpaceTemplate).mockReset();
  jest.mocked(listSpaceTemplates).mockReset();
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
    };
    return change;
  });

  site = {
    ...opsSite(),
    // A template's schemes, still on the site.
    '/rest/api/3/issuetypescheme?id=11': [200, { values: [{ id: '11' }] }],
    '/rest/api/3/issuetypescreenscheme?id=12': [200, { values: [{ id: '12' }] }],
    '/rest/api/3/workflowscheme/13': [200, { id: 13 }],
    '/rest/api/3/permissionscheme/15': [200, { id: 15 }],
    '/rest/api/3/notificationscheme/16': [200, { id: 16 }],
    '/rest/api/3/workflowscheme/13/projectUsages?maxResults=50': [
      200,
      { projects: { values: [{ id: '10000' }, { id: '10005' }] } },
    ],
    // The new key and name are free.
    '/rest/api/3/projectvalidate/key?key=FIN': [200, { errorMessages: [], errors: {} }],
    '/rest/api/3/project/search?maxResults=50&query=Finance': [200, { values: [] }],
    // People.
    '/rest/api/3/user/search?query=dana%40acme.com&maxResults=50': [
      200,
      [{ accountId: 'acct-dana', displayName: 'Dana Admin', emailAddress: 'dana@acme.com' }],
    ],
    '/rest/api/3/user/search?query=sam%40acme.com&maxResults=50': [
      200,
      [{ accountId: 'acct-sam', displayName: 'Sam Dev', emailAddress: 'sam@acme.com' }],
    ],
    '/rest/api/3/group/bulk?groupName=finance-team&maxResults=10': [
      200,
      { values: [{ groupId: 'g-fin', name: 'finance-team' }] },
    ],
    '/rest/api/3/role': [
      200,
      [
        { id: 10002, name: 'Administrators' },
        { id: 10001, name: 'Developers' },
        { id: 10003, name: 'Viewers' },
      ],
    ],
  };
  requests = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).slice(FAKE_BASE.length);
    requests.push({ method: init?.method ?? 'GET', path });
    const [status, body] = site[path] ?? [404, { errorMessages: ['No such thing.'] }];
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
});

describe('jira_admin_save_space_template', () => {
  it('saves the schemes and role groups, says who was left out, and writes nothing to Jira', async () => {
    jest.mocked(saveSpaceTemplate).mockImplementation(async (_db, input) => ({
      ok: true,
      replaced: false,
      template: template({ name: input.name, document: input.document }),
    }));

    const result = await call('jira_admin_save_space_template', {
      space: 'ops',
      name: 'Ops standard',
    });

    expect(result.isError).toBeUndefined();
    const input = jest.mocked(saveSpaceTemplate).mock.calls[0]?.[1];
    expect(input).toMatchObject({
      tenantId: 'tenant-1',
      cloudId: 'cloud-1',
      sourceSpaceKey: 'OPS',
      subject: 'subject-1',
      overwrite: false,
      document: documentFromSpace(OPS),
    });
    expect(JSON.stringify(input?.document)).not.toContain('acct-dana');
    expect(text(result)).toContain('Saved the template “Ops standard” from OPS');
    expect(text(result)).toContain('Workflows: “OPS workflows” (id 13)');
    expect(text(result)).toContain('1 person in OPS’s roles was not saved');
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('refuses to replace a template unless asked to overwrite', async () => {
    jest.mocked(saveSpaceTemplate).mockResolvedValue({ ok: false, reason: 'exists' });
    const result = await call('jira_admin_save_space_template', {
      space: 'OPS',
      name: 'Ops standard',
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/already exists\. Pass overwrite: true/);
  });
});

describe('jira_admin_list_space_templates and jira_admin_compare_space_to_template', () => {
  it('lists templates, marking one saved from another site', async () => {
    jest
      .mocked(listSpaceTemplates)
      .mockResolvedValue([
        template(),
        template({ id: 'b1', name: 'Legacy', cloudId: 'cloud-2', sourceSpaceKey: 'OLD' }),
      ]);
    const result = text(await call('jira_admin_list_space_templates'));
    expect(result).toContain(
      '• Ops standard — software, from OPS — How operations spaces are set up'
    );
    expect(result).toContain(
      '• Legacy — software, from OLD — How operations spaces are set up — another Jira site, not usable here'
    );
  });

  it('reports a space that matches its template, and one that drifted', async () => {
    jest.mocked(findSpaceTemplate).mockResolvedValue(template());
    expect(
      text(
        await call('jira_admin_compare_space_to_template', {
          space: 'OPS',
          template: 'Ops standard',
        })
      )
    ).toMatch(/^OPS matches the template “Ops standard”/);

    site['/rest/api/3/workflowscheme/project?projectId=10000'] = [
      200,
      { values: [{ workflowScheme: { id: '99', name: 'Finance workflows' } }] },
    ];
    const drifted = text(
      await call('jira_admin_compare_space_to_template', { space: 'OPS', template: 'Ops standard' })
    );
    expect(drifted).toBe(
      'OPS differs from the template “Ops standard” in 1 way:\n' +
        '• Workflows: the template has “OPS workflows”, OPS has “Finance workflows”.'
    );
  });

  it('will not compare against a template from another site', async () => {
    jest.mocked(findSpaceTemplate).mockResolvedValue(template({ cloudId: 'cloud-2' }));
    const result = await call('jira_admin_compare_space_to_template', {
      space: 'OPS',
      template: 'Ops standard',
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/saved from another Jira site/);
  });
});

describe('jira_admin_propose_space', () => {
  const proposal = {
    key: 'fin',
    name: 'Finance',
    lead: 'dana@acme.com',
    template: 'Ops standard',
    members: [
      { role: 'Administrators', users: ['dana@acme.com'] },
      { role: 'Viewers', groups: ['finance-team'], users: ['sam@acme.com'] },
    ],
    reason: 'Finance is moving off spreadsheets',
  };

  it('checks everything it can, stores the operations, and links the review page', async () => {
    jest.mocked(findSpaceTemplate).mockResolvedValue(template());

    const result = await call('jira_admin_propose_space', proposal);

    expect(result.isError).toBeUndefined();
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
    const input = jest.mocked(createChangeRequest).mock.calls[0]?.[1];
    expect(input).toMatchObject({
      kind: 'create_space',
      cloudId: 'cloud-1',
      title: 'New space FIN “Finance”, from template “Ops standard”',
      reason: 'Finance is moving off spreadsheets',
      payload: {
        source: {
          kind: 'template',
          id: 'a0a0a0a0-1111-4222-8333-444455556666',
          name: 'Ops standard',
        },
        workflowUsage: { count: 2, more: false },
        operations: [
          {
            op: 'create_space',
            key: 'FIN',
            name: 'Finance',
            lead: { accountId: 'acct-dana', displayName: 'Dana Admin' },
            schemes: documentFromSpace(OPS).schemes,
          },
          {
            op: 'add_role_members',
            roleName: 'Administrators',
            groups: [{ groupId: 'g-admins', name: 'ops-admins' }],
            users: [{ accountId: 'acct-dana', displayName: 'Dana Admin' }],
          },
          {
            op: 'add_role_members',
            roleName: 'Developers',
            groups: [{ groupId: 'g-users', name: 'jira-software-users' }],
            users: [],
          },
          {
            op: 'add_role_members',
            roleId: '10003',
            roleName: 'Viewers',
            groups: [{ groupId: 'g-fin', name: 'finance-team' }],
            users: [{ accountId: 'acct-sam', displayName: 'Sam Dev' }],
          },
        ],
      },
    });

    const link = `https://renkei.example/acme/jira-admin/changes/${CHANGE_ID}`;
    expect(text(result)).toContain('Proposed — nothing has been created in Jira yet.');
    expect(text(result)).toContain(
      '• [access] Create the software space FIN — “Finance” — led by Dana Admin, on the schemes of template “Ops standard”'
    );
    expect(text(result)).toContain('    Workflows: “OPS workflows” — shared with 2 spaces');
    expect(text(result)).toContain(
      '• [access] Add group “finance-team”, Sam Dev to the Viewers role'
    );
    expect(text(result)).toContain(`Review and apply: ${link}`);
    expect(result._meta?.['renkei/act']).toEqual({ url: link });
  });

  it('builds like a live space, copying its groups and saying its people were not copied', async () => {
    const result = await call('jira_admin_propose_space', {
      key: 'FIN',
      name: 'Finance',
      lead: 'dana@acme.com',
      likeSpace: 'OPS',
    });
    expect(result.isError).toBeUndefined();
    expect(jest.mocked(createChangeRequest).mock.calls[0]?.[1]).toMatchObject({
      title: 'New space FIN “Finance”, like OPS',
      payload: { source: { kind: 'space', key: 'OPS' } },
    });
    expect(text(result)).toContain(
      'The 1 person in OPS’s roles is not copied; name anyone who should be in the new space in members.'
    );
  });

  it.each([
    [{ ...proposal, key: 'finance-2026' }, /is not a space key Jira accepts/],
    [{ ...proposal, likeSpace: 'OPS' }, /Pass exactly one of template/],
    [{ ...proposal, template: undefined }, /Pass exactly one of template/],
  ])('refuses a malformed request before reading anything: %#', async (args, reason) => {
    const result = await call('jira_admin_propose_space', args);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(reason);
    expect(createChangeRequest).not.toHaveBeenCalled();
  });

  it('refuses a key or a name already in use', async () => {
    jest.mocked(findSpaceTemplate).mockResolvedValue(template());
    site['/rest/api/3/projectvalidate/key?key=FIN'] = [
      200,
      { errors: { projectKey: 'A project with that project key already exists.' } },
    ];
    expect(text(await call('jira_admin_propose_space', proposal))).toBe(
      'FIN cannot be used: A project with that project key already exists.'
    );

    site['/rest/api/3/projectvalidate/key?key=FIN'] = [200, { errors: {} }];
    site['/rest/api/3/project/search?maxResults=50&query=Finance'] = [
      200,
      { values: [{ key: 'FINO', name: 'finance' }] },
    ];
    expect(text(await call('jira_admin_propose_space', proposal))).toBe(
      'A space is already named “Finance” (FINO).'
    );
    expect(createChangeRequest).not.toHaveBeenCalled();
  });

  it('refuses a template from another site, or one whose schemes are gone', async () => {
    jest.mocked(findSpaceTemplate).mockResolvedValue(template({ cloudId: 'cloud-2' }));
    expect(text(await call('jira_admin_propose_space', proposal))).toMatch(
      /was saved from another Jira site/
    );

    jest.mocked(findSpaceTemplate).mockResolvedValue(template());
    delete site['/rest/api/3/workflowscheme/13'];
    expect(text(await call('jira_admin_propose_space', proposal))).toMatch(
      /^The template “Ops standard” names the workflows scheme “OPS workflows” \(id 13\)/
    );
    expect(createChangeRequest).not.toHaveBeenCalled();
  });

  it('refuses a role, person or group it cannot find, naming what it could', async () => {
    jest.mocked(findSpaceTemplate).mockResolvedValue(template());
    expect(
      text(
        await call('jira_admin_propose_space', {
          ...proposal,
          members: [{ role: 'Approvers', users: ['sam@acme.com'] }],
        })
      )
    ).toBe('No project role is named “Approvers”. Roles: Administrators, Developers, Viewers.');
    expect(
      text(await call('jira_admin_propose_space', { ...proposal, lead: 'nobody@acme.com' }))
    ).toMatch(/^Lead: Looking up "nobody@acme.com"/);
    expect(createChangeRequest).not.toHaveBeenCalled();
  });
});
