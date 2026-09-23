/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Creating a space: what a proposal plans, how it reads on the review
 * page, and what applying sends to a fake Jira — above all that the key is
 * checked again at apply time, that role members Jira already put in are
 * not sent twice, and that a failure stops everything after it.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
jest.mock('@renkei/db', () => ({ getDatabase: () => ({ ok: false }) }));
jest.mock('@renkei/crypto', () => ({ parseEncryptionKey: () => ({ ok: false }) }));
jest.mock('@renkei/provider-grants', () => ({}));
jest.mock('@/lib/atlassian-app', () => ({ getAtlassianAdminApp: jest.fn() }));

import type { JiraAdminAccess } from '@/lib/mcp-tools/jira-admin/client';
import { FAKE_BASE } from './fake-site.fixture';
import {
  applySpaceCreation,
  describeSpaceOperation,
  describeSpaceReach,
  planSpaceCreation,
  readCreateSpacePayload,
  spaceTitle,
  type CreateSpacePayload,
  type SpaceBase,
} from './space-creation';

const access: JiraAdminAccess = {
  cloudId: 'cloud-1',
  siteUrl: 'https://acme.atlassian.net',
  accountId: 'acct-1',
  authHeader: 'Bearer t',
};
const scope = { tenantId: 'tenant-1', subject: 'subject-1' };

const BASE_SPACE: SpaceBase = {
  projectTypeKey: 'software',
  assigneeType: 'UNASSIGNED',
  category: { id: '10100', name: 'Internal' },
  schemes: {
    issueTypeScheme: { id: '11', name: 'OPS work types' },
    issueTypeScreenScheme: { id: '12', name: 'OPS screens' },
    workflowScheme: { id: '13', name: 'OPS workflows' },
    fieldConfigurationScheme: null,
    permissionScheme: { id: '15', name: 'Internal permissions' },
    notificationScheme: { id: '16', name: 'Quiet notifications' },
    issueSecurityScheme: { id: '17', name: 'Confidential' },
  },
  roles: [
    {
      roleId: '10002',
      roleName: 'Administrators',
      groups: [{ groupId: 'g-admins', name: 'ops-admins' }],
    },
    { roleId: '10001', roleName: 'Developers', groups: [] },
  ],
};

const DANA = { accountId: 'acct-dana', displayName: 'Dana Admin' };
const SAM = { accountId: 'acct-sam', displayName: 'Sam Dev' };

function payloadOf(operations = plan()): CreateSpacePayload {
  return {
    source: { kind: 'template', id: 'tpl-1', name: 'Ops standard' },
    workflowUsage: { count: 3, more: false },
    operations,
  };
}

function plan() {
  return planSpaceCreation({
    key: 'FIN',
    name: 'Finance',
    description: 'Month-end close',
    lead: DANA,
    base: BASE_SPACE,
    members: [
      // A group the template already has is not added twice.
      {
        roleId: '10002',
        roleName: 'Administrators',
        groups: [{ groupId: 'g-admins', name: 'ops-admins' }],
        users: [DANA],
      },
      { roleId: '10001', roleName: 'Developers', groups: [], users: [SAM] },
    ],
  });
}

describe('planning', () => {
  it('creates the space on the base’s schemes, then fills roles, skipping empty ones', () => {
    const operations = plan();
    expect(operations[0]).toEqual({
      op: 'create_space',
      key: 'FIN',
      name: 'Finance',
      description: 'Month-end close',
      lead: DANA,
      projectTypeKey: 'software',
      assigneeType: 'UNASSIGNED',
      category: { id: '10100', name: 'Internal' },
      schemes: BASE_SPACE.schemes,
    });
    expect(operations.slice(1)).toEqual([
      {
        op: 'add_role_members',
        roleId: '10002',
        roleName: 'Administrators',
        groups: [{ groupId: 'g-admins', name: 'ops-admins' }],
        users: [DANA],
      },
      { op: 'add_role_members', roleId: '10001', roleName: 'Developers', groups: [], users: [SAM] },
    ]);
  });

  it('leaves out a role nobody is named for', () => {
    const operations = planSpaceCreation({
      key: 'FIN',
      name: 'Finance',
      description: null,
      lead: DANA,
      base: BASE_SPACE,
      members: [],
    });
    expect(operations.map((operation) => operation.op)).toEqual([
      'create_space',
      'add_role_members',
    ]);
  });
});

