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
  { id: 'files', label: 'Files (OneDrive)' },
  { id: 'sharepoint', label: 'SharePoint' },
  { id: 'directory', label: 'Directory (organization-wide)' },
];

export const MICROSOFT_SCOPE_OPTIONS: ScopeOption[] = [
  {
    id: 'Mail.Read',
    scopes: ['Mail.Read'],
    label: 'Read mail',
    hint:
      'outlook_list_messages, outlook_get_message, outlook_search_messages, ' +
      'outlook_list_mail_folders, and inbox ingestion into knowledge',
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
    id: 'Mail.ReadWrite',
    scopes: ['Mail.ReadWrite'],
    label: 'Mark, flag & categorize mail',
    hint:
      'outlook_mark_message, outlook_flag_message, outlook_categorize_message, ' +
      'outlook_move_message — changes message state/location, never content. Off by default: ' +
      'add Mail.ReadWrite as a delegated Microsoft Graph permission on the Entra app ' +
      'registration before checking this, or Microsoft will reject the consent. Anyone already ' +
      "connected needs to reconnect afterward — a user's existing grant only carries the scopes " +
      'they consented to at connect time.',
    group: 'mail',
    defaultChecked: false,
  },
  {
    id: 'MailboxFolder.ReadWrite',
    scopes: ['MailboxFolder.ReadWrite'],
    label: 'Manage mail folders',
    hint:
      'outlook_create_mail_folder, outlook_rename_mail_folder, outlook_delete_mail_folder — ' +
      'creates/renames/deletes the folders themselves, not message content. Off by default: add ' +
      'MailboxFolder.ReadWrite as a delegated Microsoft Graph permission on the Entra app ' +
      'registration before checking this, or Microsoft will reject the consent. Anyone already ' +
      "connected needs to reconnect afterward — a user's existing grant only carries the scopes " +
      'they consented to at connect time.',
    group: 'mail',
    defaultChecked: false,
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
  // The ReadWrite bundles carry their Read scope too, so checking "manage"
  // alone still registers the read tools — the same reasoning confluence's
  // scope bundles use. Every option below is off by default and needs the
  // matching delegated permission on the Entra app first.
  {
    id: 'Files.Read',
    scopes: ['Files.Read'],
    label: 'Read my OneDrive',
    hint:
      'onedrive_list_folder, onedrive_get_document, onedrive_download_document, ' +
      'onedrive_search_documents, onedrive_list_recent — the caller’s own OneDrive only. Off by ' +
      'default: add Files.Read as a delegated Microsoft Graph permission on the Entra app ' +
      'registration before checking this, or Microsoft will reject the consent. Anyone already ' +
      'connected needs to reconnect afterward.',
    group: 'files',
    defaultChecked: false,
  },
  {
    id: 'Files.ReadWrite',
    scopes: ['Files.Read', 'Files.ReadWrite'],
    label: 'Manage my OneDrive',
    hint:
      'onedrive_upload_document, onedrive_create_folder, onedrive_rename_document, ' +
      'onedrive_move_document, onedrive_copy_document, onedrive_delete_document, ' +
      'onedrive_share_document — creates, renames, moves, DELETES and shares files as the user. ' +
      'Carries Files.Read, so the read tools come with it. Off by default: add Files.ReadWrite ' +
      'on the Entra app registration first, then reconnect.',
    group: 'files',
    defaultChecked: false,
  },
  {
    id: 'Files.Read.All',
    scopes: ['Files.Read.All'],
    label: 'Read files shared with me',
    hint:
      'onedrive_list_shared_with_me, resolving a pasted SharePoint/OneDrive link to a file, and ' +
      'verifying access to indexed documents at search time — WITHOUT this, SharePoint results ' +
      'are withheld from search even when the documents are indexed. Reaches every file the ' +
      'user can already open, including other people’s drives. Requires admin consent on the ' +
      'Entra app.',
    group: 'files',
    defaultChecked: false,
  },
  {
    id: 'Sites.Read.All',
    scopes: ['Sites.Read.All'],
    label: 'Read SharePoint',
    hint:
      'sharepoint_find_sites, sharepoint_list_libraries, sharepoint_list_pages, ' +
      'sharepoint_read_page, sharepoint_list_folder, sharepoint_search_documents, ' +
      'sharepoint_get_document_metadata, and indexing a watched library into knowledge — every ' +
      'SharePoint site the user can already open. Requires admin consent on the Entra app.',
    group: 'sharepoint',
    defaultChecked: false,
  },
  {
    id: 'Sites.ReadWrite.All',
    scopes: ['Sites.Read.All', 'Sites.ReadWrite.All'],
    label: 'Manage SharePoint content',
    hint:
      'sharepoint_create_page, sharepoint_update_page, sharepoint_upload_document, ' +
      'sharepoint_rename_document, sharepoint_move_document, sharepoint_delete_document, ' +
      'sharepoint_update_document_metadata, sharepoint_share_document. Does NOT change ' +
      'site-level permissions — Graph has no delegated API for that; see the team-site option ' +
      'below. Carries Sites.Read.All. Requires admin consent on the Entra app.',
    group: 'sharepoint',
    defaultChecked: false,
  },
  {
    id: 'GroupMember.ReadWrite.All',
    scopes: ['GroupMember.ReadWrite.All'],
    label: 'Add & remove team site members',
    hint:
      'sharepoint_add_site_member, sharepoint_remove_site_member — the only delegated way to ' +
      'change who can reach a SharePoint site, and only for Microsoft 365 group-connected team ' +
      'sites. CHANGES THE GROUP EVERYWHERE IT IS USED — Teams, the group mailbox, the group ' +
      'calendar — not only the site. Requires admin consent on the Entra app.',
    group: 'sharepoint',
    defaultChecked: false,
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
