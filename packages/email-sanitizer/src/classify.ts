/**
 * Rule-based classification: which category a message's sender/subject maps
 * to. Rules are evaluated in ascending `priority`; the first enabled match
 * wins. A message that matches nothing is `human` — the fail-safe default,
 * so an unrecognized sender is never dropped or mishandled, only cleaned
 * generically.
 *
 * `sender_email_contains` is the workhorse for automated senders: the
 * local part carries the signal (`no-reply@`, `notifications@`) far more
 * reliably than the domain does, since one domain sends both machine mail
 * and real correspondence — `github.com` sends `noreply@` notifications
 * and person-to-person mail alike, so a `domain` rule would misfile both.
 *
 * `sender_domain`/`reply_to_domain` exist for a real structural pattern:
 * automated notifications relayed "on behalf of" a human identity — Graph's
 * `sender` (RFC 5322 Sender) differs from `from` when e.g. SharePoint/OneDrive
 * sends a sharing notification that displays as coming from the sharing
 * colleague but is actually sent by a Microsoft system account, sometimes
 * also visible as a mismatched Reply-To. Matching `domain`/`sender_email`
 * against `from` can never catch this — the visible From address IS a real
 * colleague's address. These two match types look at the connector-reported
 * actual-sender/reply-to instead, which fall back to `from`'s own domain when
 * the connector reports no distinct value (ordinary person-sent mail), so
 * they never fire spuriously on mail with no relay involved.
 *
 * `message_id_contains` exists because sender/reply-to aren't always enough:
 * real SharePoint/OneDrive "shared with you" mail has been observed with
 * Reply-To set BACK to the sharing colleague's own address (Exchange's
 * "send on behalf of" convenience), so `sender_domain`/`reply_to_domain` both
 * see only the real person — nothing in the visible envelope distinguishes
 * it from actual correspondence. The Message-ID does: these notifications
 * carry a fixed system tag (`...@odspnotify`) no human-composed message
 * would ever have. This is the fallback of last resort for exactly that
 * "every visible header looks human" case.
 */

import type { ClassifierRule, Classification } from './types';

function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1).toLowerCase();
}

export interface ClassifiableEmail {
  fromAddress: string;
  subject: string;
  /** The actual authenticated sender, when the connector can tell it apart from `fromAddress`. */
  senderAddress?: string;
  /** Reply-To, when the connector reports one. */
  replyToAddress?: string;
  /** The Message-ID header, when the connector reports one. */
  messageId?: string;
}

export function classify(
  rules: readonly ClassifierRule[],
  email: ClassifiableEmail
): Classification {
  const fromAddress = email.fromAddress.trim().toLowerCase();
  const domain = domainOf(fromAddress);
  const senderDomain = email.senderAddress ? domainOf(email.senderAddress.trim()) : domain;
  const replyToDomain = email.replyToAddress ? domainOf(email.replyToAddress.trim()) : domain;
  const messageId = (email.messageId ?? '').toLowerCase();
  const subject = email.subject.toLowerCase();

  const ordered = rules.filter((rule) => rule.enabled).sort((a, b) => a.priority - b.priority);

  for (const rule of ordered) {
    const value = rule.matchValue.trim().toLowerCase();
    if (!value) continue;
    const matches =
      rule.matchType === 'domain'
        ? domain === value
        : rule.matchType === 'sender_email'
          ? fromAddress === value
          : rule.matchType === 'sender_email_contains'
            ? fromAddress.includes(value)
            : rule.matchType === 'sender_domain'
              ? senderDomain === value
              : rule.matchType === 'reply_to_domain'
                ? replyToDomain === value
                : rule.matchType === 'message_id_contains'
                  ? messageId.includes(value)
                  : subject.includes(value);
    if (matches) {
      return { category: rule.category, matchedRuleId: rule.id, senderKey: rule.senderKey };
    }
  }

  return { category: 'human', matchedRuleId: null, senderKey: null };
}
