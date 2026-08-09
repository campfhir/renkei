/**
 * The WebEx user-integration scopes Renkei's tools actually use — rendered as
 * grouped checkboxes via ScopePicker. Pure data, importable from client
 * components; the server config reader re-exports the default.
 */

import type { ScopeGroup, ScopeOption } from '@/lib/scope-catalog';

export const WEBEX_SCOPE_GROUPS: ScopeGroup[] = [
  { id: 'messaging', label: 'Messaging' },
  { id: 'meetings', label: 'Meetings' },
];

export const WEBEX_USER_SCOPE_OPTIONS: ScopeOption[] = [
  {
    id: 'spark:rooms_read',
    scopes: ['spark:rooms_read'],
    label: 'List rooms',
    hint: 'webex_list_rooms — the spaces the user is in',
    group: 'messaging',
    defaultChecked: true,
  },
  {
    id: 'spark:messages_read',
    scopes: ['spark:messages_read'],
    label: 'Read messages',
    hint: 'webex_list_messages, webex_get_message, webex_capture_message',
    group: 'messaging',
    defaultChecked: true,
  },
  {
    id: 'spark:messages_write',
    scopes: ['spark:messages_write'],
    label: 'Send messages',
    hint: 'webex_send_message — speaks as the user, only on explicit request; org read-only mode disables it',
    group: 'messaging',
    defaultChecked: true,
  },
  {
    id: 'meeting:schedules_read',
    scopes: ['meeting:schedules_read'],
    label: 'List meetings',
    hint: 'webex_list_meetings',
    group: 'meetings',
    defaultChecked: true,
  },
  {
    id: 'meeting:transcripts_read',
    scopes: ['meeting:transcripts_read'],
    label: 'Read meeting transcripts',
    hint: 'webex_list_transcripts, webex_get_transcript — hosted meetings only',
    group: 'meetings',
    defaultChecked: true,
  },
  {
    id: 'meeting:recordings_read',
    scopes: ['meeting:recordings_read'],
    label: 'List recordings',
    hint: 'webex_list_recordings, with playback links',
    group: 'meetings',
    defaultChecked: true,
  },
];

/**
 * Always requested, never a choice — structural, not capabilities:
 * spark:people_read is how the callback identifies WHO granted (/people/me
 * answers 403 without it, killing every connect), and spark:kms is required
 * to decrypt message content, without which every read scope is decorative.
 */
export const WEBEX_REQUIRED_SCOPES = ['spark:people_read', 'spark:kms'];

export const DEFAULT_WEBEX_USER_SCOPES = [
  ...WEBEX_USER_SCOPE_OPTIONS.flatMap((option) => option.scopes),
  ...WEBEX_REQUIRED_SCOPES,
].join(' ');
