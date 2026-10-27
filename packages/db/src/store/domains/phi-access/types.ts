/** One row of the PHI access trail (migration 141): identifiers and hashes, never content. */
export interface PhiAccessEventRecord {
  id: string;
  subject: string;
  agentId: string | null;
  runId: string | null;
  connector: string;
  instanceId: string | null;
  action: string;
  toolName: string;
  channelId: string | null;
  messageId: string | null;
  documentId: string | null;
  pathHash: string | null;
  createdAt: Date;
}

export type NewPhiAccessEvent = Omit<PhiAccessEventRecord, 'id' | 'createdAt'>;

/** The append-only PHI access trail (`phi_access_events`; a trigger refuses UPDATE and DELETE). */
export interface PhiAccessStore {
  record(event: NewPhiAccessEvent): Promise<void>;
  /**
   * Newest first (ties by id, descending), at most `limit`; `subject`
   * narrows to one person, `before` to rows created strictly before it.
   */
  list(options: {
    subject?: string;
    limit: number;
    before?: Date;
  }): Promise<PhiAccessEventRecord[]>;
}
