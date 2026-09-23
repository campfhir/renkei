/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The jira_admin_ read tools against a fake Jira site: what each asks for,
 * and what it tells the model — above all the two things an admin needs
 * before changing anything: which spaces a field context or scheme reaches,
 * and whether the connected account may administer it at all.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
jest.mock('../common', () => ({
  withPresentationHint: (body: string) => body,
}));
// client.ts imports these for resolveJiraAdminAccess, which the stub auth
// below replaces — kept inert so the module loads without a database.
jest.mock('@renkei/db', () => ({ getDatabase: () => ({ ok: false }) }));
jest.mock('@renkei/crypto', () => ({ parseEncryptionKey: () => ({ ok: false }) }));
jest.mock('@renkei/provider-grants', () => ({}));
jest.mock('@/lib/atlassian-app', () => ({ getAtlassianAdminApp: jest.fn() }));

import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { registerJiraAdminTools } from './index';
import type { JiraAdminAuth } from './jira-admin-auth';

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const BASE = 'https://api.atlassian.com/ex/jira/cloud-1';

/** path+query → [status, body]; anything unlisted answers 404. */
let site: Record<string, [number, unknown]>;
let requested: string[];

const stubAuth: JiraAdminAuth = {
  kind: 'oauth',
  resolve: async () => ({
    cloudId: 'cloud-1',
    siteUrl: 'https://acme.atlassian.net',
    accountId: 'acct-1',
    authHeader: 'Bearer t',
  }),
};

async function tools(scopes?: string[]): Promise<Map<string, ToolHandler>> {
  const registered = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  await registerJiraAdminTools(
    server,
    { tenantId: 'tenant-1', subject: 'subject-1', jiraAdminScopes: scopes } as MCPToolContext,
    stubAuth
  );
  return registered;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const handler = (await tools()).get(name);
  if (!handler) throw new Error(`${name} is not registered`);
  return handler(args);
}

const text = (result: ToolResult) => result.content[0]?.text ?? '';

beforeEach(() => {
  site = {};
  requested = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const path = url.startsWith(BASE) ? url.slice(BASE.length) : url;
    requested.push(path);
    const [status, body] = site[path] ?? [404, { errorMessages: ['No such thing.'] }];
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
});

describe('registration', () => {
  it('registers only the tools the grant’s classic scopes can serve', async () => {
    const names = [...(await tools(['read:jira-user', 'read:jira-work'])).keys()];
    expect(names).toEqual(
      expect.arrayContaining([
        'jira_admin_check_access',
        'jira_admin_list_fields',
        'jira_admin_list_plans',
        'jira_admin_get_plan',
      ])
    );
    // Contexts and schemes take manage:jira-configuration.
    expect(names).not.toContain('jira_admin_get_field');
    expect(names).not.toContain('jira_admin_get_space_configuration');
  });

  it('marks every tool read-only but the proposal — and no tool can apply one', async () => {
    const configs: { name: string; readOnly: unknown }[] = [];
    const server = {
      registerTool: (name: string, config: { annotations?: { readOnlyHint?: boolean } }) => {
        configs.push({ name, readOnly: config.annotations?.readOnlyHint });
      },
    } as unknown as McpServer;
    await registerJiraAdminTools(
      server,
      { tenantId: 'tenant-1', subject: 'subject-1' } as MCPToolContext,
      stubAuth
    );
    expect(configs.length).toBe(8);
    // Proposing is an Act tool (read-only mode hides it) that writes only a
    // Renkei change request; applying one is a signed-in browser click, so
    // nothing on the MCP surface applies, confirms or approves anything.
    expect(configs.filter((config) => config.readOnly !== true).map((c) => c.name)).toEqual([
      'jira_admin_propose_option_changes',
    ]);
    expect(configs.some((config) => /apply|confirm|approve/.test(config.name))).toBe(false);
  });
});

