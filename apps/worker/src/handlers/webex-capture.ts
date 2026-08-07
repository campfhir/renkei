/**
 * Turning a WebEx message into knowledge and (maybe) an actionable item —
 * shared by the ambient path (every message the bot can see) and the
 * forward-to-Renkei path (a human pressed "Push to Renkei").
 *
 * The difference between the paths is exactly one bit: ambient capture is
 * gated on the classifier, a push is not — a human saying "this matters"
 * overrides any heuristic, so a pushed message always becomes an item, with
 * a generic drafted action when the classifier has no opinion.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { createWebexAccessVerifier, webexRefId } from '@renkei/connector-webex';
import type { WebexMessage } from '@renkei/connector-webex';
import { ingestChunk, resolveEmbeddingProvider, searchKnowledge } from '@renkei/knowledge';
import type { KnowledgeHit } from '@renkei/knowledge';
import { classifyMessage, type MessageClassification } from '../pipeline/classify';
import type { WebexTenantContext } from './webex-context';

export interface CaptureOptions {
  tenantId: string;
  message: WebexMessage;
  client: WebexTenantContext['client'];
  /** Push metadata: who pressed the button, and their note. */
  pushedBy?: string | null;
  note?: string | null;
  /** True for a push: capture even when the classifier is silent. */
  force: boolean;
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0]?.trim() ?? '';
  return line.length <= 80 ? line : `${line.slice(0, 79)}…`;
}

/** The drafted action for a pushed message the classifier had no opinion on. */
function genericSuggestion(text: string, note: string | null): MessageClassification {
  const headline = firstLine(text) || 'Pushed WebEx message';
  return {
    title: `Pushed from WebEx: ${headline}`,
    summary: text.length <= 280 ? text : `${text.slice(0, 279)}…`,
    suggestedAction: {
      tool: 'create_issue',
      args: {
        summary: headline,
        description:
          `Pushed to Renkei from WebEx:\n\n> ${text.split('\n').join('\n> ')}` +
          (note ? `\n\nPusher's note: ${note}` : ''),
        issueType: 'Task',
      },
    },
  };
}

export type CaptureOutcome = 'captured' | 'duplicate' | 'skipped';

export async function captureMessage(options: CaptureOptions): Promise<CaptureOutcome> {
  const { tenantId, message } = options;
  const text = message.text ?? '';
  const refId = webexRefId(message.roomId, message.id);

  // Knowledge is broader than actionability: index the message whenever the
  // org has an embedding provider. Upsert-idempotent, so re-capture is safe.
  // Failures are logged, not retried — a retry would re-run the whole event
  // and duplicate any card it already produced.
  const embedder = await resolveEmbeddingProvider(tenantId);
  if (embedder && text.trim()) {
    const ingested = await ingestChunk(tenantId, embedder, {
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
      console.warn(`[worker] could not index WebEx message ${message.id} for tenant ${tenantId}`);
    }
  }

  const classification = classifyMessage(text);
  if (!classification && !options.force) return 'skipped';
  const suggestion = classification ?? genericSuggestion(text, options.note ?? null);

  const dbResult = getDatabase();
  if (!dbResult.ok) throw new Error('database unavailable');
  const db = dbResult.val;

  // A pushed button can be pressed twice, and an event can be redelivered;
  // one message never needs two open cards.
  const existing = await db
    .selectFrom('actionable_items')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('source', '=', 'webex')
    .where('status', '=', 'suggested')
    .where(sql<string>`evidence->>'messageId'`, '=', message.id)
    .executeTakeFirst();
  if (existing) return 'duplicate';

  // Enrichment: similar prior chunks, disclosed only after the live ACL gate
  // clears them for the acting identity — the pusher when there is one, the
  // author otherwise. (Per-viewer verification at display time waits on the
  // identity spine; see RENKEI.md open questions.)
  const accessSubject = options.pushedBy ?? message.personEmail;
  let related: KnowledgeHit[] = [];
  let relatedElided = 0;
  if (embedder && accessSubject && text.trim()) {
    const searched = await searchKnowledge({
      tenantId,
      userEmail: accessSubject,
      query: text,
      k: 3,
      embedder,
      verifiers: new Map([['webex', createWebexAccessVerifier(options.client)]]),
      excludeRef: { provider: 'webex', refId },
    });
    if (searched.ok) {
      related = searched.val.hits;
      relatedElided = searched.val.elided;
    }
  }

  await db
    .insertInto('actionable_items')
    .values({
      id: randomUUID(),
      tenant_id: tenantId,
      source: 'webex',
      title: suggestion.title,
      summary: suggestion.summary,
      evidence: JSON.stringify({
        provider: 'webex',
        roomId: message.roomId,
        messageId: message.id,
        personEmail: message.personEmail,
        created: message.created,
        excerpt: text.slice(0, 500),
        ...(options.pushedBy ? { pushedBy: options.pushedBy } : {}),
        ...(options.note ? { note: options.note } : {}),
        related: related.map((hit) => ({
          provider: hit.provider,
          refId: hit.refId,
          excerpt: hit.content.slice(0, 200),
          distance: hit.distance,
        })),
        relatedElided,
      }),
      suggested_action: JSON.stringify(suggestion.suggestedAction),
    })
    .execute();

  return 'captured';
}
