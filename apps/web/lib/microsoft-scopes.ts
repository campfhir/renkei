/**
 * The Microsoft Graph delegated scopes Renkei's Outlook connector uses —
 * rendered as grouped checkboxes via ScopePicker. Pure data, importable from
 * client components; the server config reader re-exports the default.
 *
 * Short scope names on purpose: Graph accepts them in the scope parameter,
 * and the resource-qualified URIs (https://graph.microsoft.com/Mail.Read)
 * would bloat the authorize URL for nothing — the Atlassian 414 lesson.
 */

import type { ScopeGroup, ScopeOption } from '@/lib/scope-catalog';

export const MICROSOFT_SCOPE_GROUPS: ScopeGroup[] = [
  { id: 'mail', label: 'Mail' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'tasks', label: 'Tasks (Microsoft To Do)' },
  { id: 'directory', label: 'Directory (organization-wide)' },
];

export const MICROSOFT_SCOPE_OPTIONS: ScopeOption[] = [
  {
    id: 'Mail.Read',
    scopes: ['Mail.Read'],
    label: 'Read mail',
    hint: 'outlook_list_messages, outlook_get_message, outlook_search_messages, and inbox ingestion into knowledge',
    group: 'mail',
    defaultChecked: true,
  },
  {
    id: 'Mail.Send',
    scopes: ['Mail.Send'],
    label: 'Send mail',
    hint: 'outlook_send_mail — sends as the user, only on explicit request; org read-only mode disables it',
    group: 'mail',
    defaultChecked: true,
  },
  {
    id: 'Calendars.Read',
    scopes: ['Calendars.Read'],
    label: 'Read calendar',
    hint: 'outlook_list_events, outlook_get_event, and calendar ingestion into knowledge',
    group: 'calendar',
    defaultChecked: true,
  },
  {
    id: 'Calendars.ReadWrite',
    scopes: ['Calendars.ReadWrite'],
    label: 'Manage calendar',
    hint:
      'outlook_create_event (sends invites), outlook_respond_event (accept/tentative/decline, ' +
      'propose a new time) — acts as the user; org read-only mode disables them',
    group: 'calendar',
    defaultChecked: true,
  },
  {
    id: 'Tasks.Read',
    scopes: ['Tasks.Read'],
    label: 'Read tasks',
    hint: 'outlook_list_task_lists, outlook_list_tasks, and To Do ingestion into knowledge',
    group: 'tasks',
    defaultChecked: true,
  },
  {
    id: 'User.Read.All',
    scopes: ['User.Read.All'],
    label: 'Employee directory',
    hint:
      'outlook_search_users, outlook_get_user — titles, departments, locations, managers, ' +
      'direct reports. Requires admin consent on the Entra app.',
    group: 'directory',
    defaultChecked: true,
  },
  {
    id: 'Group.Read.All',
    scopes: ['Group.Read.All'],
    label: 'Groups & mailing lists',
    hint:
      'outlook_list_groups, outlook_list_group_members — Microsoft 365 groups and distribution ' +
      'lists. Requires admin consent on the Entra app.',
    group: 'directory',
    defaultChecked: true,
  },
];

/**
 * Always requested, never a choice — structural, not capabilities:
 * openid/profile/email put the identity claims (oid, tid, upn) in the
 * id_token so the callback knows WHO granted; offline_access is what makes
 * Microsoft mint a refresh token at all; User.Read backs the GET /me
 * fallback when a claim is missing.
 */
export const MICROSOFT_REQUIRED_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'User.Read',
];

export const DEFAULT_MICROSOFT_SCOPES = [
  ...MICROSOFT_SCOPE_OPTIONS.flatMap((option) => option.scopes),
  ...MICROSOFT_REQUIRED_SCOPES,
].join(' ');
