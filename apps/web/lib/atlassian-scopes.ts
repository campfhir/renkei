/**
 * The Atlassian OAuth (3LO) scopes Renkei's tools actually use — all
 * GRANULAR (classic and granular scopes cannot mix in one app), grouped into
 * capability bundles rendered as checkboxes via ScopePicker. One checkbox is
 * one capability; the scopes underneath were derived per-endpoint from the
 * vendored OpenAPI specs (docs/atlassian-granular-scopes.md holds the
 * derivation and the console setup blocks). Pure data, importable from
 * client components; atlassian-app.ts re-exports the derived default.
 */

import type { ScopeGroup, ScopeOption } from '@/lib/scope-catalog';

export const ATLASSIAN_SCOPE_GROUPS: ScopeGroup[] = [
  { id: 'jira', label: 'Jira' },
  { id: 'jsm', label: 'Service Management' },
  { id: 'ops', label: 'Operations (alerts & on-call)' },
];

export const ATLASSIAN_SCOPE_OPTIONS: ScopeOption[] = [
  {
    id: 'jira-read',
    label: 'Read work items & directory',
    hint: 'Search, issues, comments, worklogs, filters, projects, users & groups — every read tool',
    group: 'jira',
    defaultChecked: true,
    scopes: [
      'read:application-role:jira',
      'read:attachment:jira',
      'read:audit-log:jira',
      'read:avatar:jira',
      'read:comment.property:jira',
      'read:comment:jira',
      'read:field-configuration:jira',
      'read:field.default-value:jira',
      'read:field.option:jira',
      'read:field:jira',
      'read:filter:jira',
      'read:group:jira',
      'read:issue-details:jira',
      'read:issue-link-type:jira',
      'read:issue-meta:jira',
      'read:issue-security-level:jira',
      'read:issue-type-hierarchy:jira',
      'read:issue-type:jira',
      'read:issue-worklog.property:jira',
      'read:issue-worklog:jira',
      'read:issue.changelog:jira',
      'read:issue.transition:jira',
      'read:issue.vote:jira',
      'read:issue:jira',
      'read:jql:jira',
      'read:project-category:jira',
      'read:project-role:jira',
      'read:project-version:jira',
      'read:project.component:jira',
      'read:project:jira',
      'read:status:jira',
      'read:user.property:jira',
      'read:user:jira',
    ],
  },
  {
    id: 'jira-write',
    label: 'Create & update work items',
    hint: 'Create, edit, transition, comment, attach, log work, link, filters, components, versions (org read-only mode disables these regardless)',
    group: 'jira',
    defaultChecked: true,
    scopes: [
      'write:attachment:jira',
      'write:comment.property:jira',
      'write:comment:jira',
      'write:filter:jira',
      'write:issue-link:jira',
      'write:issue-worklog.property:jira',
      'write:issue-worklog:jira',
      'write:issue.property:jira',
      'write:issue.time-tracking:jira',
      'write:issue:jira',
      'write:project-version:jira',
      'write:project.component:jira',
    ],
  },
  {
    id: 'jira-delete',
    label: 'Delete work items & data',
    hint: 'Delete issues, comments, worklogs, filters, components, issue links — all confirm-gated tools',
    group: 'jira',
    defaultChecked: true,
    scopes: [
      'delete:comment.property:jira',
      'delete:comment:jira',
      'delete:filter:jira',
      'delete:issue-link:jira',
      'delete:issue-worklog.property:jira',
      'delete:issue-worklog:jira',
      'delete:issue:jira',
      'delete:project.component:jira',
    ],
  },
  {
    id: 'boards-read',
    label: 'View boards & sprints',
    hint: 'Boards, board issues, backlog, sprints via the agile API',
    group: 'jira',
    defaultChecked: false,
    scopes: [
      'read:board-scope:jira-software',
      'read:sprint:jira-software',
      'read:issue:jira-software',
    ],
  },
  {
    id: 'boards-write',
    label: 'Manage sprints & board issues',
    hint: 'Create/complete sprints, move issues between sprint and backlog',
    group: 'jira',
    defaultChecked: false,
    scopes: ['write:board-scope:jira-software', 'write:sprint:jira-software'],
  },
  {
    id: 'jsm-read',
    label: 'Read requests',
    hint: 'Requests, comments, participants, approvals, SLAs, request types, service desks',
    group: 'jsm',
    defaultChecked: false,
    scopes: [
      'read:request.approval:jira-service-management',
      'read:request.attachment:jira-service-management',
      'read:request.comment:jira-service-management',
      'read:request.participant:jira-service-management',
      'read:request.sla:jira-service-management',
      'read:request.status:jira-service-management',
      'read:request:jira-service-management',
      'read:requesttype:jira-service-management',
      'read:servicedesk:jira-service-management',
    ],
  },
  {
    id: 'jsm-write',
    label: 'Create & update requests',
    hint: 'Create requests, comment, attach, transition, manage participants (approvals stay read-only by design)',
    group: 'jsm',
    defaultChecked: false,
    scopes: [
      'write:request.attachment:jira-service-management',
      'write:request.comment:jira-service-management',
      'write:request.participant:jira-service-management',
      'write:request.status:jira-service-management',
      'write:request:jira-service-management',
      'delete:request.participant:jira-service-management',
    ],
  },
  {
    id: 'jsm-customers',
    label: 'Manage customers',
    hint: 'List, create, invite, and remove service desk customers',
    group: 'jsm',
    defaultChecked: false,
    scopes: [
      'read:customer:jira-service-management',
      'write:customer:jira-service-management',
      'read:servicedesk.customer:jira-service-management',
      'write:servicedesk.customer:jira-service-management',
      'delete:servicedesk.customer:jira-service-management',
    ],
  },
  {
    id: 'ops-alerts-read',
    label: 'Read alerts',
    hint: 'Alert list and detail',
    group: 'ops',
    defaultChecked: false,
    scopes: ['read:ops-alert:jira-service-management'],
  },
  {
    id: 'ops-alerts-write',
    label: 'Act on alerts',
    hint: 'Acknowledge and close',
    group: 'ops',
    defaultChecked: false,
    scopes: ['write:ops-alert:jira-service-management'],
  },
  {
    id: 'ops-config-read',
    label: 'Read schedules & on-call',
    hint: 'Schedules, rotations, who-is-on-call, teams, escalations',
    group: 'ops',
    defaultChecked: false,
    scopes: ['read:ops-config:jira-service-management'],
  },
  {
    id: 'ops-config-write',
    label: 'Update schedules',
    hint: 'Overrides and rotation changes — confirm-gated wizards',
    group: 'ops',
    defaultChecked: false,
    scopes: ['write:ops-config:jira-service-management'],
  },
  {
    id: 'ops-config-delete',
    label: 'Delete overrides',
    hint: 'Remove schedule overrides — confirm-gated',
    group: 'ops',
    defaultChecked: false,
    scopes: ['delete:ops-config:jira-service-management'],
  },
];

