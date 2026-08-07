/**
 * @renkei/connector-webex — the WebEx connector's ingress surface.
 *
 * Data contract (RENKEI.md, connector contract):
 * 1. Content stored: message text is carried on events and into actionable
 *    items as evidence excerpts; nothing else is persisted by this package.
 * 2. Metadata indexed: room id, message id, sender email, timestamps —
 *    whatever the webhook and message fetch return, stored on the event row.
 * 3. Retrieval-only: everything else (rooms, membership, history) stays live
 *    behind the API client.
 * 4. Sharing: events and actionable items are tenant-scoped; a card derived
 *    from a message is shown through the web app's session auth. Per-user
 *    ACL verification (verifyAccess) arrives with the knowledge layer —
 *    nothing from this connector enters semantic retrieval yet.
 * 5. verifyAccess: not applicable until this connector indexes content.
 *
 * Ingestion is bot-scoped (org-level service account), the sanctioned
 * fallback for org-level ingestion in RENKEI.md's auth posture: the bot only
 * ever sees rooms it was explicitly added to.
 */

/** The connector key used in connector_configs, capability descriptors, and event rows. */
export const WEBEX_CONNECTOR = 'webex';

export {
  verifyWebexSignature,
  parseWebhookPayload,
  WEBEX_MESSAGE_CREATED,
  type WebexWebhookEvent,
} from './webhook';
export {
  WebexClient,
  type WebexMessage,
  type WebexPerson,
  type WebexAttachmentAction,
  type OutgoingMessage,
  type WebexWebhook,
  type WebhookRegistration,
} from './client';
export {
  REQUIRED_WEBEX_WEBHOOKS,
  webexWebhookTargetUrl,
  inspectWebexWebhooks,
  ensureWebexWebhooks,
  type WebexWebhooksClient,
  type RequiredWebhook,
  type WebhookHealth,
  type WebhookHealthState,
  type WebhookInspection,
  type WebhookRepair,
  type WebhookRepairAction,
  type WebhookReconciliation,
} from './webhooks-manager';
export { createWebexAccessVerifier, webexRefId } from './verifier';
export {
  buildPushToRenkeiCard,
  parsePushAction,
  CARD_COMMAND_PUSH,
  CARD_INPUT_NOTE,
  type CardAttachment,
  type PushCardInput,
  type ParsedPushAction,
} from './cards';
