import type { ClassificationEntryRecord, OwnClassificationRecord } from './types';

export function ownRowFromRow(row: {
  ref_id: string;
  provider: string;
  account_id: string | null;
  category: string;
  sender_key: string | null;
  needs_review: boolean;
  match_score: number | null;
  excerpt: string;
  override_action: string | null;
  created_at: Date | string;
}): OwnClassificationRecord {
  return {
    refId: row.ref_id,
    provider: row.provider,
    accountId: row.account_id,
    category: row.category,
    senderKey: row.sender_key,
    needsReview: row.needs_review,
    matchScore: row.match_score,
    excerpt: row.excerpt,
    overrideAction: row.override_action,
    createdAt: new Date(row.created_at),
  };
}

/** The outcome columns a re-classification replaces. */
export function outcomeValues(entry: ClassificationEntryRecord) {
  return {
    category: entry.category,
    matched_rule_id: entry.matchedRuleId,
    sender_key: entry.senderKey,
    template_id: entry.templateId,
    template_version: entry.templateVersion,
    match_score: entry.matchScore,
    content_hash: entry.contentHash,
    needs_review: entry.needsReview,
    excerpt: entry.excerpt,
  };
}

export const OWN_ROW_COLUMNS = [
  'ref_id',
  'provider',
  'account_id',
  'category',
  'sender_key',
  'needs_review',
  'match_score',
  'excerpt',
  'override_action',
  'created_at',
] as const;

export const DAY_MS = 24 * 60 * 60 * 1000;
