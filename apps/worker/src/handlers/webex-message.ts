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
import { createWebexAccessVerifier, webexRefId } from '@renkei/connector-webex';
import { ingestChunk, resolveEmbeddingProvider, searchKnowledge } from '@renkei/knowledge';
import type { KnowledgeHit } from '@renkei/knowledge';
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

    const text = message.text ?? '';
    const refId = webexRefId(message.roomId, message.id);

    // Knowledge is broader than actionability: every human message with text
    // is indexed (when the org has an embedding provider), so later cards can
    // cite prior discussion. Indexing failures are logged, not retried — a
    // retry here would re-run the whole event and duplicate any card it
    // already produced; a missed chunk is the cheaper loss.
    const embedder = await resolveEmbeddingProvider(event.tenant_id);
    if (embedder && text.trim()) {
      const ingested = await ingestChunk(event.tenant_id, embedder, {
        provider: 'webex',
        refId,
        content: text,
        metadata: {
          roomId: message.roomId,
          personEmail: message.personEmail,
          created: message.created,
        },
      });
      if (!ingested.ok) {
        console.warn(
          `[worker] could not index WebEx message ${message.id} for tenant ${event.tenant_id}`
        );
      }
    }

    const classification = classifyMessage(text);
    if (!classification) return;

    // Enrichment: similar prior chunks, disclosed only after the live ACL
    // gate clears them for the message AUTHOR — the one identity this event
    // carries. (Per-viewer verification at card-display time needs the
    // identity spine; see RENKEI.md open questions.)
    let related: KnowledgeHit[] = [];
    let relatedElided = 0;
    if (embedder && message.personEmail) {
      const searched = await searchKnowledge({
        tenantId: event.tenant_id,
        userEmail: message.personEmail,
        query: text,
        k: 3,
        embedder,
        verifiers: new Map([['webex', createWebexAccessVerifier(context.client)]]),
        excludeRef: { provider: 'webex', refId },
      });
      if (searched.ok) {
        related = searched.val.hits;
        relatedElided = searched.val.elided;
      }
    }

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
          excerpt: text.slice(0, 500),
          related: related.map((hit) => ({
            provider: hit.provider,
            refId: hit.refId,
            excerpt: hit.content.slice(0, 200),
            distance: hit.distance,
          })),
          relatedElided,
        }),
        suggested_action: JSON.stringify(classification.suggestedAction),
      })
      .execute();
  };
}
