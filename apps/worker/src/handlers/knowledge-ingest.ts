/**
 * The embedding queue's handlers (Decision #20) — every network call to the
 * org-configured embeddings endpoint the platform makes at ingest time
 * happens here, in the embedding worker process, and nowhere else.
 *
 * Payload shapes are documented in enqueue.ts, the producer side.
 *
 * Failure policy inverts the old inline convention on purpose. Inline,
 * webex-capture logged-and-continued on embed failure because a throw would
 * re-run the whole interactive event and duplicate its side effects (posted
 * replies, created cards). Here the interactive side effects already
 * happened in the interactive queue; these jobs own only idempotent index writes
 * (chunk upserts, deletes, a keyed jsonb update), so throwing into the
 * retry/backoff/dead-letter path is finally safe — and an embeddings
 * endpoint outage heals by retry instead of silently dropping documents.
 */

import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import {
  resolveEmbeddingProvider,
  ingestObjectChunks,
  deleteObjectChunks,
  deleteStaleScopeChunks,
  searchKnowledge,
} from '@renkei/knowledge';
import { graphDownload } from '@renkei/connector-microsoft';
import { extractText } from '@renkei/document-text';
import { resolveMicrosoftAccess } from './microsoft-access';
import { sanitizeEmailForTenant } from '@renkei/email-sanitizer';
import type { MessageOverride, RawEmail } from '@renkei/email-sanitizer';
import { createWebexAccessVerifier } from '@renkei/connector-webex';
import type { EventHandler } from '../handlers';
import { resolveWebexContext } from './webex-context';
import { logger } from '../logger';

const COMPONENT = 'knowledge/ingest';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function payloadOf(event: { payload: unknown }): Record<string, unknown> {
  return isRecord(event.payload) ? event.payload : {};
}

function required(payload: Record<string, unknown>, key: string): string {
  const value = str(payload[key]);
  // A malformed payload can only come from our own producer — retrying
  // cannot fix it, but the dead-letter row's last_error will say what broke.
  if (!value) throw new Error(`knowledge event payload is missing '${key}'`);
  return value;
}

function chunkingOf(payload: Record<string, unknown>): { maxChars?: number; overlap?: number } {
  const chunking = isRecord(payload.chunking) ? payload.chunking : {};
  return {
    maxChars: typeof chunking.maxChars === 'number' ? chunking.maxChars : undefined,
    overlap: typeof chunking.overlap === 'number' ? chunking.overlap : undefined,
  };
}

/**
 * Rebuild the RawEmail from the jsonb payload field by field. The payload
 * was written by our own producer from an already-validated Graph item, but
 * jsonb round-trips as `unknown` and the repo (rightly) bans asserting it
 * back — reconstruction keeps the shape honest.
 */
function rawEmailOfPayload(raw: Record<string, unknown>): RawEmail {
  const body = isRecord(raw.body) ? raw.body : {};
  return {
    subject: str(raw.subject),
    fromName: str(raw.fromName),
    fromAddress: str(raw.fromAddress),
    senderAddress: str(raw.senderAddress) || undefined,
    replyToAddress: str(raw.replyToAddress) || undefined,
    messageId: str(raw.messageId) || undefined,
    receivedAt: str(raw.receivedAt),
    body: {
      content: str(body.content),
      contentType: str(body.contentType) === 'html' ? 'html' : 'text',
    },
  };
}

function overrideOfPayload(value: unknown): MessageOverride | undefined {
  if (!isRecord(value)) return undefined;
  const action = str(value.action);
  if (action !== 'exclude' && action !== 'reclassify') return undefined;
  const category = str(value.category);
  return {
    action,
    category:
      category === 'human' || category === 'system_notification' || category === 'marketing'
        ? category
        : undefined,
    senderKey: str(value.senderKey) || undefined,
  };
}

