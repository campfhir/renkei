/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * jira_admin_propose_work_type and jira_admin_list_work_type_icons against
 * a fake Jira site and a stand-in change-request store. What must hold: it
 * only ever reads Jira; it reuses a site-wide work type of the name rather
 * than making a second; it will not add a work type to a scheme other
 * spaces share without being told to, naming those spaces; `like` copies
 * another work type's screens and workflow, and the scheme's default is
 * left unmapped; an icon is named, not guessed.
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
import { FAKE_BASE } from '@/lib/jira-admin/fake-site.fixture';
import { createChangeRequest, type ChangeRequest } from '@/lib/jira-admin/change-requests';
import type { WorkTypePayload } from '@/lib/jira-admin/work-type';

type ToolResult = {
  content: { type: string; text?: string }[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const CHANGE_ID = '8b3f5e3a-1e4c-4b7a-9c77-4d9c2e1a6f33';

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

const propose = (args: Record<string, unknown>) => call('jira_admin_propose_work_type', args);
const text = (result: ToolResult) => result.content[0]?.text ?? '';
const stored = () =>
  jest.mocked(createChangeRequest).mock.calls[0]?.[1]?.payload as WorkTypePayload | undefined;

/** OPS (Task, Bug) on schemes HR shares, with Bug on its own screens and workflow. */
function opsSite(): Record<string, [number, unknown]> {
  return {
    '/rest/api/3/project/OPS': [
      200,
      {
        id: '10000',
        key: 'OPS',
        name: 'Operations',
        projectTypeKey: 'software',
        style: 'classic',
        issueTypes: [
          { id: '10001', name: 'Task' },
          { id: '10002', name: 'Bug' },
        ],
      },
    ],
    '/rest/api/3/project/HELP': [
      200,
      {
        id: '10100',
        key: 'HELP',
        name: 'Help desk',
        projectTypeKey: 'service_desk',
        style: 'classic',
        issueTypes: [{ id: '10010', name: 'Service request' }],
      },
    ],
    '/rest/api/3/project/TEAM': [
      200,
      { id: '10200', key: 'TEAM', style: 'next-gen', simplified: true, issueTypes: [] },
    ],
    '/rest/api/3/issuetype': [
      200,
      [
        { id: '10001', name: 'Task', subtask: false, avatarId: 10318 },
        { id: '10002', name: 'Bug', subtask: false, avatarId: 10303 },
        { id: '10003', name: 'Sub-task', subtask: true, avatarId: 10316 },
        { id: '20001', name: 'Incident', scope: { type: 'PROJECT', project: { id: '10200' } } },
      ],
    ],
    '/rest/api/3/avatar/issuetype/system': [
      200,
      {
        system: [
          { id: '10303', fileName: '10303_bug.png', urls: { '48x48': 'https://x/bug.png' } },
          { id: '10315', fileName: '10315_story.png', urls: { '48x48': 'https://x/story.png' } },
          { id: '10316', fileName: '10316_subtask.png', urls: {} },
          { id: '10318', fileName: '10318_task.png', urls: {} },
        ],
      },
    ],
    '/rest/api/3/issuetypescheme/project?projectId=10000': [
      200,
      {
        values: [{ issueTypeScheme: { id: '11', name: 'OPS work types' }, projectIds: ['10000'] }],
      },
    ],
    '/rest/api/3/issuetypescheme/project?projectId=10100': [
      200,
      {
        values: [{ issueTypeScheme: { id: '21', name: 'HELP work types' }, projectIds: ['10100'] }],
      },
    ],
    '/rest/api/3/project/search?startAt=0&maxResults=100': [
      200,
      {
        isLast: true,
        values: [
          { id: '10000', key: 'OPS' },
          { id: '10100', key: 'HELP' },
          { id: '10300', key: 'HR' },
        ],
      },
    ],
    '/rest/api/3/issuetypescheme/project?projectId=10100&projectId=10300&startAt=0&maxResults=100':
      [
        200,
        {
          isLast: true,
          values: [
            { issueTypeScheme: { id: '21', name: 'HELP work types' }, projectIds: ['10100'] },
            { issueTypeScheme: { id: '11', name: 'OPS work types' }, projectIds: ['10300'] },
          ],
        },
      ],
    '/rest/api/3/issuetypescheme/project?projectId=10000&projectId=10300&startAt=0&maxResults=100':
      [
        200,
        {
          isLast: true,
          values: [
            {
              issueTypeScheme: { id: '11', name: 'OPS work types' },
              projectIds: ['10000', '10300'],
            },
          ],
        },
      ],
    '/rest/api/3/issuetypescreenscheme/project?projectId=10000': [
      200,
      { values: [{ issueTypeScreenScheme: { id: '12', name: 'OPS screens' } }] },
    ],
    '/rest/api/3/issuetypescreenscheme/mapping?issueTypeScreenSchemeId=12&startAt=0&maxResults=100':
      [
        200,
        {
          isLast: true,
          values: [
            { issueTypeId: '10002', screenSchemeId: '31' },
            { issueTypeId: 'default', screenSchemeId: '30' },
          ],
        },
      ],
    '/rest/api/3/screenscheme?id=31': [200, { values: [{ id: 31, name: 'Bug screen scheme' }] }],
    '/rest/api/3/workflowscheme/project?projectId=10000': [
      200,
      { values: [{ workflowScheme: { id: '13', name: 'OPS workflows' } }] },
    ],
    '/rest/api/3/workflowscheme/read': [
      200,
      [
        {
          id: '13',
          name: 'OPS workflows',
          version: { id: 'v-1', versionNumber: 3 },
          defaultWorkflow: { id: 'wf-simple', name: 'Simple workflow' },
          workflowsForIssueTypes: [
            { workflow: { id: 'wf-bug', name: 'Bug workflow' }, issueTypeIds: ['10002'] },
          ],
        },
      ],
    ],
    '/rest/api/3/workflows/search?queryString=Incident%20workflow&maxResults=50': [
      200,
      { values: [{ id: 'wf-incident', name: 'Incident workflow' }] },
    ],
  };
}

beforeEach(() => {
  site = opsSite();
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

describe('jira_admin_list_work_type_icons', () => {
  it('names each icon by its file, with its id and image', async () => {
    const result = text(await call('jira_admin_list_work_type_icons'));
    expect(result).toContain('4 work type icons');
    expect(result).toContain('bug — 10303 — https://x/bug.png');
    expect(result).toContain('subtask — 10316');
  });
});

describe('jira_admin_propose_work_type', () => {
  it('refuses a scheme other spaces share until told to, naming them', async () => {
    const result = await propose({ space: 'OPS', name: 'Incident' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(
      'OPS’s work type scheme “OPS work types” is shared with HR, and the work type would ' +
        'appear there as well. Pass sharedScheme: true to go ahead'
    );
    expect(createChangeRequest).not.toHaveBeenCalled();
  });

  it('proposes a new type with its icon, scheme, and Bug’s screens and workflow — writing nothing', async () => {
    const result = await propose({
      space: 'OPS',
      name: 'Incident',
      description: 'Something is down',
      icon: 'bug',
      like: 'Bug',
      sharedScheme: true,
      reason: 'On-call asked',
    });
    expect(result.isError).toBeUndefined();
    expect(requests.every((request) => request.method === 'GET')).toBe(false);
    expect(
      requests.filter((request) => request.method !== 'GET').map((request) => request.path)
    ).toEqual(['/rest/api/3/workflowscheme/read']);
    const payload = stored();
    expect(payload?.workType).toEqual({ id: null, name: 'Incident', subtask: false });
    expect(payload?.operations).toEqual([
      {
        op: 'create_work_type',
        name: 'Incident',
        description: 'Something is down',
        subtask: false,
      },
      { op: 'set_icon', avatarId: '10303', iconName: 'bug' },
      {
        op: 'add_to_scheme',
        schemeId: '11',
        schemeName: 'OPS work types',
        sharedWith: ['HR'],
        moreShared: false,
      },
      {
        op: 'map_screens',
        schemeId: '12',
        schemeName: 'OPS screens',
        screenSchemeId: '31',
        screenSchemeName: 'Bug screen scheme',
        likeName: 'Bug',
      },
      {
        op: 'map_workflow',
        schemeId: '13',
        schemeName: 'OPS workflows',
        workflowId: 'wf-bug',
        workflowName: 'Bug workflow',
        likeName: 'Bug',
      },
    ]);
    expect(jest.mocked(createChangeRequest).mock.calls[0]?.[1]).toMatchObject({
      kind: 'work_type',
      title: 'New work type “Incident” for OPS',
      reason: 'On-call asked',
    });
    const body = text(result);
    expect(body).toContain('Proposed — nothing has changed in Jira yet.');
    expect(body).toContain('Also used by HR — the work type appears there too');
    expect(body).toContain(`https://renkei.example/jira-admin/changes/${CHANGE_ID}`);
    expect(result._meta).toEqual({
      'renkei/act': { url: `https://renkei.example/jira-admin/changes/${CHANGE_ID}` },
    });
  });

  it('reuses a site-wide type of the name and says so; a type the space has already is nothing to do', async () => {
    site['/rest/api/3/issuetype'] = [
      200,
      [
        { id: '10001', name: 'Task', subtask: false },
        { id: '10002', name: 'Bug', subtask: false },
        { id: '10050', name: 'incident', subtask: false },
      ],
    ];
    const result = await propose({ space: 'OPS', name: 'Incident', sharedScheme: true });
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain(
      'A work type named “incident” exists already (10050), so it is used rather than a ' +
        'second one created.'
    );
    expect(stored()?.workType).toEqual({ id: '10050', name: 'incident', subtask: false });
    expect(stored()?.operations.map((operation) => operation.op)).toEqual(['add_to_scheme']);

    jest.mocked(createChangeRequest).mockClear();
    const nothing = await propose({ space: 'OPS', name: 'Bug' });
    expect(nothing.isError).toBe(true);
    expect(text(nothing)).toContain('Nothing to do: OPS has the work type “Bug” already.');
  });

  it('leaves the scheme’s default workflow unmapped, and takes a workflow by name', async () => {
    const byLike = await propose({ space: 'OPS', name: 'Chore', like: 'Task', sharedScheme: true });
    expect(text(byLike)).toContain('“Task” uses OPS’s default screens, so “Chore” will too.');
    expect(text(byLike)).toContain(
      '“Simple workflow” is OPS’s default workflow, which “Chore” runs on without a mapping.'
    );
    expect(stored()?.operations.map((operation) => operation.op)).toEqual([
      'create_work_type',
      'add_to_scheme',
    ]);

    jest.mocked(createChangeRequest).mockClear();
    const byName = await propose({
      space: 'OPS',
      name: 'Chore',
      workflow: 'Incident workflow',
      sharedScheme: true,
    });
    expect(byName.isError).toBeUndefined();
    expect(stored()?.operations.at(-1)).toEqual({
      op: 'map_workflow',
      schemeId: '13',
      schemeName: 'OPS workflows',
      workflowId: 'wf-incident',
      workflowName: 'Incident workflow',
      likeName: null,
    });
  });

  it('refuses an icon it cannot name, a team-managed space, and a work type the space lacks', async () => {
    const icon = await propose({ space: 'OPS', name: 'Chore', icon: 'rocket', sharedScheme: true });
    expect(icon.isError).toBe(true);
    expect(text(icon)).toContain(
      'No work type icon is called “rocket”. The icons: bug, story, subtask, task'
    );

    const team = await propose({ space: 'TEAM', name: 'Chore' });
    expect(text(team)).toContain('TEAM is team-managed');

    const like = await propose({ space: 'OPS', name: 'Chore', like: 'Epic', sharedScheme: true });
    expect(text(like)).toContain(
      'OPS has no work type “Epic” to set this one up like. Its work types: Task, Bug.'
    );
    expect(createChangeRequest).not.toHaveBeenCalled();
  });

  it('points a service project at request types once applied', async () => {
    const result = await propose({ space: 'HELP', name: 'Incident' });
    expect(result.isError).toBeUndefined();
    expect(stored()?.space).toEqual({ id: '10100', key: 'HELP', serviceDesk: true });
    expect(text(result)).toContain(
      'HELP is a service project: customers see a work type on the portal only through a ' +
        'request type. Once this is applied, propose one with jira_admin_propose_request_type.'
    );
  });
});
