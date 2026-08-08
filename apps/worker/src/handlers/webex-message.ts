/**
 * The webex/messages.created handler — the ambient half of use case #1.
 *
 * The webhook carried only the message id; here the message is fetched with
 * the bot credential and captured (see webex-capture.ts): indexed into
 * knowledge, and — when it reads as an issue report — recorded as a
 * suggested actionable item. Nothing is executed: items wait in the card
 * feed for a human (suggest-then-act, the default posture).
 *
 * The bot always answers in-thread, because in a group room it only ever
 * sees messages that deliberately mention it: a capture gets a confirmation,
 * and anything else gets the "Push to Renkei" card so the human can capture
 * what the classifier missed (use case #3 — the interaction stays in the
 * WebEx client). Reply failures are logged, never fatal: the capture is the
 * outcome, the reply is courtesy.
 */

import { buildPushToRenkeiCard } from '@renkei/connector-webex';
import type { ClaimedEvent } from '../queue';
import type { EventHandler } from '../handlers';
import { captureMessage } from './webex-capture';
import { cardsFeedUrl } from './feed-url';
import { logger } from '../logger';
import { resolveWebexContext, type WebexTenantContext } from './webex-context';

export interface WebexHandlerDeps {
  /** Injectable for tests; defaults to the DB-config-backed resolver. */
  resolveContext?: (tenantId: string) => Promise<WebexTenantContext>;
}

function payloadMessageId(event: ClaimedEvent): string | null {
  const payload: unknown = event.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const record: Record<string, unknown> = { ...payload };
  const id = record.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export function createWebexMessageHandler(deps: WebexHandlerDeps = {}): EventHandler {
  const resolveContext = deps.resolveContext ?? resolveWebexContext;

  return async (event) => {
    const messageId = payloadMessageId(event);
    if (!messageId) {
      // A payload without a message id can never succeed; failing it lets the
      // normal retry budget dead-letter it with a recorded reason.
      throw new Error('webex event payload has no message id');
    }

    // Per-tenant: the bot credential comes from the tenant's connector
    // configuration, resolved (and briefly cached) per event.
    const context = await resolveContext(event.tenant_id);

    const messageResult = await context.client.getMessage(messageId);
    if (!messageResult.ok) {
      throw new Error(`could not fetch WebEx message ${messageId}`);
    }
    const message = messageResult.val;

    // The bot's own replies come back as webhook deliveries too; ingesting
    // them would loop.
    if (context.botPersonId && message.personId === context.botPersonId) return;

    const outcome = await captureMessage({
      tenantId: event.tenant_id,
      message,
      client: context.client,
      force: false,
    });

    const threadRoot = message.parentId ?? message.id;
    if (outcome === 'captured') {
      const feed = await cardsFeedUrl(event.tenant_id);
      const posted = await context.client.postMessage({
        roomId: message.roomId,
        parentId: threadRoot,
        markdown: feed
          ? `Captured in Renkei — review and act on it in [your card feed](${feed}).`
          : 'Captured in Renkei — review and act on it in your card feed.',
      });
      if (!posted.ok) {
        logger.warn('could not post capture confirmation', {
          component: 'webex/ingest',
          messageId: message.id,
        });
      }
    } else if (outcome === 'skipped') {
      // Not issue-shaped — offer the deliberate push instead of guessing.
      const posted = await context.client.postMessage({
        roomId: message.roomId,
        parentId: threadRoot,
        markdown: 'Want me to capture this?',
        attachments: [buildPushToRenkeiCard({ messageId: message.id, replyTo: threadRoot })],
      });
      if (!posted.ok) {
        logger.warn('could not post push card', {
          component: 'webex/ingest',
          messageId: message.id,
        });
      }
    }
    // 'duplicate': the item already exists; a second reply would be noise.
  };
}
