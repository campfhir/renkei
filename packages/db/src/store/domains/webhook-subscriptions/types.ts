/**
 * A webhook Renkei created at a provider for one connected account
 * (webhook_subscriptions): a Graph change-notification subscription and
 * the clientState its deliveries must carry back. The sync workers keep
 * these rows; the web app reads them to admit deliveries and drops them
 * on disconnect.
 */
export interface WebhookSubscriptionRecord {
  id: string;
  provider: string;
  accountId: string;
  resource: string;
  /** The provider's id for the subscription; null until it has been created there. */
  subscriptionId: string | null;
  clientState: string;
}

export interface WebhookSubscriptionStore {
  /** One account's subscriptions on a provider, by resource then id. */
  listForAccount(provider: string, accountId: string): Promise<WebhookSubscriptionRecord[]>;
  /** Drop every subscription of one account on a provider; returns how many went. */
  deleteForAccount(provider: string, accountId: string): Promise<number>;
  /**
   * Insert a subscription row unless (provider, account, resource) already
   * has one; true when it was inserted. Not yet created at the provider.
   */
  insertIfMissing(row: WebhookSubscriptionNew): Promise<boolean>;
  /** One account's subscriptions as the sync engine works them, by resource then id. */
  listSyncStates(provider: string, accountId: string): Promise<WebhookSubscriptionSyncRecord[]>;
  /** The account's row the provider's subscription id names, or null. */
  findSyncStateBySubscriptionId(
    provider: string,
    accountId: string,
    subscriptionId: string
  ): Promise<WebhookSubscriptionSyncRecord | null>;
  /**
   * Record what the provider says about one row's subscription — its id
   * and/or expiry (null clears) — touching `updated_at`. Absent fields stay.
   */
  setProviderSubscription(id: string, patch: WebhookSubscriptionProviderPatch): Promise<void>;
  /** The same, on every row of `provider` carrying `subscriptionId`; returns how many changed. */
  setProviderSubscriptionBySubscriptionId(
    provider: string,
    subscriptionId: string,
    patch: WebhookSubscriptionProviderPatch
  ): Promise<number>;
  /** Drop the row's delta cursor so the next round opens a fresh series; status 'syncing'. */
  restartDelta(id: string): Promise<void>;
  /**
   * A finished delta round: the new cursor, `changed` as this run's count
   * and added to the running total, the sync status, synced now.
   */
  recordDeltaRound(
    id: string,
    round: { cursor: string | null; changed: number; syncStatus: string }
  ): Promise<void>;
}

/** A new subscription row: the clientState its deliveries must carry back. */
export interface WebhookSubscriptionNew {
  id: string;
  provider: string;
  accountId: string;
  resource: string;
  clientState: string;
}

/** A subscription row as the sync engine reads it: provider state plus the delta cursor. */
export interface WebhookSubscriptionSyncRecord {
  id: string;
  resource: string;
  subscriptionId: string | null;
  clientState: string;
  expiresAt: Date | null;
  /** A deltaLink, or the nextLink of a round the page cap cut short; null opens a new series. */
  deltaLink: string | null;
  syncStatus: string;
  lastSyncedAt: Date | null;
  lastRunItems: number;
  totalItems: number;
}

export interface WebhookSubscriptionProviderPatch {
  subscriptionId?: string | null;
  expiresAt?: Date | null;
}
