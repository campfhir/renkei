import { Kysely, sql } from 'kysely';

/**
 * Give every tenant a starting set of classifier rules.
 *
 * The email sanitizer's fail-safe default is `human`, so a tenant with zero
 * rules classifies EVERYTHING as human correspondence — Zoom recaps, Jira
 * digests, delivery failures, all of it indexed as though a colleague wrote
 * it, and none of it ever excluded as marketing. The default is correct
 * (unrecognized mail must never be dropped); shipping no rules alongside it
 * was the mistake, because it made that fallback the only outcome.
 *
 * Kept deliberately conservative — every rule keys on something no
 * human-composed message carries. A false positive here quietly buries real
 * correspondence; a false negative merely leaves noise indexed. The list is
 * mirrored in DEFAULT_CLASSIFIER_RULES (packages/email-sanitizer) with the
 * rationale for each, and admins may edit or delete any of these rows.
 *
 * ON CONFLICT DO NOTHING against the unique-ish shape means re-running is
 * safe, and a tenant that has already customized a rule with the same
 * match keeps theirs.
 */
const DEFAULTS: {
  category: string;
  matchType: string;
  matchValue: string;
  senderKey: string;
  priority: number;
}[] = [
  {
    category: 'system_notification',
    matchType: 'sender_email_contains',
    matchValue: 'no-reply@',
    senderKey: 'automated',
    priority: 10,
  },
  {
    category: 'system_notification',
    matchType: 'sender_email_contains',
    matchValue: 'noreply@',
    senderKey: 'automated',
    priority: 11,
  },
  {
    category: 'system_notification',
    matchType: 'sender_email_contains',
    matchValue: 'donotreply@',
    senderKey: 'automated',
    priority: 12,
  },
  {
    category: 'system_notification',
    matchType: 'sender_email_contains',
    matchValue: 'notifications@',
    senderKey: 'automated',
    priority: 13,
  },
  {
    category: 'system_notification',
    matchType: 'sender_email_contains',
    matchValue: 'automated@',
    senderKey: 'automated',
    priority: 14,
  },
  {
    category: 'system_notification',
    matchType: 'sender_email_contains',
    matchValue: 'mailer-daemon@',
    senderKey: 'automated',
    priority: 15,
  },
  {
    category: 'system_notification',
    matchType: 'message_id_contains',
    matchValue: 'odspnotify',
    senderKey: 'sharepoint',
    priority: 20,
  },
  {
    category: 'system_notification',
    matchType: 'domain',
    matchValue: 'zoom.us',
    senderKey: 'zoom',
    priority: 30,
  },
  {
    category: 'system_notification',
    matchType: 'domain',
    matchValue: 'automation.atlassian.com',
    senderKey: 'jira',
    priority: 31,
  },
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const rule of DEFAULTS) {
    // One INSERT…SELECT per rule, cross-joined against every tenant, so this
    // works for a fresh install (no tenants — inserts nothing) and a live
    // one alike. The NOT EXISTS guard keeps it idempotent and never
    // overwrites a rule an admin already wrote for the same match.
    await sql`
      INSERT INTO email_classifier_rules
        (id, tenant_id, category, match_type, match_value, sender_key, priority, enabled)
      SELECT gen_random_uuid(), t.id, ${rule.category}, ${rule.matchType},
             ${rule.matchValue}, ${rule.senderKey}, ${rule.priority}, TRUE
      FROM tenants t
      WHERE NOT EXISTS (
        SELECT 1 FROM email_classifier_rules existing
         WHERE existing.tenant_id = t.id
           AND existing.match_type = ${rule.matchType}
           AND existing.match_value = ${rule.matchValue}
      )
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Only removes rules still matching a shipped default exactly — an admin's
  // edits to one of these rows make it theirs, and theirs is not ours to drop.
  for (const rule of DEFAULTS) {
    await sql`
      DELETE FROM email_classifier_rules
       WHERE match_type = ${rule.matchType}
         AND match_value = ${rule.matchValue}
         AND category = ${rule.category}
         AND priority = ${rule.priority}
    `.execute(db);
  }
}
