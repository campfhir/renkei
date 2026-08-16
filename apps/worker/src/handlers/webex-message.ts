/**
 * The webex/messages.created handler — the ambient half of use case #1.
 *
 * The webhook carried only the message id; here the message is fetched with
 * the bot credential. Every message gets a reply of some kind:
 *
 *  - Sender has no Renkei account (no row in identities for their email):
 *    a registration nudge with the tenant's base URL, and nothing else —
 *    there is no identity to capture on behalf of yet.
 *  - Sender has an account: the message is captured (see webex-capture.ts) —
 *    indexed into knowledge, and, when it reads as an issue report,
 *    recorded as a suggested actionable item. Nothing is executed: items
 *    wait in the card feed for a human (suggest-then-act, the default
 *    posture). If the sender also has their own WebEx connected, a live
 *    search of their rooms looks for the forwarded original (see
 *    webex-forward-context.ts) — a message pasted into this room usually
 *    started life in a different space the bot cannot see.
 *
 * The bot always answers in-thread. A capture gets a confirmation, anything
 * else gets the "Push to Renkei" card so the human can capture what the
 * classifier missed (use case #3 — the interaction stays in the WebEx
 * client). Reply failures are logged, never fatal: the capture is the
 * outcome, the reply is courtesy.
 */

import { buildPushToRenkeiCard, WebexClient } from '@renkei/connector-webex';
import type { ClaimedEvent } from '../queue';
import type { EventHandler } from '../handlers';
import { captureMessage } from './webex-capture';
import { cardsFeedUrl, registrationUrl } from './feed-url';
import {
  findForwardedOrigin as findForwardedOriginDefault,
  type ForwardedOrigin,
} from './webex-forward-context';
import {
  hasLinkedIdentity as hasLinkedIdentityDefault,
  resolveLinkedWebexUserAccess as resolveLinkedWebexUserAccessDefault,
} from './webex-linked-user';
import { fanOutWebexMessage } from './agent-triggers';
import { logger } from '../logger';
import { resolveWebexContext, type WebexTenantContext } from './webex-context';

export interface WebexHandlerDeps {
  /** Injectable for tests; defaults to the DB-config-backed resolver. */
  resolveContext?: (tenantId: string) => Promise<WebexTenantContext>;
  /** Injectable for tests; defaults to the identities-table lookup. */
  hasLinkedIdentity?: typeof hasLinkedIdentityDefault;
  /** Injectable for tests; defaults to the provider-grants lookup. */
  resolveLinkedWebexUserAccess?: typeof resolveLinkedWebexUserAccessDefault;
  /** Injectable for tests; defaults to the live cross-room search. */
  findForwardedOrigin?: typeof findForwardedOriginDefault;
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
  const checkLinkedIdentity = deps.hasLinkedIdentity ?? hasLinkedIdentityDefault;
  const resolveUserAccess =
    deps.resolveLinkedWebexUserAccess ?? resolveLinkedWebexUserAccessDefault;
  const findOrigin = deps.findForwardedOrigin ?? findForwardedOriginDefault;

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
    logger.debug(
      'fetched message {messageId} from room {roomId}, sender {personEmail}, {textLength} chars',
      {
        component: 'webex/ingest',
        messageId: message.id,
        roomId: message.roomId,
        personEmail: message.personEmail,
        textLength: message.text?.length ?? 0,
      }
    );

    // The bot's own replies come back as webhook deliveries too; ingesting
    // them would loop.
    if (context.botPersonId && message.personId === context.botPersonId) {
      logger.debug('skipping the bot’s own message {messageId}', {
        component: 'webex/ingest',
        messageId: message.id,
      });
      return;
    }

    const threadRoot = message.parentId ?? message.id;

    // Every message gets a response of some kind, but capturing on behalf of
    // someone with no Renkei account would attribute the item to nobody.
    // personEmail is normally present on real deliveries; when it is not
    // (some system-generated messages), there is no identity to check, so
    // fall through to the ordinary capture flow rather than block on it.
    const linked = message.personEmail
      ? await checkLinkedIdentity(event.tenant_id, message.personEmail)
      : null;
    logger.debug('identity check for {personEmail}: {result}', {
      component: 'webex/ingest',
      messageId: message.id,
      personEmail: message.personEmail,
      result:
        linked === null
          ? 'no personEmail on delivery — not gated'
          : linked
            ? 'linked'
            : 'not linked',
    });
    if (linked === false) {
      const register = await registrationUrl(event.tenant_id);
      const posted = await context.client.postMessage({
        roomId: message.roomId,
        parentId: threadRoot,
        markdown: register
          ? `I don't have a Renkei account on file for you yet. Sign in at ${register} to link ` +
            'one, then send this again and I can help.'
          : "I don't have a Renkei account on file for you yet — ask your admin how to register.",
      });
      if (!posted.ok) {
        logger.warn('could not post registration nudge', {
          component: 'webex/ingest',
          messageId: message.id,
        });
      } else {
        logger.debug('posted registration nudge {postedId} to room {roomId}', {
          component: 'webex/ingest',
          messageId: message.id,
          postedId: posted.val.id,
          roomId: message.roomId,
        });
      }
      return;
    }

