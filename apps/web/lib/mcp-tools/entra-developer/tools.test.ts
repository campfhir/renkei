/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The entra_ tools against a fake Graph: which tools the grant's scopes
 * register, what each read asks for and tells the model, and — above all —
 * that every write is a preview card first, resolves what a person said
 * (a name, an address) into directory ids, sends exactly the documented
 * Graph shape on confirm, and never guesses at an ambiguous reference.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
// client.ts imports these for resolveEntraAccess, which the stub auth
// below replaces — kept inert so the module loads without a database.
jest.mock('@renkei/db', () => ({ getDatabase: () => ({ ok: false }) }));
jest.mock('@renkei/crypto', () => ({ parseEncryptionKey: () => ({ ok: false }) }));
jest.mock('@renkei/provider-grants', () => ({ ENTRA_DEVELOPER: 'entra-developer' }));
jest.mock('@renkei/connector-microsoft', () => ({
  GRAPH_BASE_URL: 'https://graph.microsoft.com/v1.0',
}));
jest.mock('@/lib/entra-developer-app', () => ({ getEntraDeveloperApp: jest.fn() }));
jest.mock('../widgets', () => ({
  APP_ONLY_META: { ui: { visibility: ['app'] } },
  DIRECTORY_ACTION_PREVIEW_URI: 'ui://widget/directory-action-preview.test.html',
  confirmGuard: (tool: string) => ` Only the card invokes this; call ${tool} instead.`,
  newPreviewId: () => 'preview-1',
  previewToolMeta: (uri: string) => ({ ui: { resourceUri: uri, kind: 'approval' } }),
}));

import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { registerEntraDeveloperTools } from './index';
import type { EntraAuth } from './entra-auth';

