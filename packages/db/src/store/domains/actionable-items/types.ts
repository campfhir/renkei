/** One card on the actionable-item feed, as the feed and its routes read it. */
export interface ActionableItemRecord {
  id: string;
  source: string;
  kind: string;
  status: string;
  title: string;
  summary: string;
  /** Parsed JSON, unread. */
  evidence: unknown;
  result: unknown;
  suggestedAction: unknown;
  runId: string | null;
  /** The agent that raised it (`created_by_agent_id`), and that agent's name while it exists. */
  agentId: string | null;
  agentName: string | null;
  ownerSubject: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  archivedAt: Date | null;
}

/**
 * The curated-card feed. "Visible to a subject" is one rule everywhere:
 * a card with no owner is tenant-wide, an owned card only its owner's.
 * Ids arrive from URLs; a malformed one is refused (22P02), as Postgres does.
 */
export interface ActionableItemStore {
  /**
   * The cards a subject can see, newest first (ties by id), `offset` then
   * `limit`. Archived cards only with `includeArchived`.
   */
  listVisible(
    subject: string,
    options: { limit: number; offset?: number; includeArchived: boolean }
  ): Promise<ActionableItemRecord[]>;
  /** One card, when the subject can see it. */
  findVisible(subject: string, id: string): Promise<ActionableItemRecord | null>;
  /** Archive a card (any status) as `by`, now. */
  archive(id: string, by: string): Promise<void>;
  /** Clear a visible card's archive; returns how many rows changed (0: not visible). */
  unarchive(subject: string, id: string): Promise<number>;
  /**
   * Record a decision on a still-`suggested` card: `dismissed` (which also
   * archives it, as `by`) or `approved`. Returns how many rows changed — 0
   * when the card was no longer suggested.
   */
  decide(id: string, by: string, decision: 'dismissed' | 'approved'): Promise<number>;
  /** After an approved card ran: its final status and outcome. */
  recordOutcome(id: string, status: string, result: unknown): Promise<void>;
}
