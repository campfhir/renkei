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

/**
 * Classifier rules every tenant starts with.
 *
 * These exist because the pipeline's fail-safe default is `human`: with an
 * empty rule set NOTHING is ever categorized as a notification or
 * marketing, so a mailbox indexes Zoom recaps and Jira digests as though
 * they were colleagues' mail. The fail-safe is right — unrecognized mail
 * must never be dropped — but "no rules at all" made it the only outcome.
 *
 * Chosen to be near-zero-false-positive rather than exhaustive. Every rule
 * keys on something no human-composed message carries: a machine local
 * part (`no-reply@`), a vendor's notification-only domain, or a fixed
 * system tag in the Message-ID. Anything ambiguous is deliberately absent —
 * a false positive here quietly buries real mail, which is far worse than
 * a false negative that merely leaves noise indexed. Admins extend this at
 * /[slug]/admin/email-sanitizer, and may edit or delete any of it.
 *
 * `marketing` is EXCLUDED from indexing entirely; `system_notification` is
 * still indexed, but extraction-templated and never mistaken for
 * correspondence — so the bar for `marketing` is higher.
 */
export interface SeedClassifierRule {
  category: 'human' | 'system_notification' | 'marketing';
  matchType:
    | 'domain'
    | 'sender_email'
    | 'sender_email_contains'
    | 'subject_contains'
    | 'sender_domain'
    | 'reply_to_domain'
    | 'message_id_contains';
  matchValue: string;
  senderKey: string | null;
  priority: number;
  /** Why this rule is safe — surfaced nowhere, kept for whoever edits this list. */
  rationale: string;
}

export const DEFAULT_CLASSIFIER_RULES: readonly SeedClassifierRule[] = [
  // --- machine local parts: the single strongest signal, domain-independent.
  {
    category: 'system_notification',
    matchType: 'sender_email_contains',
    matchValue: 'no-reply@',
    senderKey: 'automated',
    priority: 10,
    rationale: 'A person does not send from an address that says not to reply to it.',
  },
  {
    category: 'system_notification',
    matchType: 'sender_email_contains',
    matchValue: 'noreply@',
    senderKey: 'automated',
    priority: 11,
    rationale: 'Same as no-reply@, unhyphenated spelling.',
  },
  {
    category: 'system_notification',
    matchType: 'sender_email_contains',
    matchValue: 'donotreply@',
    senderKey: 'automated',
    priority: 12,
    rationale: 'Same as no-reply@, third common spelling.',
  },
  {
    category: 'system_notification',
    matchType: 'sender_email_contains',
    matchValue: 'notifications@',
    senderKey: 'automated',
    priority: 13,
    rationale: 'Reserved mailbox name for machine-generated notices.',
  },
  {
    category: 'system_notification',
    matchType: 'sender_email_contains',
    matchValue: 'automated@',
    senderKey: 'automated',
    priority: 14,
    rationale: 'Self-declaring machine sender.',
  },
  {
    category: 'system_notification',
    matchType: 'sender_email_contains',
    matchValue: 'mailer-daemon@',
    senderKey: 'automated',
    priority: 15,
    rationale: 'Bounce/delivery notices, never correspondence.',
  },
  // --- SharePoint/OneDrive share notices, which impersonate a colleague in
  // every visible header. The Message-ID is the only reliable tell; see
  // classify.ts's header comment for the sample that proved this out.
  {
    category: 'system_notification',
    matchType: 'message_id_contains',
    matchValue: 'odspnotify',
    senderKey: 'sharepoint',
    priority: 20,
    rationale: 'Fixed system tag on SharePoint/OneDrive share notices; From is a real person.',
  },
  // --- notification-only vendor domains. Kept to domains that send ONLY
  // machine mail; a domain that also carries human correspondence (github.com,
  // atlassian.net) is deliberately handled by the local-part rules above.
  {
    category: 'system_notification',
    matchType: 'domain',
    matchValue: 'zoom.us',
    senderKey: 'zoom',
    priority: 30,
    rationale: 'Meeting recaps and recording notices.',
  },
  {
    category: 'system_notification',
    matchType: 'domain',
    matchValue: 'automation.atlassian.com',
    senderKey: 'jira',
    priority: 31,
    rationale: 'Jira automation rule output.',
  },
];