type ToolResult = {
  content: { type: string; text?: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;
type ToolConfig = {
  annotations?: { readOnlyHint?: boolean };
  _meta?: Record<string, unknown>;
  description: string;
};

const BASE = 'https://graph.microsoft.com/v1.0';
const ALL_SCOPES = [
  'Application.Read.All',
  'Application.ReadWrite.All',
  'AppRoleAssignment.ReadWrite.All',
  'User.ReadBasic.All',
  'Group.Read.All',
];

/** `METHOD path+query` → [status, body]; anything unlisted answers 404. */
let graph: Record<string, [number, unknown]>;
let requests: { method: string; path: string; body: unknown; headers: Record<string, string> }[];

const stubAuth: EntraAuth = {
  kind: 'oauth',
  resolve: async () => ({
    accessToken: 't',
    accountId: 'oid-me',
    upn: 'dana@contoso.com',
    tenantId: 'tenant-dir',
  }),
};

async function tools(
  scopes: string[] | undefined = ALL_SCOPES
): Promise<{ handlers: Map<string, ToolHandler>; configs: Map<string, ToolConfig> }> {
  const handlers = new Map<string, ToolHandler>();
  const configs = new Map<string, ToolConfig>();
  const server = {
    registerTool: (name: string, config: ToolConfig, handler: ToolHandler) => {
      handlers.set(name, handler);
      configs.set(name, config);
    },
  } as unknown as McpServer;
  await registerEntraDeveloperTools(
    server,
    { tenantId: 'tenant-1', subject: 'subject-1', entraDeveloperScopes: scopes } as MCPToolContext,
    stubAuth
  );
  return { handlers, configs };
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const handler = (await tools()).handlers.get(name);
  if (!handler) throw new Error(`${name} is not registered`);
  return handler(args);
}

const text = (result: ToolResult) => result.content[0]?.text ?? '';
const sent = (method: string, prefix: string) =>
  requests.filter((r) => r.method === method && r.path.startsWith(prefix));

const APP_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';
const SP_ID = '33333333-3333-4333-8333-333333333333';
const ROLE_ADMIN = '44444444-4444-4444-8444-444444444444';
const ROLE_READER = '55555555-5555-4555-8555-555555555555';
const USER_JANE = '66666666-6666-4666-8666-666666666666';
const GROUP_FIN = '77777777-7777-4777-8777-777777777777';

const roles = [
  {
    id: ROLE_ADMIN,
    displayName: 'Administrator',
    description: 'Runs the app',
    value: 'Admin',
    isEnabled: true,
    allowedMemberTypes: ['User'],
  },
  {
    id: ROLE_READER,
    displayName: 'Reader',
    description: 'Reads the app',
    value: 'Reader',
    isEnabled: true,
    allowedMemberTypes: ['User'],
  },
];

const payroll = {
  id: APP_ID,
  appId: CLIENT_ID,
  displayName: 'Payroll',
  description: 'Pays people',
  signInAudience: 'AzureADMyOrg',
  createdDateTime: '2026-09-01T00:00:00Z',
  identifierUris: [`api://${CLIENT_ID}`],
  web: { redirectUris: ['https://payroll.contoso.com/auth'] },
  spa: { redirectUris: [] },
  publicClient: { redirectUris: [] },
  appRoles: roles,
};

const payrollSp = {
  id: SP_ID,
  appId: CLIENT_ID,
  displayName: 'Payroll',
  accountEnabled: true,
  servicePrincipalType: 'Application',
  appOwnerOrganizationId: 'tenant-dir',
  appRoleAssignmentRequired: true,
  appRoles: roles,
};

const APP_SELECT =
  '$select=id,appId,displayName,description,signInAudience,createdDateTime,identifierUris,web,spa,publicClient,appRoles,tags,notes';
const SP_SELECT =
  '$select=id,appId,displayName,accountEnabled,servicePrincipalType,appOwnerOrganizationId,appRoleAssignmentRequired,appRoles,tags,loginUrl,replyUrls,homepage';
const USER_SELECT = '$select=id,displayName,mail,userPrincipalName,jobTitle,department';
const GROUP_SELECT = '$select=id,displayName,mail,securityEnabled,groupTypes,description';

/** The site with Payroll registered, its enterprise application, Jane and Finance. */
function seedPayroll() {
  graph[`GET /applications/${APP_ID}?${APP_SELECT}`] = [200, payroll];
  graph[
    `GET /applications?$filter=${encodeURIComponent("displayName eq 'Payroll'")}&$top=5&${APP_SELECT}`
  ] = [200, { value: [payroll] }];
  graph[`GET /servicePrincipals/${SP_ID}?${SP_SELECT}`] = [200, payrollSp];
  graph[
    `GET /servicePrincipals?$filter=${encodeURIComponent(`appId eq '${CLIENT_ID}'`)}&$top=1&${SP_SELECT}`
  ] = [200, { value: [payrollSp] }];
  graph[
    `GET /servicePrincipals?$filter=${encodeURIComponent("displayName eq 'Payroll'")}&$top=5&${SP_SELECT}`
  ] = [200, { value: [payrollSp] }];
  graph[`GET /servicePrincipals/${SP_ID}/appRoleAssignedTo?$top=100`] = [
    200,
    {
      value: [
        {
          id: 'assign-1',
          appRoleId: ROLE_READER,
          principalId: USER_JANE,
          principalDisplayName: 'Jane Doe',
          principalType: 'User',
          resourceId: SP_ID,
        },
      ],
    },
  ];
  graph[
    `GET /users?$filter=${encodeURIComponent("userPrincipalName eq 'jane@contoso.com' or mail eq 'jane@contoso.com'")}&$top=5&${USER_SELECT}`
  ] = [200, { value: [{ id: USER_JANE, displayName: 'Jane Doe', mail: 'jane@contoso.com' }] }];
  graph[
    `GET /groups?$filter=${encodeURIComponent("mail eq 'jane@contoso.com'")}&$top=5&${GROUP_SELECT}`
  ] = [200, { value: [] }];
  graph[`GET /users/${USER_JANE}?${USER_SELECT}`] = [
    200,
    { id: USER_JANE, displayName: 'Jane Doe', mail: 'jane@contoso.com' },
  ];
  graph[
    `GET /users?$filter=${encodeURIComponent("displayName eq 'Finance'")}&$top=5&${USER_SELECT}`
  ] = [200, { value: [] }];
  graph[
    `GET /groups?$filter=${encodeURIComponent("displayName eq 'Finance'")}&$top=5&${GROUP_SELECT}`
  ] = [200, { value: [{ id: GROUP_FIN, displayName: 'Finance', securityEnabled: true }] }];
  graph[`GET /groups/${GROUP_FIN}?${GROUP_SELECT}`] = [
    200,
    { id: GROUP_FIN, displayName: 'Finance', securityEnabled: true },
  ];
  graph[`GET /users/${GROUP_FIN}?${USER_SELECT}`] = [404, {}];
}

beforeEach(() => {
  graph = {};
  requests = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.startsWith(BASE) ? url.slice(BASE.length) : url;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({
      method,
      path,
      body,
      headers: { ...(init?.headers as Record<string, string>) },
    });
    const [status, answer] = graph[`${method} ${path}`] ?? [
      404,
      { error: { code: 'Request_ResourceNotFound', message: 'No such thing.' } },
    ];
    return new Response(status === 204 ? null : JSON.stringify(answer), { status });
  }) as unknown as typeof fetch;
});

