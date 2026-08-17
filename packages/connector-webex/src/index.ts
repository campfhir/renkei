/**
 * @renkei/connector-webex — the WebEx connector's ingress surface.
 *
 * Data contract (RENKEI.md, connector contract):
 * 1. Content stored: message text is carried on events, into actionable
 *    items as evidence excerpts, and — for opted-in watchers — into the
 *    knowledge index as `webex` chunks (ref `${roomId}/${messageId}`).
 * 2. Metadata indexed: room id, message id, sender email, timestamps —
 *    whatever the webhook and message fetch return.
 * 3. Retrieval-only: everything else (rooms, membership, history) stays live
 *    behind the API client.
 * 4. Sharing: events and actionable items are tenant-scoped; a card derived
 *    from a message is shown through the web app's session auth. Indexed
 *    messages pass per-user ACL verification before disclosure.
 * 5. verifyAccess: a message's access rule IS its room's membership, asked
 *    live with the requesting user's own token (createWebexUserAccessVerifier).
 *
 * Ingestion is user-scoped — each watcher's own all-spaces webhook and
 * token (there is no bot). The connectors page toggle discloses exactly
 * what is indexed; changing what enters knowledge means changing that copy.
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
  type WebexRoom,
  type WebexAttachmentAction,
  type OutgoingMessage,
  type WebexWebhook,
  type WebhookRegistration,
} from './client';
export {
  USER_SPACES_WEBHOOKS,
  webexUserWebhookTargetUrl,
  inspectWebexWebhooks,
  ensureWebexWebhooks,
  deleteWebexWebhooksFor,
  type WebexWebhooksClient,
  type RequiredWebhook,
  type WebhookHealth,
  type WebhookHealthState,
  type WebhookInspection,
  type WebhookRepair,
  type WebhookRepairAction,
  type WebhookReconciliation,
} from './webhooks-manager';
export { createWebexAccessVerifier, createWebexUserAccessVerifier, webexRefId } from './verifier';
export {
  buildPushToRenkeiCard,
  parsePushAction,
  CARD_COMMAND_PUSH,
  CARD_INPUT_NOTE,
  type CardAttachment,
  type PushCardInput,
  type ParsedPushAction,
} from './cards';