describe('describing', () => {
  it('says what the space runs on, and labels every operation as an access change', () => {
    const payload = payloadOf();
    const described = payload.operations.map((operation) =>
      describeSpaceOperation(operation, payload)
    );
    expect(described[0]).toEqual({
      text:
        'Create the software space FIN — “Finance” — led by Dana Admin, on the schemes of ' +
        'template “Ops standard”',
      access: true,
      details: [
        'Work types: “OPS work types”',
        'Screens: “OPS screens”',
        'Workflows: “OPS workflows” — shared with 3 spaces',
        'Field configuration: the system default',
        'Permissions: “Internal permissions”',
        'Notifications: “Quiet notifications”',
        'Issue security: “Confidential”',
        'Default assignee: unassigned',
        'Category: Internal',
        'Description: Month-end close',
      ],
    });
    expect(described.slice(1).map((operation) => [operation.text, operation.access])).toEqual([
      ['Add group “ops-admins”, Dana Admin to the Administrators role', true],
      ['Add Sam Dev to the Developers role', true],
    ]);
    expect(describeSpaceReach(payload, 'https://acme.atlassian.net')).toBe(
      'A new space FIN on https://acme.atlassian.net, running on the same schemes as template ' +
        '“Ops standard” rather than copies of them — a later change to one of those schemes ' +
        'changes every space on it.'
    );
    expect(spaceTitle(payload)).toBe('New space FIN “Finance”, from template “Ops standard”');
    expect(spaceTitle({ ...payload, source: { kind: 'space', key: 'OPS' } })).toBe(
      'New space FIN “Finance”, like OPS'
    );
  });

  it('reads back only a payload it wrote in full', () => {
    const payload = payloadOf();
    expect(readCreateSpacePayload(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
    // The first operation must create the space.
    expect(
      readCreateSpacePayload({ ...payload, operations: payload.operations.slice(1) })
    ).toBeNull();
    // A key Jira would refuse is not one this code wrote.
    expect(
      readCreateSpacePayload({
        ...payload,
        operations: [{ ...payload.operations[0], key: 'fin' }, ...payload.operations.slice(1)],
      })
    ).toBeNull();
    expect(readCreateSpacePayload({ ...payload, source: { kind: 'somewhere' } })).toBeNull();
  });
});

describe('applying against Jira', () => {
  let calls: { method: string; path: string; body: unknown }[];
  let site: Record<string, [number, unknown]>;

  beforeEach(() => {
    calls = [];
    site = {
      'GET /rest/api/3/projectvalidate/key?key=FIN': [200, { errorMessages: [], errors: {} }],
      'POST /rest/api/3/project': [201, { id: 10200, key: 'FIN' }],
      // Jira put the default admin group in at creation.
      'GET /rest/api/3/project/FIN/role/10002': [
        200,
        {
          actors: [
            {
              type: 'atlassian-group-role-actor',
              actorGroup: { name: 'ops-admins', groupId: 'g-admins' },
            },
          ],
        },
      ],
      'POST /rest/api/3/project/FIN/role/10002': [200, {}],
      'GET /rest/api/3/project/FIN/role/10001': [200, { actors: [] }],
      'POST /rest/api/3/project/FIN/role/10001': [200, {}],
    };
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const path = String(input).slice(FAKE_BASE.length);
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const [status, body] = site[`${method} ${path}`] ?? [
        404,
        { errorMessages: ['No such thing.'] },
      ];
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
  });

  it('checks the key, creates the space on the stored scheme ids, and adds only missing members', async () => {
    const outcome = await applySpaceCreation(scope, access, payloadOf());

    expect(outcome.status).toBe('applied');
    expect(outcome.results.map((result) => [result.outcome, result.detail])).toEqual([
      ['done', 'https://acme.atlassian.net/browse/FIN'],
      ['done', '1 already in the role.'],
      ['done', undefined],
    ]);
    const create = calls.find(
      (call) => call.method === 'POST' && call.path === '/rest/api/3/project'
    );
    expect(create?.body).toEqual({
      key: 'FIN',
      name: 'Finance',
      description: 'Month-end close',
      leadAccountId: 'acct-dana',
      projectTypeKey: 'software',
      assigneeType: 'UNASSIGNED',
      categoryId: 10100,
      issueTypeScheme: 11,
      issueTypeScreenScheme: 12,
      workflowScheme: 13,
      permissionScheme: 15,
      notificationScheme: 16,
      issueSecurityScheme: 17,
    });
    // ops-admins was there already; only Dana goes in.
    expect(
      calls.find((call) => call.method === 'POST' && call.path.endsWith('/role/10002'))?.body
    ).toEqual({ user: ['acct-dana'] });
    expect(
      calls.find((call) => call.method === 'POST' && call.path.endsWith('/role/10001'))?.body
    ).toEqual({ user: ['acct-sam'] });
  });

  it('stops before creating anything when the key was taken since', async () => {
    site['GET /rest/api/3/projectvalidate/key?key=FIN'] = [
      200,
      {
        errorMessages: [],
        errors: { projectKey: 'A project with that project key already exists.' },
      },
    ];
    const outcome = await applySpaceCreation(scope, access, payloadOf());
    expect(outcome.status).toBe('failed');
    expect(outcome.results[0]).toMatchObject({
      outcome: 'failed',
      detail: 'FIN cannot be used now: A project with that project key already exists.',
    });
    expect(outcome.results.slice(1).every((result) => result.outcome === 'not_run')).toBe(true);
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('keeps a created space and says which role failed', async () => {
    site['POST /rest/api/3/project/FIN/role/10002'] = [400, { errorMessages: ['Bad actor.'] }];
    const outcome = await applySpaceCreation(scope, access, payloadOf());
    expect(outcome.status).toBe('partial');
    expect(outcome.results.map((result) => result.outcome)).toEqual(['done', 'failed', 'not_run']);
    expect(outcome.results[1]?.detail).toBe('Jira answered 400. Bad actor.');
  });

  it('adds groups saved without an id by name, in a call of their own', async () => {
    const operations = planSpaceCreation({
      key: 'FIN',
      name: 'Finance',
      description: null,
      lead: DANA,
      base: {
        ...BASE_SPACE,
        roles: [
          {
            roleId: '10001',
            roleName: 'Developers',
            groups: [
              { groupId: 'g-users', name: 'jira-software-users' },
              { groupId: '', name: 'legacy-devs' },
            ],
          },
        ],
      },
      members: [],
    });
    const outcome = await applySpaceCreation(scope, access, payloadOf(operations));
    expect(outcome.status).toBe('applied');
    expect(
      calls
        .filter((call) => call.method === 'POST' && call.path.endsWith('/role/10001'))
        .map((call) => call.body)
    ).toEqual([{ groupId: ['g-users'] }, { group: ['legacy-devs'] }]);
  });
});
