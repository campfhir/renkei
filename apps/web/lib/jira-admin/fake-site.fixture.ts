/**
 * A fake Jira site for the jira-admin tests: OPS, a company-managed
 * software space with every scheme, two roles and two components — path and
 * query mapped to [status, body], the way the jira_admin_ tool tests stand
 * Jira in. Not a test file (Jest collects *.test.ts), so importing it
 * registers no tests of its own.
 */

export const FAKE_BASE = 'https://api.atlassian.com/ex/jira/cloud-1';

/** A company-managed software space, OPS, with every scheme, two roles and two components. */
export function opsSite(): Record<string, [number, unknown]> {
  return {
    '/rest/api/3/project/OPS?expand=lead': [
      200,
      {
        id: '10000',
        key: 'OPS',
        name: 'Operations',
        projectTypeKey: 'software',
        style: 'classic',
        assigneeType: 'UNASSIGNED',
        projectCategory: { id: '10100', name: 'Internal' },
        lead: { accountId: 'acct-lead', displayName: 'Lee Lead' },
      },
    ],
    '/rest/api/3/issuetypescheme/project?projectId=10000': [
      200,
      {
        values: [{ issueTypeScheme: { id: '11', name: 'OPS work types' }, projectIds: ['10000'] }],
      },
    ],
    '/rest/api/3/issuetypescreenscheme/project?projectId=10000': [
      200,
      {
        values: [
          { issueTypeScreenScheme: { id: '12', name: 'OPS screens' }, projectIds: ['10000'] },
        ],
      },
    ],
    '/rest/api/3/workflowscheme/project?projectId=10000': [
      200,
      { values: [{ workflowScheme: { id: '13', name: 'OPS workflows' }, projectIds: ['10000'] }] },
    ],
    '/rest/api/3/fieldconfigurationscheme/project?projectId=10000': [200, { values: [] }],
    '/rest/api/3/project/OPS/permissionscheme': [200, { id: '15', name: 'Internal permissions' }],
    '/rest/api/3/project/OPS/notificationscheme': [200, { id: '16', name: 'Quiet notifications' }],
    '/rest/api/3/project/OPS/issuesecuritylevelscheme': [
      404,
      { errorMessages: ['No issue security scheme.'] },
    ],
    '/rest/api/3/project/OPS/role': [
      200,
      {
        Administrators: `${FAKE_BASE}/rest/api/3/project/10000/role/10002`,
        Developers: `${FAKE_BASE}/rest/api/3/project/10000/role/10001`,
      },
    ],
    '/rest/api/3/project/OPS/role/10002': [
      200,
      {
        actors: [
          {
            type: 'atlassian-group-role-actor',
            actorGroup: { name: 'ops-admins', displayName: 'ops-admins', groupId: 'g-admins' },
          },
          {
            type: 'atlassian-user-role-actor',
            displayName: 'Dana Admin',
            actorUser: { accountId: 'acct-dana' },
          },
        ],
      },
    ],
    '/rest/api/3/project/OPS/role/10001': [
      200,
      {
        actors: [
          {
            type: 'atlassian-group-role-actor',
            actorGroup: { name: 'jira-software-users', groupId: 'g-users' },
          },
        ],
      },
    ],
    '/rest/api/3/project/OPS/components': [
      200,
      [
        {
          id: '20001',
          name: 'Reports',
          assigneeType: 'PROJECT_LEAD',
        },
        {
          id: '20000',
          name: 'Backend',
          description: 'Services and jobs',
          assigneeType: 'COMPONENT_LEAD',
          lead: { accountId: 'acct-dana', displayName: 'Dana Admin' },
        },
      ],
    ],
  };
}

/**
 * OPS's screens, for putting a field on them. Task falls to the default
 * screen scheme (30: "OPS: Create" to create, "OPS: Edit/View" to edit and
 * view); Bug has its own (31), whose one screen HR shows too. GET paths as
 * the client sends them, paging included.
 */
export function opsScreensSite(): Record<string, [number, unknown]> {
  return {
    '/rest/api/3/project/OPS': [
      200,
      {
        id: '10000',
        key: 'OPS',
        name: 'Operations',
        style: 'classic',
        issueTypes: [
          { id: '10001', name: 'Task' },
          { id: '10002', name: 'Bug' },
        ],
      },
    ],
    '/rest/api/3/issuetypescreenscheme/project?projectId=10000': [
      200,
      {
        values: [
          { issueTypeScreenScheme: { id: '12', name: 'OPS screens' }, projectIds: ['10000'] },
        ],
      },
    ],
    '/rest/api/3/issuetypescreenscheme/mapping?issueTypeScreenSchemeId=12&startAt=0&maxResults=100':
      [
        200,
        {
          isLast: true,
          values: [
            { issueTypeId: '10002', issueTypeScreenSchemeId: '12', screenSchemeId: '31' },
            { issueTypeId: 'default', issueTypeScreenSchemeId: '12', screenSchemeId: '30' },
          ],
        },
      ],
    '/rest/api/3/screenscheme?maxResults=100&id=30&id=31': [
      200,
      {
        isLast: true,
        values: [
          { id: 30, name: 'OPS screen scheme', screens: { default: 40, create: 41 } },
          { id: 31, name: 'Bug screen scheme', screens: { default: 42 } },
        ],
      },
    ],
    '/rest/api/3/screenscheme?maxResults=100&id=30': [
      200,
      {
        isLast: true,
        values: [{ id: 30, name: 'OPS screen scheme', screens: { default: 40, create: 41 } }],
      },
    ],
    '/rest/api/3/screens?maxResults=100&id=41&id=40&id=42': [
      200,
      {
        values: [
          { id: 40, name: 'OPS: Edit/View' },
          { id: 41, name: 'OPS: Create' },
          { id: 42, name: 'Shared bug screen' },
        ],
      },
    ],
    '/rest/api/3/screens?maxResults=100&id=41&id=40': [
      200,
      {
        values: [
          { id: 40, name: 'OPS: Edit/View' },
          { id: 41, name: 'OPS: Create' },
        ],
      },
    ],
    '/rest/api/3/screens/40/tabs': [
      200,
      [
        { id: 400, name: 'Field Tab' },
        { id: 401, name: 'Details' },
      ],
    ],
    '/rest/api/3/screens/41/tabs': [200, [{ id: 410, name: 'Field Tab' }]],
    '/rest/api/3/screens/42/tabs': [200, [{ id: 420, name: 'Details' }]],
    // Who else shows each screen: scheme 31 is used by HR's screens scheme too.
    '/rest/api/3/screenscheme?expand=issueTypeScreenSchemes&startAt=0&maxResults=100': [
      200,
      {
        isLast: true,
        values: [
          {
            id: 30,
            screens: { default: 40, create: 41 },
            issueTypeScreenSchemes: { values: [{ id: '12' }] },
          },
          {
            id: 31,
            screens: { default: 42 },
            issueTypeScreenSchemes: { values: [{ id: '12' }, { id: '13' }] },
          },
          { id: 32, screens: { default: 99 }, issueTypeScreenSchemes: { values: [{ id: '14' }] } },
        ],
      },
    ],
    '/rest/api/3/issuetypescreenscheme/12/project?maxResults=50': [
      200,
      { isLast: true, values: [{ id: '10000', key: 'OPS' }] },
    ],
    '/rest/api/3/issuetypescreenscheme/13/project?maxResults=50': [
      200,
      { isLast: true, values: [{ id: '10300', key: 'HR' }] },
    ],
  };
}
