/**
 * The Atlassian OAuth (3LO) scopes Renkei's tools actually use — rendered as
 * checkboxes in the admin connector form, same treatment as WebEx. Pure
 * data, importable from client components; atlassian-app.ts re-exports the
 * derived default.
 */

export interface AtlassianScopeOption {
  scope: string;
  label: string;
  /** What checking it lets the MCP tools do, in the operator's terms. */
  hint: string;
  /** Off by default: the scope must exist on the Atlassian app before use. */
  defaultChecked: boolean;
}

export const ATLASSIAN_SCOPE_OPTIONS: AtlassianScopeOption[] = [
  {
    scope: 'read:jira-work',
    label: 'Read work items',
    hint: 'Search, issues, comments, boards, sprints, worklogs — every read tool',
    defaultChecked: true,
  },
  {
    scope: 'write:jira-work',
    label: 'Create and update work items',
    hint: 'Create, transition, comment, assign, log work — every mutating tool (org read-only mode disables them regardless)',
    defaultChecked: true,
  },
  {
    scope: 'read:jira-user',
    label: 'Look up users',
    hint: 'User search and assignee resolution',
    defaultChecked: true,
  },
  {
    scope: 'read:servicedesk-request',
    label: 'Read JSM requests',
    hint: 'Jira Service Management read tools; requires the scope on the Atlassian app',
    defaultChecked: false,
  },
  {
    scope: 'write:servicedesk-request',
    label: 'Create and update JSM requests',
    hint: 'Jira Service Management mutating tools; requires the scope on the Atlassian app',
    defaultChecked: false,
  },
  {
    scope: 'manage:servicedesk-customer',
    label: 'Manage JSM customers',
    hint: 'Customer add/remove tools; requires the scope on the Atlassian app',
    defaultChecked: false,
  },
  {
    scope: 'read:ops-alert:jira-service-management',
    label: 'Read Ops alerts',
    hint: 'JSM Operations alert list/detail tools; granular scope — requires it on the Atlassian app',
    defaultChecked: false,
  },
  {
    scope: 'write:ops-alert:jira-service-management',
    label: 'Act on Ops alerts',
    hint: 'Acknowledge and close alerts; granular scope — requires it on the Atlassian app',
    defaultChecked: false,
  },
  {
    scope: 'read:ops-config:jira-service-management',
    label: 'Read Ops schedules & on-call',
    hint: 'Schedules, rotations, who-is-on-call tools; granular scope — requires it on the Atlassian app',
    defaultChecked: false,
  },
];

/**
 * Always requested, never a choice: without offline_access Atlassian issues
 * no refresh token, and every grant would die within an hour of connecting.
 */
export const ATLASSIAN_OFFLINE_SCOPE = 'offline_access';

export const DEFAULT_ATLASSIAN_SCOPES = [
  ...ATLASSIAN_SCOPE_OPTIONS.filter((option) => option.defaultChecked).map(
    (option) => option.scope
  ),
  ATLASSIAN_OFFLINE_SCOPE,
].join(' ');