describe('registration', () => {
  it('registers only the tools the grant’s scopes can serve', async () => {
    const readOnly = [...(await tools(['Application.Read.All'])).handlers.keys()];
    expect(readOnly).toEqual(
      expect.arrayContaining([
        'entra_check_access',
        'entra_list_applications',
        'entra_get_application',
        'entra_list_enterprise_applications',
        'entra_get_enterprise_application',
      ])
    );
    expect(readOnly).not.toContain('entra_search_users');
    expect(readOnly).not.toContain('entra_create_application_preview');
    expect(readOnly).not.toContain('entra_assign_app_role_preview');

    const writer = [
      ...(await tools(['Application.Read.All', 'Application.ReadWrite.All'])).handlers.keys(),
    ];
    expect(writer).toContain('entra_create_application_preview');
    expect(writer).toContain('entra_add_app_roles_confirm');
    // Assigning needs the assignment scope even with full application rights.
    expect(writer).not.toContain('entra_assign_app_role_preview');

    const assigner = [
      ...(await tools(['Application.Read.All', 'AppRoleAssignment.ReadWrite.All'])).handlers.keys(),
    ];
    expect(assigner).toContain('entra_assign_app_role_preview');
    expect(assigner).toContain('entra_remove_app_role_assignment_confirm');
    expect(assigner).not.toContain('entra_create_application_preview');

    // An older grant with no recorded scopes registers everything.
    expect((await tools(undefined)).handlers.size).toBe(21);
  });

  it('makes every write a preview card whose confirm only the card may call', async () => {
    const { configs } = await tools();
    const writes = [...configs.entries()].filter(([, c]) => c.annotations?.readOnlyHint !== true);
    expect(writes.map(([name]) => name).sort()).toEqual(
      [
        'entra_add_app_roles_confirm',
        'entra_add_app_roles_preview',
        'entra_assign_app_role_confirm',
        'entra_assign_app_role_preview',
        'entra_create_application_confirm',
        'entra_create_application_preview',
        'entra_create_enterprise_application_confirm',
        'entra_create_enterprise_application_preview',
        'entra_remove_app_role_assignment_confirm',
        'entra_remove_app_role_assignment_preview',
        'entra_remove_app_role_confirm',
        'entra_remove_app_role_preview',
        'entra_update_application_confirm',
        'entra_update_application_preview',
      ].sort()
    );
    for (const [name, config] of writes) {
      if (name.endsWith('_preview')) {
        expect(config._meta).toEqual({
          ui: { resourceUri: 'ui://widget/directory-action-preview.test.html', kind: 'approval' },
        });
      } else {
        expect(config._meta).toEqual({ ui: { visibility: ['app'] } });
        expect(config.description).toContain(name.replace(/_confirm$/, '_preview'));
      }
    }
    for (const [name] of configs) {
      if (!name.endsWith('_preview') && !name.endsWith('_confirm')) {
        expect(configs.get(name)?.annotations?.readOnlyHint).toBe(true);
      }
    }
  });
});

