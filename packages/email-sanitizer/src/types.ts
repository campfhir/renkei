/**
 * Shared vocabulary for the email sanitizer pipeline (classify → route →
 * clean/extract/exclude). Everything here is deterministic data — no stage
 * of this pipeline calls a model.
 */

export type EmailCategory = 'human' | 'system_notification' | 'marketing';

/** A connector-agnostic email, already extracted from whatever the source API returned. */
export interface RawEmail {
  subject: string;
  fromName: string;
  fromAddress: string;
  /**
   * The actual authenticated sender (RFC 5322 `Sender`; Graph's `sender`),
   * when the connector can distinguish it from `fromAddress` — the signal
   * that catches an automated notification relayed "on behalf of" a human
   * identity (SharePoint/OneDrive sharing mail is the common case: `from`
   * shows the sharing colleague, `sender` is a Microsoft system account).
   * Equal to `fromAddress` for ordinary person-sent mail.
   */
  senderAddress?: string;
  /** Reply-To, when present — another common system-relay tell (a no-reply address that differs from `fromAddress`). */
  replyToAddress?: string;
  /**
   * The Message-ID header (Graph's `internetMessageId`), when the connector
   * reports one. The strongest available signal for templated system mail
   * that impersonates a real person in `from`/`sender`/`reply-to` alike —
   * SharePoint/OneDrive "shared with you" notifications show the sharing
   * colleague everywhere in the visible headers (Reply-To included), but
   * their Message-ID always carries a fixed system tag
   * (`...@odspnotify`) no human-composed message ever has.
   */
  messageId?: string;
  /** ISO-ish timestamp string, displayed verbatim — never parsed. */
  receivedAt: string;
  body: { content: string; contentType: 'html' | 'text' };
}

export type ClassifierMatchType =
  | 'domain'
  | 'sender_email'
  | 'sender_email_contains'
  | 'subject_contains'
  | 'sender_domain'
  | 'reply_to_domain'
  | 'message_id_contains';

/**
 * Content-free sender policy: which category a domain/address/subject/
 * actual-sender pattern maps to. Safe for an org-admin to manage directly —
 * matching a rule never requires looking at message content.
 */
export interface ClassifierRule {
  id: string;
  category: EmailCategory;
  matchType: ClassifierMatchType;
  matchValue: string;
  /** Names the extraction-template family for 'system_notification' rules. */
  senderKey: string | null;
  priority: number;
  enabled: boolean;
}

export interface Classification {
  category: EmailCategory;
  matchedRuleId: string | null;
  senderKey: string | null;
}

/**
 * One piece of a sender's notification template: either fixed wrapper text
 * (must appear, in order, for the template to match) or a variable span
 * whose value is captured between the literals on either side of it.
 */
export type TemplateSegment =
  { type: 'literal'; text: string } | { type: 'field'; name: string; pattern?: string };

/**
 * A versioned extraction template for one system-of-record sender. Contains
 * no message content — `segments` is boilerplate text plus field names,
 * never a captured value — so it's safe to store and list anywhere,
 * including the admin surface.
 */
export interface ExtractionTemplate {
  id: string;
  senderKey: string;
  version: number;
  status: 'active' | 'superseded';
  segments: TemplateSegment[];
  matchThreshold: number;
}

export interface TemplateMatch {
  fields: Record<string, string>;
  /** Fraction of literal segments found, in order — 1.0 is a perfect match. */
  score: number;
}

/**
 * 'raw' (bypass cleaning entirely) deliberately does not exist here: automatic
 * classification is the trusted default, and manual intervention exists only
 * to correct it when it's wrong — 'reclassify' re-runs the message through
 * the normal pipeline for the corrected category, it never skips cleaning.
 */
export type MessageOverrideAction = 'exclude' | 'reclassify';

/** An owner's explicit correction for one message, applied instead of automatic classification. */
export interface MessageOverride {
  action: MessageOverrideAction;
  /** Only meaningful for 'reclassify'. */
  category?: EmailCategory;
  senderKey?: string;
}

interface SanitizeResultBase {
  category: EmailCategory;
  matchedRuleId: string | null;
  senderKey: string | null;
  /** True when this message needs its owner's attention (no/drifted template). */
  needsReview: boolean;
}

export type SanitizeResult =
  | (SanitizeResultBase & {
      action: 'index';
      content: string;
      templateId: string | null;
      templateVersion: number | null;
      matchScore: number | null;
    })
  | (SanitizeResultBase & {
      action: 'excluded';
      reason: 'marketing' | 'duplicate' | 'override';
    });
