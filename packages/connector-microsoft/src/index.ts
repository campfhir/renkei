/**
 * @renkei/connector-microsoft — the Microsoft Graph connector's ingress
 * surface: mail (inbox), calendar, and To Do tasks, per-user.
 *
 * Data contract (RENKEI.md, connector contract):
 * 1. Content stored: message/event/task content flows through delta rounds
 *    into the knowledge index; this package itself persists nothing.
 * 2. Metadata indexed: the owner's UPN is baked into every refId — that is
 *    the entire ACL story (see verifier.ts).
 * 3. Retrieval-only: everything else stays live behind graphRequest.
 * 4. Sharing: items are indexed only into their OWNER's view; nothing here
 *    ever crosses users.
 * 5. verifyAccess: pure ownership check over the refId scheme — the item was
 *    fetched with the owner's own delegated grant, so ownership is exactly
 *    Graph's own access rule for these resources.
 *
 * Ingestion is delegated-token scoped (each user's own OAuth grant via
 * @renkei/provider-grants' MicrosoftAdapter) — there is no org credential,
 * so the connector can never index more than each user can see.
 */

/** The connector key used in connector_configs, capability descriptors, and event rows. */
export const MICROSOFT_CONNECTOR = 'microsoft';

export { GRAPH_BASE_URL, graphRequest } from './client';
export {
  microsoftRefId,
  ownerOfMicrosoftRefId,
  objectIdOfMicrosoftRefId,
  type MicrosoftRefKind,
} from './refs';
export { createMicrosoftAccessVerifier } from './verifier';
export {
  GRAPH_SUBSCRIPTION_MINUTES,
  createGraphSubscription,
  renewGraphSubscription,
  deleteGraphSubscription,
  listGraphSubscriptions,
  type CreateSubscriptionOptions,
  type GraphSubscription,
} from './subscriptions';
export { initialDeltaUrl, runDeltaRound, type DeltaKind, type InitialDeltaOptions } from './delta';
