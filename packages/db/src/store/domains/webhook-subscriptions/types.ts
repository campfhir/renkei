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
  /** Every subscription on a provider, whoever's, by account, then resource, then id. */
  listForProvider(provider: string): Promise<WebhookSubscriptionRecord[]>;
  /** Drop one subscription row; returns how many went (0 or 1). */
  delete(id: string): Promise<number>;
  /**
   * One account's subscriptions on a provider whose row has not been
   * updated since `updatedBefore` — notifications have gone quiet — with
   * what a catch-up sync needs, by resource then id.
   */
  listStale(
    provider: string,
    accountId: string,
    updatedBefore: Date
  ): Promise<WebhookSubscriptionSyncRecord[]>;
}

/** A subscription as a catch-up delta round reads it. */
export interface WebhookSubscriptionSyncRecord {
  id: string;
  resource: string;
  subscriptionId: string | null;
  clientState: string;
  expiresAt: Date | null;
  deltaLink: string | null;
}
