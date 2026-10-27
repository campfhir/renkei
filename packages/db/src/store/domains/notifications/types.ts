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

/** One device's push subscription (push_subscriptions), as the push service needs it. */
export interface NotificationPushSubscriptionRecord {
  endpoint: string;
  p256dh: string;
  auth: string;
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
   * Add one. `createdAt` defaults to now, `readAt` to unread. `refId`
   * keys a row to what it is about (a chat permission ask's tool call) so
   * `markReadByRef` can find it again.
   */
  insert(
    notification: Omit<NotificationRecord, 'createdAt' | 'readAt'> & {
      createdAt?: Date;
      readAt?: Date | null;
      refId?: string | null;
    }
  ): Promise<void>;
  /** Mark this person's unread rows of `kind` keyed to `refId` read; returns how many changed. */
  markReadByRef(subject: string, kind: string, refId: string): Promise<number>;
  /** One of this person's notifications; null when it is not theirs or does not exist. */
  find(subject: string, id: string): Promise<NotificationRecord | null>;

  /**
   * Record a device's push subscription. Idempotent on the endpoint: a
   * repeat re-points it at `subject` and its keys rather than adding a row.
   */
  savePushSubscription(
    subject: string,
    subscription: NotificationPushSubscriptionRecord
  ): Promise<void>;
  /** Drop one of this person's subscriptions; returns how many went (an endpoint of someone else's: 0). */
  deletePushSubscription(subject: string, endpoint: string): Promise<number>;
  /** Drop a subscription whoever holds it (the push service said it is gone); returns how many went. */
  deletePushSubscriptionByEndpoint(endpoint: string): Promise<number>;
  /** Every device this person subscribed from, oldest first (ties by endpoint). */
  listPushSubscriptions(subject: string): Promise<NotificationPushSubscriptionRecord[]>;

  /**
   * Chat presence (chat_presence): `subject` is watching `chatId`'s turn
   * stream as of `at`. One row per (subject, chat), moved forward on repeat.
   */
  pingChatPresence(subject: string, chatId: string, at: Date): Promise<void>;
  /** Whether `subject` pinged `chatId` after `since` (exclusive). */
  wasWatchingChat(subject: string, chatId: string, since: Date): Promise<boolean>;
  /** Drop presence rows last pinged before `before`; returns how many went. */
  deleteChatPresenceBefore(before: Date): Promise<number>;
}
