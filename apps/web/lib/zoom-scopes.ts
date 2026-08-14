/**
 * The Zoom granular scopes Renkei's tools use — rendered as grouped
 * checkboxes via ScopePicker. Pure data, importable from client components;
 * the server config reader re-exports the default.
 *
 * Two Zoom particulars the picker copy must not hide:
 * - This catalog must MIRROR the Marketplace app's selected scopes: the
 *   authorize request may only name scopes that exist on the app (granular
 *   apps honor a `scope` parameter — the advanced authorization query — so
 *   the narrowed selection IS what gets minted; a scope missing from the
 *   app fails the authorize).
 * - Narrowing is additionally enforced by Renkei at tool registration, so
 *   even a token minted wider than the selection (classic-scope apps
 *   ignore the scope parameter entirely) exposes only the chosen tools.
 */

import type { ScopeGroup, ScopeOption } from '@/lib/scope-catalog';

export const ZOOM_SCOPE_GROUPS: ScopeGroup[] = [
  { id: 'meetings', label: 'Meetings' },
  { id: 'recordings', label: 'Recordings & AI Companion' },
  { id: 'docs', label: 'Zoom Docs' },
];

export const ZOOM_SCOPE_OPTIONS: ScopeOption[] = [
  {
    id: 'zoom-meetings-read',
    scopes: ['meeting:read:list_meetings', 'meeting:read:meeting'],
    label: 'Read meetings',
    hint: 'zoom_list_meetings, zoom_get_meeting',
    userHint: 'See your scheduled Zoom meetings and their details.',
    group: 'meetings',
    defaultChecked: true,
  },
  {
    id: 'zoom-meetings-manage',
    scopes: ['meeting:write:meeting', 'meeting:update:meeting', 'meeting:delete:meeting'],
    label: 'Schedule & manage meetings',
    hint: 'zoom_create_meeting, zoom_update_meeting, zoom_delete_meeting — acts as you; org read-only mode disables them',
    userHint: 'Schedule, change and cancel Zoom meetings as you.',
    group: 'meetings',
    defaultChecked: true,
  },
  {
    id: 'zoom-recordings-read',
    scopes: [
      'cloud_recording:read:list_user_recordings',
      'cloud_recording:read:list_recording_files',
      'cloud_recording:read:meeting_transcript',
    ],
    label: 'Read recordings & transcripts',
    hint: 'zoom_list_recordings, zoom_get_transcript, and transcript ingestion into knowledge (meetings you host)',
    userHint: 'Access your Zoom cloud recordings.',
    group: 'recordings',
    defaultChecked: true,
  },
  {
    id: 'zoom-summaries-read',
    scopes: ['meeting:read:summary'],
    label: 'Read AI meeting summaries',
    hint: 'zoom_get_meeting_summary, and summary ingestion into knowledge — needs AI Companion enabled on the account',
    userHint: 'Read Zoom’s AI summaries of your meetings.',
    group: 'recordings',
    defaultChecked: true,
  },
  {
    id: 'zoom-notes-read',
    scopes: ['my_notes:read:note', 'my_notes:read:content'],
    label: 'Read My Notes',
    hint:
      'zoom_list_notes, zoom_get_note — personal meeting notes and their transcripts. Needs ' +
      'My Notes enabled on the account; the API is read-only (Zoom publishes no update ' +
      'endpoint).',
    userHint: 'Read your Zoom notes and documents.',
    group: 'recordings',
    defaultChecked: true,
  },
  {
    // Its own option, not folded into the notes bundle: the search lives in
    // the Zoom DOCS (Canvas) API, which is provisioned separately from My
    // Notes — an org without Docs should be able to grant notes reading
    // without this, and a bundled invisible scope would hide the whole
    // notes option from any connect card whose ceiling predates it.
    id: 'zoom-notes-search',
    // "write" is only Zoom's granular naming for a POST endpoint; it reads.
    scopes: ['canvas:write:file_search'],
    label: 'Search notes across meetings',
    hint:
      'zoom_search_notes — list or search My Notes without a meeting id. Needs Zoom Docs ' +
      'enabled on the account (separate from My Notes).',
    userHint: 'Search across your Zoom notes.',
    group: 'recordings',
    defaultChecked: true,
  },
  {
    id: 'zoom-docs-read',
    scopes: ['docs:read:export'],
    label: 'Read docs',
    hint:
      'zoom_get_doc — any Zoom Doc as Markdown, including My Notes pages (a note IS a doc). ' +
      'Needs Zoom Docs enabled on the account.',
    userHint: 'Read your Zoom documents.',
    group: 'docs',
    defaultChecked: true,
  },
  {
    id: 'zoom-docs-write',
    scopes: ['docs:write:import', 'docs:write:content'],
    label: 'Create & append to docs',
    hint:
      'zoom_create_doc, zoom_append_to_doc — write as the user, including appending to a ' +
      "note's doc page; org read-only mode disables them. Needs Zoom Docs enabled.",
    userHint: 'Create and edit Zoom documents as you.',
    group: 'docs',
    defaultChecked: true,
  },
];

/**
 * Always requested, never a choice — structural, not a capability:
 * user:read:user is how the callback identifies WHO granted (GET /users/me),
 * and how webhook deliveries map host_id back to a grant.
 */
export const ZOOM_REQUIRED_SCOPES = ['user:read:user'];

export const DEFAULT_ZOOM_SCOPES = [
  ...ZOOM_SCOPE_OPTIONS.flatMap((option) => option.scopes),
  ...ZOOM_REQUIRED_SCOPES,
].join(' ');
