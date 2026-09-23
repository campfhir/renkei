/**
 * A fake Jira site for the jira-admin tests: OPS, a company-managed
 * software space with every scheme and two roles — path and query mapped to
 * [status, body], the way the jira_admin_ tool tests stand Jira in.
 * Not a test file (Jest collects *.test.ts), so importing it registers no
 * tests of its own.
 */

export const FAKE_BASE = 'https://api.atlassian.com/ex/jira/cloud-1';

/** A company-managed software space, OPS, with every scheme and two roles. */
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
  };
}
