/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Reading a space's configuration against a fake Jira site: all seven
 * schemes and every role, or a refusal — never a partial picture, since a
 * template missing its permission scheme would quietly build spaces on the
 * default one.
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
import { missingSchemes, readSpaceConfiguration, type SpaceSchemes } from './space-config';
import { FAKE_BASE as BASE, opsSite } from './fake-site.fixture';

const access: JiraAdminAccess = {
  cloudId: 'cloud-1',
  siteUrl: 'https://acme.atlassian.net',
  accountId: 'acct-1',
  authHeader: 'Bearer t',
};
const scope = { tenantId: 'tenant-1', subject: 'subject-1' };

let site: Record<string, [number, unknown]>;

beforeEach(() => {
  site = opsSite();
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const path = String(input).slice(BASE.length);
    const [status, body] = site[path] ?? [404, { errorMessages: ['No such thing.'] }];
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
});

describe('readSpaceConfiguration', () => {
  it('reads the facts, all seven schemes and every role’s groups and people', async () => {
    const read = await readSpaceConfiguration(scope, access, 'OPS');
    if (!read.ok) throw new Error(read.reason);
    expect(read.space).toEqual({
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
        // No scheme row: the system default field configuration.
        fieldConfigurationScheme: null,
        permissionScheme: { id: '15', name: 'Internal permissions' },
        notificationScheme: { id: '16', name: 'Quiet notifications' },
        // 404: no issue security — an answer, not a failure.
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
      // By name, whatever order Jira lists them in.
      components: [
        {
          id: '20000',
          name: 'Backend',
          description: 'Services and jobs',
          assigneeType: 'COMPONENT_LEAD',
          lead: { accountId: 'acct-dana', displayName: 'Dana Admin' },
        },
        {
          id: '20001',
          name: 'Reports',
          description: null,
          assigneeType: 'PROJECT_LEAD',
          lead: null,
        },
      ],
    });
  });

  it('refuses a partial picture when the components cannot be read', async () => {
    site['/rest/api/3/project/OPS/components'] = [500, {}];
    const read = await readSpaceConfiguration(scope, access, 'OPS');
    expect(read).toEqual({ ok: false, reason: 'Components: Jira answered 500.' });
  });

  it('refuses a team-managed space, which has no site schemes to copy', async () => {
    site['/rest/api/3/project/OPS?expand=lead'] = [
      200,
      { id: '10000', key: 'OPS', name: 'Operations', simplified: true, style: 'next-gen' },
    ];
    const read = await readSpaceConfiguration(scope, access, 'OPS');
    expect(read).toEqual({ ok: false, reason: expect.stringMatching(/OPS is team-managed/) });
  });

  it('refuses a partial picture when a scheme cannot be read', async () => {
    site['/rest/api/3/project/OPS/permissionscheme'] = [403, { errorMessages: ['Nope.'] }];
    const read = await readSpaceConfiguration(scope, access, 'OPS');
    expect(read).toEqual({
      ok: false,
      reason: expect.stringMatching(/^The permissions scheme: Jira refused \(403\)/),
    });
  });

  it('refuses when an issue security lookup fails for any reason but "none"', async () => {
    site['/rest/api/3/project/OPS/issuesecuritylevelscheme'] = [500, {}];
    const read = await readSpaceConfiguration(scope, access, 'OPS');
    expect(read).toEqual({ ok: false, reason: 'The issue security scheme: Jira answered 500.' });
  });
});

describe('missingSchemes', () => {
  const schemes: SpaceSchemes = {
    issueTypeScheme: { id: '11', name: 'OPS work types' },
    issueTypeScreenScheme: { id: '12', name: 'OPS screens' },
    workflowScheme: { id: '13', name: 'OPS workflows' },
    fieldConfigurationScheme: null,
    permissionScheme: { id: '15', name: 'Internal permissions' },
    notificationScheme: { id: '16', name: 'Quiet notifications' },
    issueSecurityScheme: null,
  };

  it('names each scheme a template points at that no longer exists', async () => {
    site['/rest/api/3/issuetypescheme?id=11'] = [200, { values: [{ id: '11' }] }];
    site['/rest/api/3/issuetypescreenscheme?id=12'] = [200, { values: [] }];
    site['/rest/api/3/workflowscheme/13'] = [200, { id: 13 }];
    site['/rest/api/3/permissionscheme/15'] = [200, { id: 15 }];
    // Notification scheme 16: unlisted, so the fake site answers 404.
    expect(await missingSchemes(scope, access, schemes)).toEqual([
      'the screens scheme “OPS screens” (id 12) no longer exists',
      'the notifications scheme “Quiet notifications” (id 16): Not found (404), or not visible to the connected account. No such thing.',
    ]);
  });
});
