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
}
