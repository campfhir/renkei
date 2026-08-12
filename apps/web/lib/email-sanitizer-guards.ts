/**
 * Type predicates for the email-sanitizer route handlers — the repo bans
 * type assertions (`assertionStyle: 'never'`), so validating a request
 * body's string fields against the pipeline's literal unions goes through
 * narrowing guards instead of casts.
 */

import type { ClassifierRule, EmailCategory, MessageOverrideAction } from '@renkei/email-sanitizer';

export function isEmailCategory(value: string): value is EmailCategory {
  return value === 'human' || value === 'system_notification' || value === 'marketing';
}

export function isClassifierMatchType(value: string): value is ClassifierRule['matchType'] {
  return (
    value === 'domain' ||
    value === 'sender_email' ||
    value === 'subject_contains' ||
    value === 'sender_domain' ||
    value === 'reply_to_domain' ||
    value === 'message_id_contains'
  );
}

export function isMessageOverrideAction(value: string): value is MessageOverrideAction {
  return value === 'exclude' || value === 'reclassify';
}
