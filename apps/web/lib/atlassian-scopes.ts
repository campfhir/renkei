/**
 * The Atlassian OAuth (3LO) scopes Renkei's tools actually use — rendered as
 * grouped checkboxes via ScopePicker. Pure data, importable from client
 * components; atlassian-app.ts re-exports the derived default.
 */

import type { ScopeGroup, ScopeOption } from '@/lib/scope-catalog';

export const ATLASSIAN_SCOPE_GROUPS: ScopeGroup[] = [
  { id: 'jira', label: 'Jira' },
  { id: 'jsm', label: 'Service Management' },
  { id: 'ops', label: 'Operations (alerts & on-call)' },
];

export const ATLASSIAN_SCOPE_OPTIONS: ScopeOption[] = [
  {
    scope: 'read:jira-work',
    label: 'Read work items',
    hint: 'Search, issues, comments, boards, sprints, worklogs — every read tool',
    group: 'jira',
    defaultChecked: true,
  },
  {
    scope: 'write:jira-work',
    label: 'Create and update work items',
    hint: 'Create, transition, comment, assign, log work (org read-only mode disables these regardless)',
    group: 'jira',
    defaultChecked: true,
  },
  {
    scope: 'read:jira-user',
    label: 'Look up users',
    hint: 'User search and assignee resolution',
    group: 'jira',
    defaultChecked: true,
  },
  {
    scope: 'read:board-scope:jira-software',
    label: 'View boards & backlogs',
    hint: 'Boards, board issues, backlog, sprints via the agile API — granular scope; the classic read:jira-work does not always cover it',
    group: 'jira',
    defaultChecked: false,
  },
  {
    scope: 'write:board-scope:jira-software',
    label: 'Move issues on boards',
    hint: 'Move issues between board and backlog — granular scope',
    group: 'jira',
    defaultChecked: false,
  },
  {
    scope: 'read:servicedesk-request',
    label: 'Read requests',
    hint: 'Service desk request read tools',
    group: 'jsm',
    defaultChecked: false,
  },
  {
    scope: 'write:servicedesk-request',
    label: 'Create and update requests',
    hint: 'Service desk mutating tools',
    group: 'jsm',
    defaultChecked: false,
  },
  {
    scope: 'manage:servicedesk-customer',
    label: 'Manage customers',
    hint: 'Customer add/remove tools',
    group: 'jsm',
    defaultChecked: false,
  },
  {
    scope: 'read:ops-alert:jira-service-management',
    label: 'Read alerts',
    hint: 'Alert list and detail',
    group: 'ops',
    defaultChecked: false,
  },
  {
    scope: 'write:ops-alert:jira-service-management',
    label: 'Act on alerts',
    hint: 'Acknowledge and close',
    group: 'ops',
    defaultChecked: false,
  },
  {
    scope: 'read:ops-config:jira-service-management',
    label: 'Read schedules & on-call',
    hint: 'Schedules, rotations, who-is-on-call, teams, escalations',
    group: 'ops',
    defaultChecked: false,
  },
  {
    scope: 'write:ops-config:jira-service-management',
    label: 'Update schedules',
    hint: 'Overrides and rotation changes — confirm-gated wizards',
    group: 'ops',
    defaultChecked: false,
  },
  {
    scope: 'delete:ops-config:jira-service-management',
    label: 'Delete overrides',
    hint: 'Remove schedule overrides — confirm-gated',
    group: 'ops',
    defaultChecked: false,
  },
];

/**
 * Always requested, never a choice: without offline_access Atlassian issues
 * no refresh token, and every grant would die within an hour of connecting.
 */
export const ATLASSIAN_OFFLINE_SCOPE = 'offline_access';
export const ATLASSIAN_REQUIRED_SCOPES = [ATLASSIAN_OFFLINE_SCOPE];

export const DEFAULT_ATLASSIAN_SCOPES = [
  ...ATLASSIAN_SCOPE_OPTIONS.filter((option) => option.defaultChecked).map(
    (option) => option.scope
  ),
  ATLASSIAN_OFFLINE_SCOPE,
].join(' ');