describe('jira_admin_check_access', () => {
  beforeEach(() => {
    site['/rest/api/3/myself'] = [200, { accountId: 'acct-1', displayName: 'Dana Admin' }];
    site['/rest/api/3/project/search?action=edit&orderBy=name&maxResults=50'] = [
      200,
      {
        total: 2,
        values: [
          { id: '10000', key: 'OPS', name: 'Operations' },
          { id: '10001', key: 'ENG', name: 'Engineering' },
        ],
      },
    ];
  });

  it('says who is connected, that they are a site admin, and which spaces they run', async () => {
    site['/rest/api/3/mypermissions?permissions=ADMINISTER,ADMINISTER_PROJECTS'] = [
      200,
      {
        permissions: {
          ADMINISTER: { havePermission: true },
          ADMINISTER_PROJECTS: { havePermission: true },
        },
      },
    ];

    const result = text(await call('jira_admin_check_access'));

    expect(result).toContain('Connected as Dana Admin (acct-1) on https://acme.atlassian.net');
    expect(result).toContain('Administer Jira: yes');
    expect(result).toContain('Spaces this account administers (2):');
    expect(result).toContain('• OPS — Operations');
  });

  it('says plainly when site configuration is out of reach', async () => {
    site['/rest/api/3/mypermissions?permissions=ADMINISTER,ADMINISTER_PROJECTS'] = [
      200,
      { permissions: { ADMINISTER: { havePermission: false } } },
    ];

    const result = text(await call('jira_admin_check_access'));

    expect(result).toContain('Administer Jira: no');
    expect(result).toContain('a Jira admin has to make those changes');
  });
});

describe('jira_admin_list_fields', () => {
  it('lists custom fields with type, reach and last use, and pages', async () => {
    site[
      '/rest/api/3/field/search?type=custom&orderBy=name&expand=lastUsed,screensCount,contextsCount,isLocked&startAt=0&maxResults=2&query=impact'
    ] = [
      200,
      {
        total: 3,
        values: [
          {
            id: 'customfield_10321',
            name: 'Clinical Impact',
            schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' },
            contextsCount: 2,
            screensCount: 5,
            lastUsed: { type: 'TRACKED', value: '2026-09-01T10:00:00.000+0000' },
          },
          {
            id: 'customfield_10016',
            name: 'Story point estimate',
            schema: { custom: 'com.pyxis.greenhopper.jira:jsw-story-points' },
            isLocked: true,
            lastUsed: { type: 'NO_INFORMATION' },
          },
        ],
      },
    ];

    const result = text(await call('jira_admin_list_fields', { query: 'impact', max: 2 }));

    expect(result).toContain(
      'Clinical Impact — customfield_10321 — select list (single choice) — contexts: 2, screens: 5 — last changed 2026-09-01'
    );
    expect(result).toContain('story points — no recorded use — locked');
    expect(result).toContain('Showing 1–2 of 3; pass startAt: 2 for the next page.');
  });
});