/**
 * Always requested, never a choice: without offline_access Atlassian issues
 * no refresh token, and every grant would die within an hour of connecting.
 */
export const ATLASSIAN_OFFLINE_SCOPE = 'offline_access';
export const ATLASSIAN_REQUIRED_SCOPES = [ATLASSIAN_OFFLINE_SCOPE];

/** Every scope the catalog knows, across all bundles. */
export const ALL_ATLASSIAN_SCOPES = [
  ...new Set(ATLASSIAN_SCOPE_OPTIONS.flatMap((option) => option.scopes)),
];

export const DEFAULT_ATLASSIAN_SCOPES = [
  ...new Set(
    ATLASSIAN_SCOPE_OPTIONS.filter((option) => option.defaultChecked).flatMap(
      (option) => option.scopes
    )
  ),
  ATLASSIAN_OFFLINE_SCOPE,
].join(' ');

/**
 * The org's usable ceiling from a stored scopes string. Settings saved before
 * the granular migration hold classic scopes the catalog no longer knows —
 * filtering to known scopes and falling back to the default set keeps those
 * orgs connectable (at defaults) until an admin re-saves Connector setup.
 */
export function usableAtlassianCeiling(stored: string | null | undefined): string[] {
  const known = new Set(ALL_ATLASSIAN_SCOPES);
  const kept = (stored ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .filter((scope) => known.has(scope));
  return kept.length > 0 ? kept : DEFAULT_ATLASSIAN_SCOPES.split(' ');
}
