/**
 * The WebEx user-integration scopes Renkei's tools actually use — the
 * admin form renders these as checkboxes rather than asking anyone to type
 * scope strings. Pure data, importable from client components; the server
 * config reader re-exports the default.
 */

export interface WebexScopeOption {
  scope: string;
  label: string;
  /** What checking it lets the MCP tools do, in the operator's terms. */
  hint: string;
}

export const WEBEX_USER_SCOPE_OPTIONS: WebexScopeOption[] = [
  {
    scope: 'spark:rooms_read',
    label: 'List rooms',
    hint: 'webex_list_rooms — the spaces the user is in',
  },
  {
    scope: 'spark:messages_read',
    label: 'Read messages',
    hint: 'webex_list_messages, webex_get_message, webex_capture_message',
  },
  {
    scope: 'spark:messages_write',
    label: 'Send messages',
    hint: 'webex_send_message — speaks as the user, only on explicit request; org read-only mode disables it',
  },
  {
    scope: 'meeting:schedules_read',
    label: 'List meetings',
    hint: 'webex_list_meetings',
  },
  {
    scope: 'meeting:transcripts_read',
    label: 'Read meeting transcripts',
    hint: 'webex_list_transcripts, webex_get_transcript — hosted meetings only',
  },
  {
    scope: 'meeting:recordings_read',
    label: 'List recordings',
    hint: 'webex_list_recordings, with playback links',
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
  ...WEBEX_USER_SCOPE_OPTIONS.map((option) => option.scope),
  ...WEBEX_REQUIRED_SCOPES,
].join(' ');
