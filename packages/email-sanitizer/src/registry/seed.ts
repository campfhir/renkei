/**
 * Illustrative seed templates for Jira Cloud and Jira Service Management
 * notification emails, expressed in the same `TemplateSegment[]` format any
 * admin-taught sender uses — proving the engine needs no special-cased code
 * for these two senders, just data.
 *
 * These are placeholders, not a verified match for any real tenant's
 * current Jira instance: Jira's notification HTML varies by version/theme
 * and changes over time, which is exactly the drift problem this system
 * exists to handle. On real mail these will very likely score below their
 * threshold at first — which is the intended fail-safe (fall through to the
 * generic cleaner and flag for the message's owner to re-teach the format
 * from a real sample) rather than silently extracting nothing useful.
 */

import type { TemplateSegment } from '../types';

const ISSUE_KEY_PATTERN = '[A-Z][A-Z0-9]+-\\d+';

export const JIRA_SEED_SEGMENTS: TemplateSegment[] = [
  { type: 'field', name: 'actor' },
  { type: 'literal', text: 'commented on' },
  { type: 'field', name: 'issueKey', pattern: ISSUE_KEY_PATTERN },
  { type: 'literal', text: ':' },
  { type: 'field', name: 'commentBody' },
  { type: 'literal', text: 'View Issue' },
  { type: 'field', name: 'trailing' },
  { type: 'literal', text: 'This message was sent by Atlassian Jira' },
];

export const JSM_SEED_SEGMENTS: TemplateSegment[] = [
  { type: 'literal', text: 'Request' },
  { type: 'field', name: 'requestKey', pattern: ISSUE_KEY_PATTERN },
  { type: 'literal', text: 'has been updated' },
  { type: 'field', name: 'statusChange' },
  { type: 'literal', text: 'View request' },
  { type: 'field', name: 'trailing' },
  { type: 'literal', text: 'This message was sent by Jira Service Management' },
];

export interface SeedTemplate {
  senderKey: string;
  segments: TemplateSegment[];
  matchThreshold: number;
}

export const SEED_TEMPLATES: readonly SeedTemplate[] = [
  { senderKey: 'jira', segments: JIRA_SEED_SEGMENTS, matchThreshold: 0.85 },
  { senderKey: 'jsm', segments: JSM_SEED_SEGMENTS, matchThreshold: 0.85 },
];

/**
 * Built-in "external sender" warning-banner phrases, verified against real
 * gateway output rather than a guess like the Jira/JSM templates above —
 * unlike those, these are always active: `sanitizeEmailForTenant` unions
 * them with a tenant's own `email_banner_patterns` rows, so out-of-the-box
 * behavior never regresses to "nothing stripped" while an org is still
 * building out its own library. An admin can't disable one of these from
 * the UI (there's no row to toggle) — if that's ever needed, promote it to
 * a real per-tenant row with `enabled: false` instead of special-casing it
 * here.
 */
export const SEED_BANNERS: readonly string[] = [
  'CAUTION : This Email is from an EXTERNAL source. DO NOT CLICK LINKS or ' +
    'ATTACHMENTS if the email is not anticipated, and NEVER provide your User ID or Password.',
  '[EXTERNAL EMAIL] DO NOT CLICK links or attachments unless you recognize the sender ' +
    'and know the content is safe.',
];
