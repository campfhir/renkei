/**
 * The webex/attachmentActions.created handler — forward-to-Renkei (use case
 * #3): someone pressed "Push to Renkei" on the bot's card, from inside the
 * WebEx client.
 *
 * The webhook payload names only the action id. Everything acted on — the
 * submitted inputs, the actor, the room — is re-fetched from the WebEx API,
 * so nothing rides in on the delivery itself. A push is deliberate: the
 * message is captured whether or not the classifier has an opinion.
 */

import { parsePushAction } from '@renkei/connector-webex';
import { getPublicBaseUrl } from '@renkei/settings';
import type { ClaimedEvent } from '../queue';
import type { EventHandler } from '../handlers';
import { captureMessage } from './webex-capture';
import { resolveWebexContext, type WebexTenantContext } from './webex-context';

export interface WebexActionHandlerDeps {
  resolveContext?: (tenantId: string) => Promise<WebexTenantContext>;
}

function payloadActionId(event: ClaimedEvent): string | null {
  const payload: unknown = event.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const record: Record<string, unknown> = { ...payload };
  const id = record.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export function createWebexAttachmentActionHandler(
  deps: WebexActionHandlerDeps = {}
): EventHandler {
  const resolveContext = deps.resolveContext ?? resolveWebexContext;

  return async (event) => {
    const actionId = payloadActionId(event);
    if (!actionId) {
      throw new Error('webex attachment-action payload has no action id');
    }

    const context = await resolveContext(event.tenant_id);

    const actionResult = await context.client.getAttachmentAction(actionId);
    if (!actionResult.ok) {
      throw new Error(`could not fetch WebEx attachment action ${actionId}`);
    }
    const action = actionResult.val;

    const push = parsePushAction(action.inputs);
    // A button from some other card of ours (or a malformed submit) is not an
    // error — it is simply not this handler's work.
    if (!push) return;

    const messageResult = await context.client.getMessage(push.messageId);
    if (!messageResult.ok) {
      throw new Error(`could not fetch pushed WebEx message ${push.messageId}`);
    }
    const message = messageResult.val;

    // The card's routing data is authored by us but travels through clients;
    // the fetched action's room is the authority on where the press happened,
    // and a mismatch means the routing cannot be trusted.
    if (action.roomId && action.roomId !== message.roomId) {
      console.warn(
        `[worker] push action ${actionId} room mismatch (action ${action.roomId}, message ${message.roomId}); ignoring`
      );
      return;
    }

    // Who pushed: resolved from the action's person, live.
    let pushedBy: string | null = null;
    if (action.personId) {
      const person = await context.client.getPerson(action.personId);
      if (person.ok) pushedBy = person.val.emails[0] ?? null;
    }

    const outcome = await captureMessage({
      tenantId: event.tenant_id,
      message,
      client: context.client,
      pushedBy,
      note: push.note,
      force: true,
    });

    const feed = await getPublicBaseUrl();
    const feedUrl = feed.ok && feed.val ? `${feed.val}/tenant/${event.tenant_id}/cards` : null;
    const confirmation =
      outcome === 'duplicate'
        ? 'Already captured in Renkei.'
        : feedUrl
          ? `Captured in Renkei — review and act on it in [your card feed](${feedUrl}).`
          : 'Captured in Renkei — review and act on it in your card feed.';

    const posted = await context.client.postMessage({
      roomId: message.roomId,
      parentId: push.replyTo ?? message.parentId ?? message.id,
      markdown: confirmation,
    });
    if (!posted.ok) {
      console.warn(`[worker] could not post push confirmation for action ${actionId}`);
    }
  };
}