/** `knowledge/ingest.object` — chunk, embed and upsert one source object. */
export function createKnowledgeIngestObjectHandler(): EventHandler {
  return async (event) => {
    const payload = payloadOf(event);
    const provider = required(payload, 'provider');
    const refId = required(payload, 'refId');

    const embedder = await resolveEmbeddingProvider(event.tenant_id);
    if (!embedder) {
      // The provider was configured when this event was enqueued and is gone
      // now — the org turned knowledge off. Never an error (embeddings.ts
      // contract); the index just stops growing.
      logger.info('knowledge layer off; ingest of {refId} dropped', {
        component: COMPONENT,
        tenantId: event.tenant_id,
        refId,
      });
      return;
    }

    const ingested = await ingestObjectChunks(
      event.tenant_id,
      embedder,
      {
        provider,
        refId,
        content: str(payload.content),
        metadata: isRecord(payload.metadata) ? payload.metadata : {},
        sourceAt: str(payload.sourceAt) || null,
      },
      chunkingOf(payload)
    );
    if (!ingested.ok) {
      throw new Error(`could not ingest ${provider}/${refId}: ${ingested.err.type}`);
    }
    logger.debug('ingested {refId} in {chunks} chunk(s)', {
      component: COMPONENT,
      tenantId: event.tenant_id,
      refId,
      chunks: ingested.val.chunks,
    });
  };
}

/**
 * `knowledge/ingest.email` — sanitize (classify, clean, dedup) then ingest
 * one mail message. The sanitizer runs here rather than in the sync handler
 * because its near-duplicate check is itself an embedding call.
 */
export function createKnowledgeIngestEmailHandler(): EventHandler {
  return async (event) => {
    const payload = payloadOf(event);
    const refId = required(payload, 'refId');
    const ownerUpn = required(payload, 'ownerUpn');
    if (!isRecord(payload.raw)) throw new Error("knowledge event payload is missing 'raw'");

    const embedder = await resolveEmbeddingProvider(event.tenant_id);
    if (!embedder) {
      logger.info('knowledge layer off; ingest of {refId} dropped', {
        component: COMPONENT,
        tenantId: event.tenant_id,
        refId,
      });
      return;
    }

    const provider = required(payload, 'provider');
    const override = overrideOfPayload(payload.override);
    const sanitized = await sanitizeEmailForTenant({
      tenantId: event.tenant_id,
      provider,
      refId,
      ownerUpn,
      accountId: str(payload.accountId) || null,
      raw: rawEmailOfPayload(payload.raw),
      override,
      // No embedder alongside an override, on purpose: near-duplicate dedup
      // is for the automatic ingest path only. An override is a deliberate
      // owner correction — silently swallowing it as a "duplicate" of some
      // other message would undermine the very thing they just asked for.
      embedder: override ? undefined : embedder,
    });

    if (sanitized.action === 'excluded') {
      // Marketing, a duplicate, or the owner's own removal — if something
      // was indexed under an earlier classification, drop it.
      const deleted = await deleteObjectChunks(event.tenant_id, provider, refId);
      if (!deleted.ok) throw new Error(`could not delete excluded ${provider}/${refId}`);
      return;
    }

    const ingested = await ingestObjectChunks(
      event.tenant_id,
      embedder,
      {
        provider,
        refId,
        content: sanitized.content,
        metadata: {
          ...(isRecord(payload.metadata) ? payload.metadata : {}),
          senderKey: sanitized.senderKey ?? undefined,
          templateVersion: sanitized.templateVersion ?? undefined,
        },
        sourceAt: str(payload.sourceAt) || null,
      },
      // The near-duplicate check embedded exactly the content being stored;
      // reuse that vector instead of a second identical call.
      sanitized.embedding
        ? { precomputed: { content: sanitized.content, vector: sanitized.embedding } }
        : {}
    );
    if (!ingested.ok) {
      throw new Error(`could not ingest ${provider}/${refId}: ${ingested.err.type}`);
    }
  };
}

/** `knowledge/delete.object` — drop one object's chunks (bare refId + suffixes). */
export function createKnowledgeDeleteObjectHandler(): EventHandler {
  return async (event) => {
    const payload = payloadOf(event);
    const provider = required(payload, 'provider');
    const refId = required(payload, 'refId');
    const deleted = await deleteObjectChunks(event.tenant_id, provider, refId);
    if (!deleted.ok) throw new Error(`could not delete ${provider}/${refId}`);
  };
}

