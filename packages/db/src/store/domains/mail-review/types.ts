/**
 * The email classification log — the one sanitizer table that carries
 * message content (a bounded excerpt). Every read here but the
 * content-free sender counts is scoped by owner; there is no method that
 * lists across owners. `ownerUpn` arrives lower-cased from the caller.
 */
export interface ClassificationEntryRecord {
  id: string;
  provider: string;
  refId: string;
  ownerUpn: string;
  accountId: string | null;
  category: string;
  matchedRuleId: string | null;
  senderKey: string | null;
  templateId: string | null;
  templateVersion: number | null;
  matchScore: number | null;
  contentHash: string | null;
  needsReview: boolean;
  excerpt: string;
}

/** One of an owner's own log rows, as the review page shows it. */
export interface OwnClassificationRecord {
  refId: string;
  provider: string;
  accountId: string | null;
  category: string;
  senderKey: string | null;
  needsReview: boolean;
  matchScore: number | null;
  excerpt: string;
  overrideAction: string | null;
  createdAt: Date;
}

export interface MailReviewStore {
  /**
   * Record one message's classification, keyed by (provider, refId): a
   * re-classification replaces the outcome and touches `updatedAt`, keeping
   * the owner, account and id of the first record.
   */
  record(entry: ClassificationEntryRecord): Promise<void>;
  /**
   * Whether another of this owner's messages with the same content hash,
   * logged within the lookback window, is in the index right now (a
   * knowledge chunk of its provider whose ref id is the message's, or the
   * message's followed by `#…`).
   */
  hasIndexedDuplicate(scope: {
    contentHash: string;
    ownerUpn: string;
    refId: string;
    lookbackDays: number;
  }): Promise<boolean>;
  /** One page of an owner's rows in a category: needs-review first, then newest (ties by id). */
  listForOwner(
    ownerUpn: string,
    category: string,
    page: { limit: number; offset: number }
  ): Promise<OwnClassificationRecord[]>;
  /** How many rows an owner has in each category they have any in, by category. */
  countByCategory(ownerUpn: string): Promise<{ category: string; count: number }[]>;
  /** An owner's row by ref id (by provider, then id, should two providers share one), or null. */
  getOwnRow(ownerUpn: string, refId: string): Promise<OwnClassificationRecord | null>;
  /** Record an owner's correction on their row(s) with this ref id; returns rows changed. */
  setOverride(
    ownerUpn: string,
    refId: string,
    override: { action: string; category: string | null; senderKey: string | null }
  ): Promise<number>;
  /**
   * Content-free: per sender key, how many rows logged within the lookback
   * window are flagged for review — the admin's template health. By sender key.
   */
  needsReviewCounts(lookbackDays: number): Promise<{ senderKey: string; count: number }[]>;
}
