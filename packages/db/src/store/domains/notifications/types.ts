/** One entry in a person's notification feed. */
export interface NotificationRecord {
  id: string;
  subject: string;
  kind: string;
  category: string | null;
  connector: string | null;
  tool: string | null;
  entity: string | null;
  headline: string;
  refUrl: string | null;
  agentId: string | null;
  agentName: string | null;
  runId: string | null;
  meta: unknown;
  readAt: Date | null;
  createdAt: Date;
}

/** Which of a person's notifications a bulk change reaches. */
export type NotificationTarget = { ids: string[] } | { all: true };

export interface NotificationStore {
  /**
   * One person's feed, newest first (ties by id). `since` and `before` are
   * exclusive bounds on `createdAt`.
   */
  list(
    subject: string,
    options: { limit: number; since?: Date; before?: Date; unreadOnly?: boolean }
  ): Promise<NotificationRecord[]>;
  countUnread(subject: string): Promise<number>;
  /**
   * Mark the target read (or, `unread: true`, unread again), touching only
   * rows not already in that state; returns how many changed. Ids that are
   * not this person's change nothing.
   */
  mark(subject: string, target: NotificationTarget, options: { unread: boolean }): Promise<number>;
  /** Delete the target; returns how many went. Ids that are not this person's delete nothing. */
  delete(subject: string, target: NotificationTarget): Promise<number>;
  /**
   * Add one. `createdAt` defaults to now, `readAt` to unread. The writers
   * that produce notifications (agents, batch jobs, chat events) still use
   * the table directly; this is what fixtures and the contract use.
   */
  insert(
    notification: Omit<NotificationRecord, 'createdAt' | 'readAt'> & {
      createdAt?: Date;
      readAt?: Date | null;
    }
  ): Promise<void>;
}
