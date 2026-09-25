/**
 * The Microsoft Graph delegated scopes Renkei's Entra Developer connector
 * uses — rendered as grouped checkboxes via ScopePicker, the
 * microsoft-scopes.ts shape. Pure data, importable from client components;
 * the server config reader re-exports the default.
 *
 * These are DIRECTORY-WIDE permissions (an application registration is a
 * tenant object, not something a person owns), and the write ones need an
 * Entra admin's consent on the app registration. That is exactly why they
 * live on a second app registration and grant rather than on the everyday
 * Microsoft 365 one: nobody should have to consent to
 * Application.ReadWrite.All to read their own mail.
 */

import type { ScopeGroup, ScopeOption } from '@/lib/scope-catalog';

export const ENTRA_DEVELOPER_SCOPE_GROUPS: ScopeGroup[] = [
  { id: 'applications', label: 'Applications' },
  { id: 'assignments', label: 'Role assignments' },
  { id: 'directory', label: 'Directory (finding people and groups to assign)' },
];

export const ENTRA_DEVELOPER_SCOPE_OPTIONS: ScopeOption[] = [
  {
    id: 'Application.Read.All',
    scopes: ['Application.Read.All'],
    label: 'Read applications',
    hint:
      'entra_list_applications, entra_get_application, entra_list_enterprise_applications, ' +
      'entra_get_enterprise_application (app registrations, enterprise applications, their ' +
      'app roles and who is assigned to each), entra_check_access. Requires admin consent on ' +
      'the Entra app.',
    userHint:
      'Read the organisation’s app registrations and enterprise applications, their app roles, ' +
      'and who is assigned to them.',
    group: 'applications',
    defaultChecked: true,
  },
  {
    id: 'Application.ReadWrite.All',
    scopes: ['Application.Read.All', 'Application.ReadWrite.All'],
    label: 'Create and change applications',
    hint:
      'entra_create_application (an app registration, optionally with its enterprise ' +
      'application and app roles), entra_update_application (name, redirect URIs, identifier ' +
      'URIs), entra_create_enterprise_application, entra_add_app_roles, entra_remove_app_role — ' +
      'every one preview + confirm on a card. Carries Application.Read.All. Requires admin ' +
      'consent on the Entra app; Entra still checks that the person may create or owns the ' +
      'application on every call.',
    userHint:
      'Create app registrations and enterprise applications, and change their names, redirect ' +
      'URIs and app roles — each change confirmed by you on a card first.',
    group: 'applications',
    defaultChecked: true,
  },
  {
    id: 'AppRoleAssignment.ReadWrite.All',
    scopes: ['AppRoleAssignment.ReadWrite.All'],
    label: 'Assign people and groups to app roles',
    hint:
      'entra_assign_app_role, entra_remove_app_role_assignment — adds or removes a user or ' +
      'group on an enterprise application’s app role, preview + confirm. Requires admin ' +
      'consent on the Entra app.',
    userHint:
      'Give users and groups an app role on an enterprise application, or take one away — ' +
      'each change confirmed by you on a card first.',
    group: 'assignments',
    defaultChecked: true,
  },
  {
    id: 'User.ReadBasic.All',
    scopes: ['User.ReadBasic.All'],
    label: 'Find people',
    hint:
      'entra_search_users — names, addresses and ids, to pick who gets an app role; also lets ' +
      'the assign tools take a name or address instead of an id. Basic profile only; no admin ' +
      'consent needed.',
    userHint: 'Look up colleagues by name or address, to assign them an app role.',
    group: 'directory',
    defaultChecked: true,
  },
  {
    id: 'Group.Read.All',
    scopes: ['Group.Read.All'],
    label: 'Find groups',
    hint:
      'entra_search_groups — security and Microsoft 365 groups by name, to pick which get an ' +
      'app role; also lets the assign tools take a group name instead of an id. Requires ' +
      'admin consent on the Entra app.',
    userHint: 'Look up groups by name, to assign them an app role.',
    group: 'directory',
    defaultChecked: true,
  },
];

/**
 * Always requested, never a choice — structural, not capabilities: the
 * same set the Microsoft 365 connector needs and for the same reasons
 * (identity claims for the callback, offline_access for a refresh token,
 * User.Read for the /me fallback).
 */
export const ENTRA_DEVELOPER_REQUIRED_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'User.Read',
];

export const DEFAULT_ENTRA_DEVELOPER_SCOPES = [
  ...new Set([
    ...ENTRA_DEVELOPER_SCOPE_OPTIONS.flatMap((option) => option.scopes),
    ...ENTRA_DEVELOPER_REQUIRED_SCOPES,
  ]),
].join(' ');
