/**
 * The webex/messages.created handler — pipeline v1 for use case #1.
 *
 * The webhook carried only the message id; here the message is fetched with
 * the bot credential, classified, and — when it reads as an issue report —
 * recorded as a suggested actionable item. Nothing is executed: the item
 * waits in the card feed for a human to approve, edit, or dismiss
 * (suggest-then-act, the default posture).
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@renkei/db';
import type { ClaimedEvent } from '../queue';
import type { EventHandler } from '../handlers';
import { classifyMessage } from '../pipeline/classify';
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

    const classification = classifyMessage(message.text ?? '');
    if (!classification) return;

    const dbResult = getDatabase();
    if (!dbResult.ok) throw new Error('database unavailable');

    await dbResult.val
      .insertInto('actionable_items')
      .values({
        id: randomUUID(),
        tenant_id: event.tenant_id,
        source: 'webex',
        title: classification.title,
        summary: classification.summary,
        evidence: JSON.stringify({
          provider: 'webex',
          roomId: message.roomId,
          messageId: message.id,
          personEmail: message.personEmail,
          created: message.created,
          excerpt: (message.text ?? '').slice(0, 500),
        }),
        suggested_action: JSON.stringify(classification.suggestedAction),
      })
      .execute();
  };
}