/** `knowledge/purge.prefix` — drop everything under a refId prefix (rebuilds, disconnects). */
export function createKnowledgePurgePrefixHandler(): EventHandler {
  return async (event) => {
    const payload = payloadOf(event);
    const provider = required(payload, 'provider');
    const refIdPrefix = required(payload, 'refIdPrefix');
    const purged = await deleteObjectChunks(event.tenant_id, provider, refIdPrefix, {
      prefixOnly: true,
    });
    if (!purged.ok) throw new Error(`could not purge ${provider}/${refIdPrefix}*`);
  };
}

/**
 * `knowledge/ingest.document` — download a drive document, extract its text,
 * index it.
 *
 * The bytes are fetched HERE rather than carried on the payload: a 20MB file
 * base64'd into jsonb would be TOASTed, replicated and retained in the
 * dead-letter table forever, and downloading inside the sync round would
 * outlive the queue's claim lease on any sizeable library.
 *
 * Failure handling departs from this module's throw-by-default policy, and
 * deliberately. The dead-letter store is for jobs a human can requeue that
 * will then succeed; a password-protected PDF fails identically on attempt
 * 1000. Unindexable files are a permanent, high-volume fact of every
 * SharePoint tenant, and dead-lettering them would bury the genuine
 * embeddings outage the dead-letter table exists to make visible. So
 * permanent outcomes return, transient ones throw.
 */
export function createKnowledgeIngestDocumentHandler(): EventHandler {
  return async (event) => {
    const payload = payloadOf(event);
    const provider = required(payload, 'provider');
    const refId = required(payload, 'refId');
    const driveId = required(payload, 'driveId');
    const itemId = required(payload, 'itemId');
    const accountId = required(payload, 'accountId');
    const tenantId = event.tenant_id;

    const embedder = await resolveEmbeddingProvider(tenantId);
    if (!embedder) return; // knowledge layer off for this org

    const access = await resolveMicrosoftAccess(tenantId, accountId);
    const downloaded = await graphDownload(access.accessToken, driveId, itemId);
    if (!downloaded.ok) {
      const status = downloaded.err.cause;
      if (status === 404) {
        // Deleted between the sync round and now. Tidy up rather than retry.
        await deleteObjectChunks(tenantId, provider, refId);
        return;
      }
      if (status === 403 || downloaded.err.type === 'CONTENT_TOO_LARGE') {
        logger.warn('skipping {refId}: {reason}', {
          component: COMPONENT,
          tenantId,
          refId,
          reason: status === 403 ? 'no longer readable by the indexing account' : 'too large',
        });
        return;
      }
      // Network, 5xx, throttling — retryable.
      throw new Error(`could not download ${refId}: ${downloaded.err.message ?? 'unknown'}`);
    }

    const name = str(payload.name);
    const extracted = await extractText(downloaded.val.bytes, {
      fileName: name,
      contentType: downloaded.val.contentType ?? str(payload.mimeType),
    });
    if (!extracted.ok) {
      // Every one of these is deterministic: retrying cannot change a file's
      // format, its password, or its corruption.
      logger.info('no text from {refId} ({reason})', {
        component: COMPONENT,
        tenantId,
        refId,
        reason: extracted.err.type,
      });
      return;
    }
    if (!extracted.val.text) return; // a scan; nothing to embed

    // The cTag we ACTUALLY downloaded, never the payload's: the file may have
    // changed in between, and recording the older tag would make the next
    // round skip a version that was never indexed.
    const cTag = str(downloaded.val.item.cTag) || str(payload.cTag);

    const ingested = await ingestObjectChunks(tenantId, embedder, {
      provider,
      refId,
      content: extracted.val.text,
      metadata: {
        kind: 'doc',
        driveId,
        itemId,
        name,
        path: str(payload.path),
        webUrl: str(payload.webUrl),
        mimeType: str(payload.mimeType),
        format: extracted.val.format,
        size: typeof payload.size === 'number' ? payload.size : undefined,
        cTag,
        scopeKey: str(payload.scopeKey),
        scopeLabel: str(payload.scopeLabel),
        syncEpoch: str(payload.syncEpoch),
        truncated: extracted.val.truncated || undefined,
      },
      sourceAt: str(payload.sourceAt) || null,
    });
    if (!ingested.ok) throw new Error(`could not index ${refId}: ${ingested.err.type}`);
  };
}