describe('entra_check_access', () => {
  it('says who is connected, what the token carries and what Entra lets it read', async () => {
    graph['GET /me?$select=id,displayName,userPrincipalName'] = [
      200,
      { id: 'oid-me', displayName: 'Dana Dev', userPrincipalName: 'dana@contoso.com' },
    ];
    graph['GET /applications?$top=1&$select=id'] = [200, { value: [] }];
    graph['GET /servicePrincipals?$top=1&$select=id'] = [
      403,
      { error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges.' } },
    ];
    const answer = text(await call('entra_check_access'));
    expect(answer).toContain('Connected as Dana Dev (dana@contoso.com) in directory tenant-dir');
    expect(answer).toContain('Read app registrations: yes.');
    expect(answer).toContain('Read enterprise applications: no — Graph refused (403)');
    expect(answer).toContain('Insufficient privileges.');
    expect(answer).toContain('Assign app roles: the token allows it.');
  });

  it('hands the auth seam’s refusal straight back', async () => {
    const handlers = new Map<string, ToolHandler>();
    const server = {
      registerTool: (name: string, _c: unknown, h: ToolHandler) => handlers.set(name, h),
    } as unknown as McpServer;
    await registerEntraDeveloperTools(
      server,
      { tenantId: 'tenant-1', subject: 'subject-1' } as MCPToolContext,
      { kind: 'oauth', resolve: async () => 'Entra Developer is not connected.' }
    );
    const result = await handlers.get('entra_list_applications')!({});
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('Entra Developer is not connected.');
    expect(requests).toHaveLength(0);
  });
});

describe('reads', () => {
  it('lists app registrations by partial name through $search with eventual consistency', async () => {
    graph[
      `GET /applications?$search=${encodeURIComponent('"displayName:pay"')}&$count=true&$top=25&$select=id,appId,displayName,createdDateTime,signInAudience,appRoles`
    ] = [200, { value: [payroll] }];
    const answer = text(await call('entra_list_applications', { query: 'pay' }));
    expect(answer).toContain('1 app registration:');
    expect(answer).toContain(
      `• Payroll — id ${APP_ID}, appId ${CLIENT_ID}, AzureADMyOrg, 2 app roles`
    );
    expect(requests[0].headers).toMatchObject({ ConsistencyLevel: 'eventual' });
  });

  it('gets a registration by exact name, with its roles and whether it has an enterprise application', async () => {
    seedPayroll();
    const answer = text(await call('entra_get_application', { application: 'Payroll' }));
    expect(answer).toContain(`Application (client) id: ${CLIENT_ID}`);
    expect(answer).toContain('Web redirect URIs: https://payroll.contoso.com/auth');
    expect(answer).toContain(
      '• Administrator [Admin] — Runs the app (User; id ' + ROLE_ADMIN + ')'
    );
    expect(answer).toContain(`Enterprise application: yes — object id ${SP_ID}`);
  });

  it('falls back from object id to application (client) id for a pasted GUID', async () => {
    seedPayroll();
    graph[`GET /applications(appId='${CLIENT_ID}')?${APP_SELECT}`] = [200, payroll];
    const answer = text(await call('entra_get_application', { application: CLIENT_ID }));
    expect(answer).toContain('Payroll — app registration');
    expect(requests.map((r) => r.path)[0]).toBe(`/applications/${CLIENT_ID}?${APP_SELECT}`);
  });

  it('refuses an ambiguous name with the ids that exist', async () => {
    graph[
      `GET /applications?$filter=${encodeURIComponent("displayName eq 'Payroll'")}&$top=5&${APP_SELECT}`
    ] = [200, { value: [payroll, { ...payroll, id: 'other-id', appId: 'other-app' }] }];
    const result = await call('entra_get_application', { application: 'Payroll' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('2 app registrations are named "Payroll"');
    expect(text(result)).toContain('other-id (appId other-app)');
  });

  it('shows an enterprise application’s roles and who holds each', async () => {
    seedPayroll();
    const answer = text(
      await call('entra_get_enterprise_application', { enterpriseApplication: SP_ID })
    );
    expect(answer).toContain('Assignment required: yes');
    expect(answer).toContain('• Jane Doe (user) → Reader — assignment id assign-1');
  });

  it('lists this directory’s own enterprise applications by default', async () => {
    const filter = encodeURIComponent(
      "servicePrincipalType eq 'Application' and appOwnerOrganizationId eq tenant-dir"
    );
    graph[
      `GET /servicePrincipals?$filter=${filter}&$count=true&$top=25&$select=id,appId,displayName,accountEnabled,appOwnerOrganizationId,appRoleAssignmentRequired,appRoles`
    ] = [200, { value: [payrollSp] }];
    const answer = text(await call('entra_list_enterprise_applications'));
    expect(answer).toContain(
      `• Payroll — id ${SP_ID}, appId ${CLIENT_ID}, enabled, 2 app roles, assignment required`
    );
  });

  it('finds people and groups by partial name', async () => {
    graph[
      `GET /users?$search=${encodeURIComponent('"displayName:jan" OR "mail:jan" OR "userPrincipalName:jan"')}&$count=true&$top=25&${USER_SELECT}`
    ] = [
      200,
      {
        value: [
          { id: USER_JANE, displayName: 'Jane Doe', mail: 'jane@contoso.com', jobTitle: 'Analyst' },
        ],
      },
    ];
    expect(text(await call('entra_search_users', { query: 'jan' }))).toContain(
      `• Jane Doe — jane@contoso.com, Analyst — id ${USER_JANE}`
    );
    graph[
      `GET /groups?$search=${encodeURIComponent('"displayName:fin" OR "mail:fin"')}&$count=true&$top=25&${GROUP_SELECT}`
    ] = [200, { value: [{ id: GROUP_FIN, displayName: 'Finance', securityEnabled: true }] }];
    expect(text(await call('entra_search_groups', { query: 'fin' }))).toContain(
      `• Finance (security) — id ${GROUP_FIN}`
    );
  });
});

describe('entra_create_application', () => {
  it('previews what will be sent, then creates the registration and its enterprise application', async () => {
    const args = {
      displayName: 'Timesheets',
      webRedirectUris: ['https://timesheets.contoso.com/callback'],
      appRoles: [{ displayName: 'Approver', value: 'Timesheet.Approve', description: 'Approves' }],
    };
    const preview = await call('entra_create_application_preview', args);
    expect(preview.structuredContent).toMatchObject({
      kind: 'directory_action',
      action: 'Create application',
      title: 'Create Timesheets',
      person: { name: 'Timesheets' },
      confirmTool: 'entra_create_application_confirm',
      confirmLabel: 'Create application',
      confirmArgs: args,
    });
    expect(preview.structuredContent?.fields).toEqual(
      expect.arrayContaining([
        { label: 'Sign-in audience', value: 'This organization only (single tenant)' },
        { label: 'Enterprise application', value: 'Created alongside' },
      ])
    );
    expect(requests).toHaveLength(0);

    graph['POST /applications'] = [
      201,
      { ...payroll, id: 'new-app', appId: 'new-client', displayName: 'Timesheets' },
    ];
    graph['POST /servicePrincipals'] = [201, { id: 'new-sp', appId: 'new-client' }];
    const answer = text(await call('entra_create_application_confirm', args));
    const [created] = sent('POST', '/applications');
    expect(created.body).toMatchObject({
      displayName: 'Timesheets',
      signInAudience: 'AzureADMyOrg',
      web: { redirectUris: ['https://timesheets.contoso.com/callback'] },
    });
    const [role] = (created.body as { appRoles: Record<string, unknown>[] }).appRoles;
    expect(role).toMatchObject({
      displayName: 'Approver',
      value: 'Timesheet.Approve',
      allowedMemberTypes: ['User'],
      isEnabled: true,
    });
    expect(role.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent('POST', '/servicePrincipals')[0].body).toEqual({ appId: 'new-client' });
    expect(answer).toContain('Created app registration "Timesheets".');
    expect(answer).toContain('Enterprise application: created — object id new-sp');
  });

  it('registers only, when told, and refuses bad redirect URIs and repeated role values', async () => {
    graph['POST /applications'] = [201, { ...payroll, displayName: 'Only' }];
    const answer = text(
      await call('entra_create_application_confirm', {
        displayName: 'Only',
        createEnterpriseApplication: false,
      })
    );
    expect(answer).toContain('Enterprise application: not created, as asked.');
    expect(sent('POST', '/servicePrincipals')).toHaveLength(0);

    const insecure = await call('entra_create_application_preview', {
      displayName: 'X',
      webRedirectUris: ['http://timesheets.contoso.com/callback'],
    });
    expect(insecure.isError).toBe(true);
    expect(text(insecure)).toContain('http://timesheets.contoso.com/callback');

    const repeated = await call('entra_create_application_preview', {
      displayName: 'X',
      appRoles: [
        { displayName: 'A', value: 'Same', description: 'a' },
        { displayName: 'B', value: 'same', description: 'b' },
      ],
    });
    expect(repeated.isError).toBe(true);
    expect(text(repeated)).toContain('same');
  });

  it('surfaces Graph’s own reason when the create is refused', async () => {
    graph['POST /applications'] = [
      403,
      {
        error: {
          code: 'Authorization_RequestDenied',
          message: 'Insufficient privileges to complete the operation.',
        },
      },
    ];
    const result = await call('entra_create_application_confirm', { displayName: 'Nope' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('creating applications may be restricted to admins');
    expect(text(result)).toContain('Insufficient privileges to complete the operation.');
  });
});

describe('entra_update_application', () => {
  it('shows old against new and PATCHes only what changed', async () => {
    seedPayroll();
    const preview = await call('entra_update_application_preview', {
      application: 'Payroll',
      webRedirectUris: ['https://payroll.contoso.com/auth', 'https://payroll.contoso.com/auth2'],
    });
    expect(preview.structuredContent?.fields).toEqual([
      {
        label: 'Web redirect URIs',
        value: 'https://payroll.contoso.com/auth\nhttps://payroll.contoso.com/auth2',
        oldValue: 'https://payroll.contoso.com/auth',
      },
    ]);
    expect(preview.structuredContent?.confirmArgs).toMatchObject({ application: APP_ID });

    graph[`PATCH /applications/${APP_ID}`] = [204, null];
    const answer = text(
      await call('entra_update_application_confirm', {
        application: APP_ID,
        webRedirectUris: ['https://payroll.contoso.com/auth2'],
      })
    );
    expect(sent('PATCH', `/applications/${APP_ID}`)[0].body).toEqual({
      web: { redirectUris: ['https://payroll.contoso.com/auth2'] },
    });
    expect(answer).toContain('Changed app registration "Payroll".');
  });

  it('refuses an empty change', async () => {
    const result = await call('entra_update_application_preview', { application: 'Payroll' });
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });
});

describe('entra_create_enterprise_application', () => {
  it('refuses when one exists, and otherwise creates it from the appId', async () => {
    seedPayroll();
    const existing = await call('entra_create_enterprise_application_preview', {
      application: APP_ID,
    });
    expect(existing.isError).toBe(true);
    expect(text(existing)).toContain(`already has an enterprise application (object id ${SP_ID})`);

    graph[
      `GET /servicePrincipals?$filter=${encodeURIComponent(`appId eq '${CLIENT_ID}'`)}&$top=1&${SP_SELECT}`
    ] = [200, { value: [] }];
    const preview = await call('entra_create_enterprise_application_preview', {
      application: APP_ID,
    });
    expect(preview.structuredContent).toMatchObject({
      confirmTool: 'entra_create_enterprise_application_confirm',
      confirmArgs: { application: APP_ID },
    });
    graph['POST /servicePrincipals'] = [201, { id: 'sp-new' }];
    const answer = text(
      await call('entra_create_enterprise_application_confirm', { application: APP_ID })
    );
    expect(sent('POST', '/servicePrincipals')[0].body).toEqual({ appId: CLIENT_ID });
    expect(answer).toContain('object id sp-new');
  });
});

describe('app roles', () => {
  it('adds roles by merging with the ones the registration already has', async () => {
    seedPayroll();
    const preview = await call('entra_add_app_roles_preview', {
      application: 'Payroll',
      appRoles: [
        {
          displayName: 'Auditor',
          value: 'Audit',
          description: 'Audits',
          allowedMemberTypes: ['User', 'Application'],
        },
      ],
    });
    expect(preview.structuredContent?.groupLists).toEqual([
      {
        label: 'Roles to add',
        groups: ['Auditor [Audit] — Audits (User/Application)'],
        tone: 'add',
      },
      {
        label: 'Roles it already has',
        groups: ['Administrator [Admin]', 'Reader [Reader]'],
        tone: 'muted',
      },
    ]);

    const taken = await call('entra_add_app_roles_preview', {
      application: 'Payroll',
      appRoles: [{ displayName: 'Again', value: 'admin', description: 'dup' }],
    });
    expect(taken.isError).toBe(true);
    expect(text(taken)).toContain('admin');

    graph[`PATCH /applications/${APP_ID}`] = [204, null];
    graph[`GET /applications/${APP_ID}?$select=id,appId,displayName,appRoles`] = [
      200,
      {
        ...payroll,
        appRoles: [
          ...roles,
          {
            id: 'r3',
            displayName: 'Auditor',
            value: 'Audit',
            description: 'Audits',
            isEnabled: true,
            allowedMemberTypes: ['User', 'Application'],
          },
        ],
      },
    ];
    const answer = text(
      await call('entra_add_app_roles_confirm', {
        application: APP_ID,
        appRoles: [
          {
            displayName: 'Auditor',
            value: 'Audit',
            description: 'Audits',
            allowedMemberTypes: ['User', 'Application'],
          },
        ],
      })
    );
    const patched = sent('PATCH', `/applications/${APP_ID}`)[0].body as {
      appRoles: Record<string, unknown>[];
    };
    expect(patched.appRoles).toHaveLength(3);
    expect(patched.appRoles.slice(0, 2)).toEqual(roles);
    expect(patched.appRoles[2]).toMatchObject({ value: 'Audit', isEnabled: true });
    expect(answer).toContain('Added 1 app role to "Payroll".');
    expect(answer).toContain('App roles now (3):');
  });

  it('removes a role by disabling it first, naming who held it on the preview', async () => {
    seedPayroll();
    const preview = await call('entra_remove_app_role_preview', {
      application: 'Payroll',
      appRole: 'reader',
    });
    expect(preview.structuredContent?.fields).toEqual([
      { label: 'Role', value: `Reader [Reader] — Reads the app (User; id ${ROLE_READER})` },
      { label: 'Currently assigned', value: 'Jane Doe' },
    ]);
    expect(preview.structuredContent?.confirmArgs).toEqual({
      application: APP_ID,
      appRole: ROLE_READER,
    });

    graph[`PATCH /applications/${APP_ID}`] = [204, null];
    const answer = text(
      await call('entra_remove_app_role_confirm', { application: APP_ID, appRole: ROLE_READER })
    );
    const patches = sent('PATCH', `/applications/${APP_ID}`).map(
      (r) => r.body as { appRoles: Record<string, unknown>[] }
    );
    expect(patches).toHaveLength(2);
    expect(patches[0].appRoles.find((r) => r.id === ROLE_READER)).toMatchObject({
      isEnabled: false,
    });
    expect(patches[1].appRoles.map((r) => r.id)).toEqual([ROLE_ADMIN]);
    expect(answer).toContain('Removed app role "Reader" [Reader] from "Payroll".');
  });

  it('refuses a role that is not there, listing what is', async () => {
    seedPayroll();
    const result = await call('entra_remove_app_role_preview', {
      application: 'Payroll',
      appRole: 'Owner',
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('No app role has id, value or name "Owner"');
    expect(text(result)).toContain('Administrator [Admin]');
  });
});

describe('assignments', () => {
  it('resolves an address and a group name, skips whoever already holds the role, then POSTs one assignment each', async () => {
    seedPayroll();
    const preview = await call('entra_assign_app_role_preview', {
      enterpriseApplication: 'Payroll',
      appRole: 'Reader',
      assignees: ['jane@contoso.com', 'Finance'],
    });
    expect(preview.structuredContent).toMatchObject({
      action: 'Assign app role',
      title: 'Assign Reader on Payroll',
      person: { name: 'Finance', detail: 'Finance (security group)' },
      secondaryPerson: { label: 'Application', name: 'Payroll' },
      groupLists: [
        { label: 'Will be assigned', groups: ['Finance (security group)'], tone: 'add' },
        {
          label: 'Already assigned (skipped)',
          groups: ['Jane Doe (jane@contoso.com)'],
          tone: 'muted',
        },
      ],
      confirmArgs: { enterpriseApplication: SP_ID, appRole: ROLE_READER, assignees: [GROUP_FIN] },
    });

    graph[`POST /servicePrincipals/${SP_ID}/appRoleAssignedTo`] = [201, { id: 'assign-2' }];
    const answer = text(
      await call('entra_assign_app_role_confirm', {
        enterpriseApplication: SP_ID,
        appRole: ROLE_READER,
        assignees: [GROUP_FIN],
      })
    );
    expect(sent('POST', `/servicePrincipals/${SP_ID}/appRoleAssignedTo`)[0].body).toEqual({
      principalId: GROUP_FIN,
      resourceId: SP_ID,
      appRoleId: ROLE_READER,
    });
    expect(answer).toBe('Assigned Reader on "Payroll" to: Finance (security group).');
  });

  it('uses the default role when the application defines none, and insists on one when it does', async () => {
    seedPayroll();
    const PLAIN = '88888888-8888-4888-8888-888888888888';
    const noRoles = { ...payrollSp, id: PLAIN, appRoles: [] };
    graph[`GET /servicePrincipals/${PLAIN}?${SP_SELECT}`] = [200, noRoles];
    graph[`GET /servicePrincipals/${PLAIN}/appRoleAssignedTo?$top=100`] = [200, { value: [] }];
    graph[`POST /servicePrincipals/${PLAIN}/appRoleAssignedTo`] = [201, { id: 'a' }];
    const answer = text(
      await call('entra_assign_app_role_confirm', {
        enterpriseApplication: PLAIN,
        assignees: [USER_JANE],
      })
    );
    expect(sent('POST', `/servicePrincipals/${PLAIN}/appRoleAssignedTo`)[0].body).toMatchObject({
      appRoleId: '00000000-0000-0000-0000-000000000000',
    });
    expect(answer).toContain('Assigned Default Access on "Payroll" to: Jane Doe');

    const ambiguous = await call('entra_assign_app_role_preview', {
      enterpriseApplication: SP_ID,
      assignees: [USER_JANE],
    });
    expect(ambiguous.isError).toBe(true);
    expect(text(ambiguous)).toContain('say which one: Admin, Reader');
  });

  it('never guesses at an unknown assignee', async () => {
    seedPayroll();
    graph[
      `GET /users?$filter=${encodeURIComponent("displayName eq 'Nobody'")}&$top=5&${USER_SELECT}`
    ] = [200, { value: [] }];
    graph[
      `GET /groups?$filter=${encodeURIComponent("displayName eq 'Nobody'")}&$top=5&${GROUP_SELECT}`
    ] = [200, { value: [] }];
    const result = await call('entra_assign_app_role_preview', {
      enterpriseApplication: SP_ID,
      appRole: 'Admin',
      assignees: ['Nobody'],
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('No user or group matches "Nobody" exactly');
    expect(sent('POST', '/')).toHaveLength(0);
  });

  it('removes an assignment by its id, skipping anyone who does not hold the role', async () => {
    seedPayroll();
    const preview = await call('entra_remove_app_role_assignment_preview', {
      enterpriseApplication: SP_ID,
      appRole: 'Reader',
      assignees: [USER_JANE, GROUP_FIN],
    });
    expect(preview.structuredContent).toMatchObject({
      action: 'Remove app role assignment',
      groupLists: [
        {
          label: 'Will lose the role',
          groups: ['Jane Doe (jane@contoso.com)'],
          tone: 'remove',
        },
        { label: 'Do not hold it (skipped)', groups: ['Finance (security group)'], tone: 'muted' },
      ],
      confirmArgs: { enterpriseApplication: SP_ID, appRole: ROLE_READER, assignees: [USER_JANE] },
    });
    graph[`DELETE /servicePrincipals/${SP_ID}/appRoleAssignedTo/assign-1`] = [204, null];
    const answer = text(
      await call('entra_remove_app_role_assignment_confirm', {
        enterpriseApplication: SP_ID,
        appRole: ROLE_READER,
        assignees: [USER_JANE],
      })
    );
    expect(sent('DELETE', `/servicePrincipals/${SP_ID}/appRoleAssignedTo/assign-1`)).toHaveLength(
      1
    );
    expect(answer).toBe('Removed Reader on "Payroll" from: Jane Doe (jane@contoso.com).');
  });
});
