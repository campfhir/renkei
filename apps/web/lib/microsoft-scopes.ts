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
    userHint: 'Read your email, including message contents, attachments and folders.',
    group: 'mail',
    defaultChecked: true,
  },
  {
    id: 'Mail.Send',
    scopes: ['Mail.Send'],
    label: 'Send mail',
    hint: 'outlook_send_mail — sends as the user, only on explicit request; org read-only mode disables it',
    userHint: 'Send email as you. Only ever on your explicit instruction.',
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
    userHint: 'Mark your mail read or unread, flag it, categorise it, and move it between folders.',
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
    userHint: 'Create, rename and delete folders in your mailbox.',
    group: 'mail',
    defaultChecked: false,
  },
  {
    id: 'Calendars.Read',
    scopes: ['Calendars.Read'],
    label: 'Read calendar',
    hint: 'outlook_list_events, outlook_get_event, and calendar ingestion into knowledge',
    userHint: 'Read your calendar: events, times, locations and who was invited.',
    group: 'calendar',
    defaultChecked: true,
  },
  {
    id: 'Calendars.ReadWrite',
    scopes: ['Calendars.ReadWrite'],
    label: 'Manage calendar',
    hint:
      'outlook_create_event (sends invites), outlook_respond_event (accept/tentative/decline, ' +
      'propose a new time), outlook_cancel_event_preview (cancel or remove an event via a ' +
      'confirm card) — acts as the user; org read-only mode disables them',
    userHint:
      'Create, change and cancel events on your calendar, and respond to invitations as you.',
    group: 'calendar',
    defaultChecked: true,
  },
  {
    id: 'Tasks.Read',
    scopes: ['Tasks.Read'],
    label: 'Read tasks',
    hint: 'outlook_list_task_lists, outlook_list_tasks, and To Do ingestion into knowledge',
    userHint: 'Read your Microsoft To Do lists and tasks.',
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
    userHint:
      'Look up colleagues in your organisation’s directory — names, job titles and email addresses.',
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
    userHint: 'See the groups and mailing lists in your organisation, and who belongs to them.',
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
    userHint: 'Read the files in your own OneDrive.',
    group: 'files',
    defaultChecked: false,
  },
  {
    id: 'Files.ReadWrite',
    scopes: ['Files.Read', 'Files.ReadWrite'],
    label: 'Manage my OneDrive',
    hint:
      'onedrive_request_document_upload, onedrive_create_folder, onedrive_rename_document, ' +
      'onedrive_move_document, onedrive_copy_document, onedrive_delete_document, ' +
      'onedrive_share_document — creates, renames, moves, DELETES and shares files as the user. ' +
      'Carries Files.Read, so the read tools come with it. Off by default: add Files.ReadWrite ' +
      'on the Entra app registration first, then reconnect.',
    userHint: 'Create, edit and delete files in your own OneDrive.',
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
    userHint: 'Read files and documents that other people have shared with you.',
    group: 'files',
    defaultChecked: false,
  },
  {
    id: 'Files.ReadWrite.All',
    scopes: ['Files.Read', 'Files.ReadWrite', 'Files.Read.All', 'Files.ReadWrite.All'],
    label: 'Edit files shared with me',
    hint:
      'The same OneDrive tools, but reaching files in OTHER people’s drives — editing, renaming ' +
      'or deleting a document a colleague shared with you. Files.ReadWrite alone cannot do this: ' +
      'a shared document lives in its owner’s drive, and that scope only covers your own. This ' +
      'bundle carries all four Files scopes, so it is the single box to check for full OneDrive ' +
      'use. Broad by nature — it reaches every file the user can already open. Requires admin ' +
      'consent on the Entra app.',
    userHint: 'Edit files and documents that other people have shared with you.',
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
    userHint: 'Read SharePoint sites, pages and document libraries you already have access to.',
    group: 'sharepoint',
    defaultChecked: false,
  },
  {
    id: 'Sites.ReadWrite.All',
    scopes: ['Sites.Read.All', 'Sites.ReadWrite.All'],
    label: 'Manage SharePoint content',
    hint:
      'sharepoint_create_page, sharepoint_update_page, sharepoint_request_document_upload, ' +
      'sharepoint_rename_document, sharepoint_move_document, sharepoint_delete_document, ' +
      'sharepoint_update_document_metadata, sharepoint_share_document. Does NOT change ' +
      'site-level permissions — Graph offers no delegated API for that, and Renkei deliberately ' +
      'does not offer it; manage site access in SharePoint itself. Carries Sites.Read.All. ' +
      'Requires admin consent on the Entra app.',
    userHint: 'Create and change SharePoint pages and documents you already have access to.',
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