/**
 * `knowledge/reconcile.drive` — mark-and-sweep after a full enumeration.
 *
 * Runs last on the drive's ordering key, so every ingest of the round has
 * already re-stamped its chunks with this epoch. Whatever still carries an
 * older one is gone from the source — including descendants of a deleted
 * folder, which drive delta cannot enumerate.
 */
export function createKnowledgeReconcileDriveHandler(): EventHandler {
  return async (event) => {
    const payload = payloadOf(event);
    const provider = required(payload, 'provider');
    const driveId = required(payload, 'driveId');
    const syncEpoch = required(payload, 'syncEpoch');

    const removed = await deleteStaleScopeChunks(
      event.tenant_id,
      provider,
      { key: 'scopeKey', value: driveId },
      { key: 'syncEpoch', value: syncEpoch }
    );
    if (!removed.ok) throw new Error(`could not reconcile drive ${driveId}`);
    if (removed.val > 0) {
      logger.info('reconciled {driveId}: removed {removed} stale chunk(s)', {
        component: COMPONENT,
        tenantId: event.tenant_id,
        driveId,
        removed: removed.val,
      });
    }
  };
}

/**
 * `knowledge/enrich.item` — the asynchronous related-items back-fill.
 *
 * The interactive worker inserts an actionable item with empty
 * `evidence.related` and posts its reply without waiting; this event then
 * searches the index — which, because it shares the ingest's ordering key
 * followed the message's own ingest.object, already contains the message —
 * and writes what it finds into the item.
 *
 * The write is deliberately narrow: jsonb_set on exactly the two enrichment
 * keys, guarded on status = 'suggested'. An item the user already actioned
 * or dismissed is left alone, and concurrent status/decision changes can
 * never be clobbered because nothing else in evidence is rewritten.
 */
export function createKnowledgeEnrichItemHandler(): EventHandler {
  return async (event) => {
    const payload = payloadOf(event);
    const itemId = required(payload, 'itemId');
    const provider = required(payload, 'provider');
    const refId = required(payload, 'refId');
    const query = str(payload.query);
    const accessSubject = str(payload.accessSubject);
    if (!query.trim() || !accessSubject) return; // nothing to search, or nobody to gate for

    const embedder = await resolveEmbeddingProvider(event.tenant_id);
    if (!embedder) return;

    // The ACL gate needs a live verifier under the tenant's bot client —
    // enrichment discloses prior content, so it verifies against the acting
    // identity exactly as the inline search did.
    const context = await resolveWebexContext(event.tenant_id);
    const searched = await searchKnowledge({
      tenantId: event.tenant_id,
      userEmail: accessSubject,
      query,
      k: 3,
      embedder,
      verifiers: new Map([['webex', createWebexAccessVerifier(context.client)]]),
      excludeRef: { provider, refId },
    });
    if (!searched.ok) {
      throw new Error(`related-items search failed for item ${itemId}: ${searched.err.type}`);
    }

    const related = searched.val.hits.map((hit) => ({
      provider: hit.provider,
      refId: hit.refId,
      excerpt: hit.content.slice(0, 200),
      distance: hit.distance,
    }));

    const dbResult = getDatabase();
    if (!dbResult.ok) throw new Error('database unavailable');
    const updated = await dbResult.val
      .updateTable('actionable_items')
      .set({
        evidence: sql`jsonb_set(
          jsonb_set(evidence, '{related}', ${JSON.stringify(related)}::jsonb),
          '{relatedElided}', ${JSON.stringify(searched.val.elided)}::jsonb
        )`,
        updated_at: sql`NOW()`,
      })
      .where('id', '=', itemId)
      .where('tenant_id', '=', event.tenant_id)
      .where('status', '=', 'suggested')
      .executeTakeFirst();

    logger.debug('enriched item {itemId} with {count} related hit(s)', {
      component: COMPONENT,
      tenantId: event.tenant_id,
      itemId,
      count: Number(updated.numUpdatedRows ?? 0) === 0 ? 0 : related.length,
    });
  };
}
