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
import { logger } from '../logger';
import { webexRefId } from '@renkei/connector-webex';
import type { WebexMessage } from '@renkei/connector-webex';
import { resolveEmbeddingProvider } from '@renkei/knowledge';
import { enqueueKnowledgeEvent } from '../enqueue';
import { classifyMessage, type MessageClassification } from '../pipeline/classify';
import type { ForwardedOrigin } from './webex-forward-context';

export interface CaptureOptions {
  tenantId: string;
  message: WebexMessage;
  /** Push metadata: who pressed the button, and their note. */
  pushedBy?: string | null;
  note?: string | null;
  /** True for a push: capture even when the classifier is silent. */
  force: boolean;
  /** Where this message's content was found to originate, if it was forwarded. */
  forwardedOrigin?: ForwardedOrigin | null;
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
      tool: 'jira_create_issue',
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
  // org has an embedding provider. Indexing is deferred to the embedding
  // queue (Decision #20) — the resolve here is a cheap DB-config check that
  // gates whether there is any point enqueuing; the network-bound embed
  // happens in the embedding worker, never on the reply path.
  const embedder = await resolveEmbeddingProvider(tenantId);
  logger.debug('embedding provider for {tenantId}: {status}', {
    component: 'webex/capture',
    tenantId,
    status: embedder ? 'configured' : 'none — indexing and related-item search skipped',
  });
  if (embedder && text.trim()) {
    // Ordering key: this message's own sequence — its enrich.item below
    // shares the key, so the related-items search always runs against an
    // index that already contains the message, however many embedding
    // workers are draining the queue.
    await enqueueKnowledgeEvent(
      tenantId,
      'ingest.object',
      {
        provider: 'webex',
        refId,
        content: text,
        metadata: {
          roomId: message.roomId,
          personEmail: message.personEmail,
          created: message.created,
        },
        sourceAt: message.created || null,
      },
      `webex/${refId}`
    );
  }

  const classification = classifyMessage(text);
  logger.debug('classifier result for {messageId}: {result}', {
    component: 'webex/capture',
    messageId: message.id,
    result: classification
      ? `"${classification.title}"`
      : options.force
        ? 'no opinion, forced (pushed)'
        : 'no opinion — not issue-shaped, offering push card instead',
  });
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
  if (existing) {
    logger.debug('actionable item {itemId} already exists for {messageId}', {
      component: 'webex/capture',
      messageId: message.id,
      itemId: existing.id,
    });
    return 'duplicate';
  }

  const itemId = randomUUID();
  await db
    .insertInto('actionable_items')
    .values({
      id: itemId,
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
        ...(options.forwardedOrigin ? { forwardedOrigin: options.forwardedOrigin } : {}),
        // Enrichment is asynchronous (Decision #20): the card ships now,
        // empty, and the embedding queue's enrich.item back-fills these two
        // keys once the index has caught up. The search's ACL gate runs
        // there, against the same acting identity recorded below.
        related: [],
        relatedElided: 0,
      }),
      suggested_action: JSON.stringify(suggestion.suggestedAction),
    })
    .execute();
  logger.debug('inserted actionable item {itemId} for {messageId}', {
    component: 'webex/capture',
    messageId: message.id,
    itemId,
  });

  // Similar prior chunks, disclosed only after the live ACL gate clears
  // them for the acting identity — the pusher when there is one, the author
  // otherwise. (Per-viewer verification at display time waits on the
  // identity spine; see RENKEI.md open questions.) Shares the ingest's
  // ordering key, so it runs strictly after the message is indexed.
  const accessSubject = options.pushedBy ?? message.personEmail;
  if (embedder && accessSubject && text.trim()) {
    await enqueueKnowledgeEvent(
      tenantId,
      'enrich.item',
      {
        itemId,
        provider: 'webex',
        refId,
        query: text,
        accessSubject,
      },
      `webex/${refId}`
    );
  }

  return 'captured';
}