    // Agent event triggers: a linked sender's own agents may run on their
    // message. Best-effort and BEFORE capture, so a capture failure never
    // silences a trigger (and vice versa — fan-out swallows its own).
    let agentRunsStarted = 0;
    if (linked === true && message.personEmail && message.text) {
      agentRunsStarted = await fanOutWebexMessage({
        tenantId: event.tenant_id,
        senderEmail: message.personEmail,
        messageId: message.id,
        roomId: message.roomId,
        text: message.text,
      });
    }

    // Best-effort: a forwarded/pasted message usually did not originate in
    // this room. The sender's own WebEx grant, if they have one, can search
    // the rooms they belong to that the bot was never invited to.
    let forwardedOrigin: ForwardedOrigin | null = null;
    if (message.personEmail && message.text) {
      const access = await resolveUserAccess(event.tenant_id, message.personEmail);
      logger.debug('sender’s own webex access: {access}', {
        component: 'webex/ingest',
        messageId: message.id,
        access: access
          ? 'connected — searching for forwarded origin'
          : 'not connected — skipping search',
      });
      if (access) {
        forwardedOrigin = await findOrigin({
          client: new WebexClient(access.accessToken),
          text: message.text,
          excludeRoomId: message.roomId,
        });
        logger.debug('forwarded-origin search result: {result}', {
          component: 'webex/ingest',
          messageId: message.id,
          result: forwardedOrigin
            ? `found in room ${forwardedOrigin.roomId} (${forwardedOrigin.roomTitle ?? 'untitled'})`
            : 'no match',
        });
      }
    }

    const outcome = await captureMessage({
      tenantId: event.tenant_id,
      message,
      force: false,
      forwardedOrigin,
    });
    logger.debug('capture outcome for {messageId}: {outcome}', {
      component: 'webex/ingest',
      messageId: message.id,
      outcome,
    });

    const originNote = forwardedOrigin
      ? `\n\nLooks forwarded — found the original in **${forwardedOrigin.roomTitle ?? 'another space'}**` +
        `${forwardedOrigin.personEmail ? ` from ${forwardedOrigin.personEmail}` : ''}` +
        `${forwardedOrigin.created ? ` (${forwardedOrigin.created})` : ''}.`
      : '';

    if (outcome === 'captured') {
      const feed = await cardsFeedUrl(event.tenant_id);
      const posted = await context.client.postMessage({
        roomId: message.roomId,
        parentId: threadRoot,
        markdown:
          (feed
            ? `Captured in Renkei — review and act on it in [your card feed](${feed}).`
            : 'Captured in Renkei — review and act on it in your card feed.') + originNote,
      });
      if (!posted.ok) {
        logger.warn('could not post capture confirmation', {
          component: 'webex/ingest',
          messageId: message.id,
        });
      } else {
        logger.debug('posted capture confirmation {postedId} to room {roomId}', {
          component: 'webex/ingest',
          messageId: message.id,
          postedId: posted.val.id,
          roomId: message.roomId,
        });
      }
    } else if (outcome === 'skipped' && agentRunsStarted > 0) {
      // An agent took the message; its own thread reply is the response.
      // Asking "want me to capture this?" beside it would be the bot
      // talking over itself.
      logger.debug('{count} agent run(s) handling {messageId} — push card withheld', {
        component: 'webex/ingest',
        messageId: message.id,
        count: agentRunsStarted,
      });
    } else if (outcome === 'skipped') {
      // Not issue-shaped — offer the deliberate push instead of guessing.
      const posted = await context.client.postMessage({
        roomId: message.roomId,
        parentId: threadRoot,
        markdown: `Want me to capture this?${originNote}`,
        attachments: [buildPushToRenkeiCard({ messageId: message.id, replyTo: threadRoot })],
      });
      if (!posted.ok) {
        logger.warn('could not post push card', {
          component: 'webex/ingest',
          messageId: message.id,
        });
      } else {
        logger.debug('posted push card {postedId} to room {roomId}', {
          component: 'webex/ingest',
          messageId: message.id,
          postedId: posted.val.id,
          roomId: message.roomId,
        });
      }
    } else {
      // 'duplicate': the item already exists; a second reply would be noise.
      logger.debug('duplicate capture for {messageId} — no reply sent', {
        component: 'webex/ingest',
        messageId: message.id,
      });
    }
  };
}
