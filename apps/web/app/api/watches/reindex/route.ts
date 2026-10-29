/**
 * Rebuild one watch from scratch: drop what Renkei has indexed for that
 * scope and reset the cursor so the next sweep re-reads the whole thing.
 *
 * To be unambiguous, because the word "delete" near a Jira project or a
 * document library is alarming: this deletes ROWS IN knowledge_chunks —
 * Renkei's own indexed copy. It issues no write of any kind to Jira,
 * Confluence or SharePoint, and the only provider calls the rebuild makes
 * afterwards are reads. No document is touched.
 *
 * The purge is what makes this a rebuild rather than a top-up. Re-reading
 * with the cursor cleared re-ingests everything currently in the project,
 * space or library, but issues deleted at the source, pages moved out of a
 * watched space, and content indexed under a since-changed extraction would
 * all survive untouched — the index would only ever grow. For SharePoint
 * that last case is the whole point right now: documents indexed while PDF
 * extraction was broken are sitting there as filename-only entries, and only
 * a rebuild re-reads them.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDataStore } from '@renkei/db';
import { deleteChunksByMetadata } from '@renkei/knowledge';
import { embeddingJobsQueue } from '@renkei/queue';
import { getSessionFromRequest } from '@/lib/session';
import { logger } from '@/lib/logger';

/** Where each poller records the scope it pulled an item from. */
const SCOPE_METADATA_KEY: Record<string, string> = {
  jira: 'project',
  confluence: 'spaceId',
  sharepoint: 'scopeKey',
};

/**
 * The queued work a rebuild has to discard, per provider.
 *
 * Both halves of this differ for SharePoint, and getting either wrong leaves
 * the rebuild half-done in a way that looks like success. Jira and Confluence
 * enqueue `ingest.object` messages carrying the extracted content, with the
 * scope under `metadata`. SharePoint enqueues `ingest.document` — an
 * IDENTIFIER, because the bytes are re-downloaded later — and its scope key
 * sits at the top level of the payload, not under `metadata`. Matching on
 * ['metadata','scopeKey'] would find nothing, report zero discarded, and let
 * the backlog quietly rebuild everything that was just purged.
 */
const QUEUED_WORK: Record<string, { type: string; scopePath: string[] }> = {
  jira: { type: 'ingest.object', scopePath: ['metadata', 'project'] },
  confluence: { type: 'ingest.object', scopePath: ['metadata', 'spaceId'] },
  sharepoint: { type: 'ingest.document', scopePath: ['scopeKey'] },
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const provider = typeof body?.provider === 'string' ? body.provider : '';
  const scopeKey = typeof body?.scopeKey === 'string' ? body.scopeKey.trim() : '';
  const metadataKey = SCOPE_METADATA_KEY[provider];
  const queued = QUEUED_WORK[provider];
  if (!metadataKey || !queued || !scopeKey) {
    return NextResponse.json({ error: 'provider and scopeKey are required' }, { status: 400 });
  }

  const watches = getDataStore().contentWatches;

  // Ownership is the authorization: a watch belongs to the subject whose
  // grant polls it, so only that person can rebuild it.
  const watch = await watches.findForSubject(session.subject, provider, scopeKey);
  if (!watch) return NextResponse.json({ error: 'No such watch' }, { status: 404 });

  const purged = await deleteChunksByMetadata(provider, metadataKey, scopeKey);
  if (!purged.ok) {
    logger.error('Could not clear the indexed content: {error}', {
      component: 'api/watches/reindex',
      subject: session.subject,
      error: purged.err.message ?? purged.err.type,
    });
    return NextResponse.json({ error: 'Could not clear the indexed content.' }, { status: 500 });
  }

  // The other half of a rebuild, and the half that was missing.
  //
  // Deleting the chunks is not enough while messages built from the OLD
  // content are still queued: the consumer does not know its payload went
  // stale, so it faithfully rewrites every chunk that was just purged. On a
  // live system with a deep backlog this made re-index look like it did
  // nothing at all — projects were purged, re-read, and then repopulated hours
  // later with pre-upgrade content, indistinguishable from the button being
  // broken.
  //
  // Discarding costs nothing that is not reproducible: the sweep re-reads the
  // whole scope from the provider anyway, which is the point of the rebuild.
  const discarded = await embeddingJobsQueue().purger.discardPending(queued.type, [
    { path: ['provider'], value: provider },
    { path: queued.scopePath, value: scopeKey },
  ]);
  if (!discarded.ok) {
    logger.error('Could not clear work already queued for this scope: {error}', {
      component: 'api/watches/reindex',
      subject: session.subject,
      error: discarded.err.message ?? discarded.err.type,
    });
    return NextResponse.json(
      { error: 'Could not clear work already queued for this scope.' },
      { status: 500 }
    );
  }

  // Cursor cleared last: if the purge failed above we never got here, so a
  // watch can't end up with its content gone AND its cursor still claiming
  // the content is current.
  // Null last_synced_at, not NOW(): the sweep treats never-synced watches
  // as due immediately, so the rebuild starts on the next pass rather than
  // waiting out a full interval.
  await watches.resetForRebuild(watch.id);

  return NextResponse.json({
    purged: purged.val,
    discarded: discarded.val,
    label: watch.scopeLabel ?? scopeKey,
  });
}