describe('jira_admin_get_field', () => {
  const FIELD = {
    id: 'customfield_10321',
    name: 'Clinical Impact',
    schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:cascadingselect' },
  };
  const SEARCH =
    '/rest/api/3/field/search?type=custom&expand=lastUsed,screensCount,contextsCount,isLocked&maxResults=50&query=clinical%20impact';

  beforeEach(() => {
    site[SEARCH] = [200, { values: [FIELD, { ...FIELD, id: 'customfield_1', name: 'Impact' }] }];
    site['/rest/api/3/field/customfield_10321/context?maxResults=50'] = [
      200,
      {
        values: [
          { id: '10412', name: 'Default', isGlobalContext: true, isAnyIssueType: true },
          { id: '10413', name: 'OPS only', isGlobalContext: false, isAnyIssueType: false },
        ],
      },
    ];
    site['/rest/api/3/field/customfield_10321/context/projectmapping?maxResults=50'] = [
      200,
      {
        values: [
          { contextId: '10412', isGlobalContext: true },
          { contextId: '10413', projectId: '10000' },
        ],
      },
    ];
    site['/rest/api/3/field/customfield_10321/context/issuetypemapping?maxResults=50'] = [
      200,
      {
        values: [
          { contextId: '10412', isAnyIssueType: true },
          { contextId: '10413', issueTypeId: '10004' },
        ],
      },
    ];
    site['/rest/api/3/project/search?maxResults=50&id=10000'] = [
      200,
      { values: [{ id: '10000', key: 'OPS' }] },
    ];
    site['/rest/api/3/issuetype'] = [200, [{ id: '10004', name: 'Bug' }]];
    site['/rest/api/3/field/customfield_10321/context/10412/option?maxResults=100'] = [
      200,
      {
        total: 3,
        values: [
          { id: '1', value: 'High' },
          { id: '2', value: 'Patient safety', optionId: '1' },
          { id: '3', value: 'Legacy', disabled: true },
        ],
      },
    ];
    site['/rest/api/3/field/customfield_10321/context/10413/option?maxResults=100'] = [
      200,
      { total: 0, values: [] },
    ];
  });

  it('resolves the field by exact name and shows each context’s reach and options', async () => {
    const result = text(await call('jira_admin_get_field', { field: 'clinical impact' }));

    expect(result).toContain('Clinical Impact — customfield_10321 — cascading select');
    expect(result).toContain('• Default (id 10412) — every space · every work type');
    expect(result).toContain('Global: an option added here shows up in every space');
    // Cascading children read as "parent › child"; disabled options say so.
    expect(result).toContain('Options (3): High · High › Patient safety · Legacy (disabled)');
    expect(result).toContain('• OPS only (id 10413) — spaces: OPS · work types: Bug');
    expect(result).toContain('Options: none');
  });

  it('refuses a name several fields share, listing their ids', async () => {
    site[SEARCH] = [200, { values: [FIELD, { ...FIELD, id: 'customfield_20000' }] }];

    const result = await call('jira_admin_get_field', { field: 'clinical impact' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('2 custom fields are named "clinical impact"');
    expect(text(result)).toContain('customfield_20000');
    expect(requested.some((path) => path.includes('/context'))).toBe(false);
  });

  it('passes Jira’s own reason through when a call is refused', async () => {
    site['/rest/api/3/field/customfield_10321/context?maxResults=50'] = [
      403,
      { errorMessages: ['You are not allowed to see this field.'] },
    ];

    const result = await call('jira_admin_get_field', { field: 'clinical impact' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('this needs Administer Jira');
    expect(text(result)).toContain('You are not allowed to see this field.');
  });
});

describe('jira_admin_get_space_configuration', () => {
  it('lists a company-managed space’s schemes, with how widely each is shared, and its roles', async () => {
    site['/rest/api/3/project/OPS?expand=lead,issueTypes'] = [
      200,
      {
        id: '10000',
        key: 'OPS',
        name: 'Operations',
        projectTypeKey: 'software',
        simplified: false,
        lead: { displayName: 'Dana Admin' },
        issueTypes: [
          { id: '10001', name: 'Story' },
          { id: '10004', name: 'Bug' },
        ],
      },
    ];
    site['/rest/api/3/issuetypescheme/project?projectId=10000'] = [
      200,
      { values: [{ issueTypeScheme: { id: '10100', name: 'OPS: Scrum' }, projectIds: ['10000'] }] },
    ];
    site['/rest/api/3/workflowscheme/project?projectId=10000'] = [
      200,
      {
        values: [
          {
            workflowScheme: {
              id: '10200',
              name: 'Software Simplified',
              defaultWorkflow: 'jira',
              issueTypeMappings: { '10004': 'Bug workflow' },
            },
            projectIds: ['10000'],
          },
        ],
      },
    ];
    site['/rest/api/3/workflowscheme/10200/projectUsages?maxResults=50'] = [
      200,
      { projects: { values: [{ id: '10000' }, { id: '10001' }, { id: '10002' }] } },
    ];
    site['/rest/api/3/issuetypescreenscheme/project?projectId=10000'] = [
      200,
      { values: [{ issueTypeScreenScheme: { id: '10300', name: 'OPS screens' } }] },
    ];
    site['/rest/api/3/issuetypescreenscheme/10300/project?maxResults=50'] = [
      200,
      { total: 1, values: [{ id: '10000' }] },
    ];
    site['/rest/api/3/fieldconfigurationscheme/project?projectId=10000'] = [
      200,
      { values: [{ projectIds: ['10000'] }] },
    ];
    site['/rest/api/3/project/OPS/permissionscheme'] = [200, { id: '0', name: 'Default' }];
    site['/rest/api/3/project/OPS/notificationscheme'] = [200, { id: '1', name: 'Quiet' }];
    site['/rest/api/3/project/OPS/role'] = [
      200,
      { Administrators: 'https://acme.atlassian.net/rest/api/3/project/10000/role/10002' },
    ];
    site['/rest/api/3/project/OPS/role/10002'] = [
      200,
      {
        actors: [
          { displayName: 'Dana Admin', actorUser: { accountId: 'acct-1' } },
          {
            displayName: 'jira-admins',
            actorGroup: { name: 'jira-admins', displayName: 'jira-admins' },
          },
        ],
      },
    ];

    const result = text(await call('jira_admin_get_space_configuration', { space: 'OPS' }));

    expect(result).toContain(
      'OPS — Operations (id 10000) · software · company-managed · lead: Dana Admin'
    );
    expect(result).toContain('Work types (2): Story, Bug');
    expect(result).toContain(
      '• Workflows: "Software Simplified" (id 10200) — shared by 3 spaces (a change here changes all of them)'
    );
    expect(result).toContain('Bug → Bug workflow');
    expect(result).toContain('• Screens: "OPS screens" (id 10300) — used by this space only');
    expect(result).toContain('• Field configuration: the system default field configuration');
    expect(result).toContain('• Administrators: Dana Admin, group jira-admins');
  });

  it('does not describe site schemes for a team-managed space', async () => {
    site['/rest/api/3/project/TEAM?expand=lead,issueTypes'] = [
      200,
      { id: '10500', key: 'TEAM', name: 'Team', simplified: true, issueTypes: [] },
    ];
    site['/rest/api/3/project/TEAM/role'] = [200, {}];

    const result = text(await call('jira_admin_get_space_configuration', { space: 'TEAM' }));

    expect(result).toContain('team-managed');
    expect(result).toContain('site schemes do not apply to it');
    expect(requested.some((path) => path.includes('scheme'))).toBe(false);
  });
});

describe('jira_admin_get_plan', () => {
  it('names the plan’s spaces, lead, scheduling and teams', async () => {
    site['/rest/api/3/plans/plan/12'] = [
      200,
      {
        id: 12,
        name: 'FY27 Roadmap',
        status: 'Active',
        leadAccountId: 'acct-9',
        issueSources: [
          { type: 'Project', value: 10000 },
          { type: 'Board', value: 42 },
        ],
        scheduling: {
          estimation: 'StoryPoints',
          dependencies: 'Sequential',
          inferredDates: 'SprintDates',
          startDate: { type: 'TargetStartDate' },
          endDate: { type: 'DateCustomField', dateCustomFieldId: 10050 },
        },
        exclusionRules: { numberOfDaysToShowCompletedIssues: 30 },
      },
    ];
    site['/rest/api/3/plans/plan/12/team?maxResults=50'] = [
      200,
      { values: [{ id: '7', name: 'Platform', type: 'PlanOnly' }] },
    ];
    site['/rest/api/3/project/search?maxResults=50&id=10000'] = [
      200,
      { values: [{ id: '10000', key: 'OPS' }] },
    ];
    site['/rest/api/3/user?accountId=acct-9'] = [200, { displayName: 'Sam Lead' }];

    const result = text(await call('jira_admin_get_plan', { planId: '12' }));

    expect(result).toContain('FY27 Roadmap — id 12 — Active');
    expect(result).toContain('Lead: Sam Lead');
    expect(result).toContain('Work from: space OPS, board 42');
    expect(result).toContain('estimates in StoryPoints, dependencies sequential');
    expect(result).toContain('end date = custom field 10050');
    expect(result).toContain('Excluded: completed more than 30 days ago');
    expect(result).toContain('Teams (1): Platform (plan-only, id 7)');
  });

  it('refuses a plan id that is not a number before calling Jira', async () => {
    const result = await call('jira_admin_get_plan', { planId: '../field' });

    expect(result.isError).toBe(true);
    expect(requested).toEqual([]);
  });
});
