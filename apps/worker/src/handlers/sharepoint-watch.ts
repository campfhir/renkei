/**
 * One polling round for a watched drive — a SharePoint document library or a
 * personal OneDrive, which are the same thing to Graph.
 *
 * The round does no downloading, no extraction and no embedding. It runs a
 * delta round, decides what changed, and enqueues one reference per changed
 * document; the embedding worker fetches the bytes on its own clock
 * (Decision #20). That keeps this handler's runtime bounded by Graph's clock
 * rather than by the size of the library, which matters because the queue
 * reclaims a claim after ten minutes.
 *
 * Drive delta differs from mail delta in four ways, each of which is a silent
 * bug if you assume otherwise:
 *
 *   - Deletions arrive as a `deleted` FACET. Mail's `@removed` never appears,
 *     so a copied mail check misses every deletion.
 *   - The response is recursive over the whole drive and includes the root,
 *     folders and packages, none of which are documents.
 *   - A folder rename returns the folder AND all its descendants, so stored
 *     paths self-heal for free.
 *   - The token can expire: Graph answers 410 `resyncRequired`, and the only
 *     correct response is to drop the cursor and re-enumerate.
 */

import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { getDatabase } from '@renkei/db';
import { actorForAccount } from '../log-actor';
import {
  initialDeltaUrl,
  runDeltaRound,
  sharepointRefId,
  SHAREPOINT_KNOWLEDGE_PROVIDER,
} from '@renkei/connector-microsoft';
import { readObjectMetadataBatch } from '@renkei/knowledge';
import { isExtractableCandidate, DEFAULT_MAX_INPUT_BYTES } from '@renkei/document-text';
import { enqueueKnowledgeEvent } from '../enqueue';
import { logger } from '../logger';
import { TitleList } from '../log-titles';
import type { MicrosoftAccess } from './microsoft-access';

const COMPONENT = 'sharepoint/watch';

/**
 * Pages per round. Smaller than mail's 50 so one big library cannot
 * monopolise a sweep pass — the unfollowed nextLink is persisted as the
 * cursor, so the next round simply continues where this one stopped.
 */
const DRIVE_MAX_PAGES = 10;

export interface DriveWatchRow {
  id: string;
  tenant_id: string;
  account_id: string;
  scope_key: string;
  scope_label: string | null;
  cursor: string | null;
}

export interface DriveSyncResult {
  /** Documents enqueued for ingestion — not yet indexed; a queue hop follows. */
  items: number;
  /** Unchanged by cTag. The number that distinguishes "quiet" from "re-embedding itself". */
  skipped: number;
  removed: number;
  unsupported: number;
  oversized: number;
  /** The names of the enqueued documents, bounded — see log-titles.ts. */
  titles: string[];
  cursor: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Graph reports a deletion as a facet on an otherwise sparse entry. */
function isDeleted(entry: Record<string, unknown>): boolean {
  return entry.deleted !== undefined;
}

/** Folders, the drive root and packages (OneNote) are containers, not documents. */
function isContainer(entry: Record<string, unknown>): boolean {
  return entry.folder !== undefined || entry.root !== undefined || entry.package !== undefined;
}

export async function runDriveWatchSync(
  tenantId: string,
  access: MicrosoftAccess,
  row: DriveWatchRow
): Promise<DriveSyncResult> {
  const dbResult = getDatabase();
  if (!dbResult.ok) throw new Error('database unavailable');
  const db = dbResult.val;

  const driveId = row.scope_key;
  const fullEnumeration = row.cursor === null;
  // A per-round stamp: once an enumeration that started cursorless closes,
  // anything still carrying an older epoch is gone from the source.
  const syncEpoch = randomUUID();
  const startUrl = row.cursor ?? initialDeltaUrl('drive', { driveId });

  const round = await runDeltaRound(access.accessToken, startUrl, { maxPages: DRIVE_MAX_PAGES });
  if (!round.ok) {
    // A delta token that has aged out is not an error — it is an instruction
    // to start over. Cheap, because the cTag skip means re-enumerating costs
    // enumeration only: no re-download, no re-embed.
    if (round.err.cause === 410) {
      await db
        .updateTable('content_watches')
        .set({ cursor: null, sync_status: 'syncing', updated_at: sql<Date>`NOW()` })
        .where('id', '=', row.id)
        .execute();
      logger.info('drive delta token expired for {scope}; will re-enumerate', {
        component: COMPONENT,
        tenantId,
        scope: row.scope_label ?? driveId,
      });
      return {
        items: 0,
        skipped: 0,
        removed: 0,
        unsupported: 0,
        oversized: 0,
        titles: [],
        cursor: null,
      };
    }
    throw new Error(`delta round failed for drive ${driveId}: ${round.err.message ?? 'unknown'}`);
  }

  const entries = round.val.items.filter(isRecord);

  // One metadata read for the whole round rather than one per item. Without
  // this, every resync and every cursor loss re-downloads a whole library.
  const candidateRefIds = entries
    .filter((entry) => !isDeleted(entry) && !isContainer(entry) && str(entry.id))
    .map((entry) => sharepointRefId(driveId, str(entry.id)));
  const stored = await readObjectMetadataBatch(
    tenantId,
    SHAREPOINT_KNOWLEDGE_PROVIDER,
    candidateRefIds
  );
  const known = stored.ok ? stored.val : new Map<string, Record<string, unknown>>();

  const orderingKey = `sharepoint/${driveId}`;
  // Which documents, not just how many — the counts alone cannot answer
  // "did the file I just saved get picked up?".
  const indexed = new TitleList();
  const result: DriveSyncResult = {
    items: 0,
    skipped: 0,
    removed: 0,
    unsupported: 0,
    oversized: 0,
    titles: [],
    cursor: round.val.deltaLink ?? round.val.nextLink,
  };

  for (const entry of entries) {
    const objectId = str(entry.id);
    if (!objectId) continue;
    const refId = sharepointRefId(driveId, objectId);

    if (isDeleted(entry)) {
      await enqueueKnowledgeEvent(
        tenantId,
        'delete.object',
        { provider: SHAREPOINT_KNOWLEDGE_PROVIDER, refId },
        orderingKey
      );
      result.removed += 1;
      continue;
    }
    if (isContainer(entry)) continue;

    const file = isRecord(entry.file) ? entry.file : null;
    // No file facet and no folder facet: something Graph models that we do
    // not index (a bundle, a shortcut). Skipping is correct and silent.
    if (!file) continue;

    const name = str(entry.name);
    const mimeType = str(file.mimeType);
    const size = typeof entry.size === 'number' ? entry.size : undefined;

    if (size !== undefined && size > DEFAULT_MAX_INPUT_BYTES) {
      result.oversized += 1;
      continue;
    }
    // Decided from name and type ALONE, before any download: a 400MB video
    // must never be fetched just to discover it is a video.
    if (!isExtractableCandidate({ fileName: name, contentType: mimeType, sizeBytes: size })) {
      result.unsupported += 1;
      continue;
    }

    // cTag, not eTag: eTag also bumps on a rename or a metadata edit, so
    // skipping on it would re-download and re-embed unchanged content.
    const cTag = str(entry.cTag);
    const previous = known.get(refId);
    if (cTag && previous && previous.cTag === cTag) {
      result.skipped += 1;
      continue;
    }

    const parent = isRecord(entry.parentReference) ? entry.parentReference : {};
    await enqueueKnowledgeEvent(
      tenantId,
      'ingest.document',
      {
        provider: SHAREPOINT_KNOWLEDGE_PROVIDER,
        refId,
        // Whose grant the embedding worker downloads with.
        accountId: access.accountId,
        driveId,
        itemId: objectId,
        name,
        mimeType,
        size: size ?? null,
        cTag,
        webUrl: str(entry.webUrl) || null,
        // Who last touched it — a document's most useful attribution, and
        // free here since Graph already returned it.
        lastModifiedBy:
          isRecord(entry.lastModifiedBy) && isRecord(entry.lastModifiedBy.user)
            ? str(entry.lastModifiedBy.user.displayName) || null
            : null,
        path: `${str(parent.path)}/${name}`.replace(/^\/?root:/, ''),
        scopeKey: driveId,
        scopeLabel: row.scope_label,
        sourceAt: str(entry.lastModifiedDateTime) || null,
        syncEpoch,
      },
      orderingKey
    );
    indexed.add(name);
    result.items += 1;
  }
  result.titles = indexed.titles();

  // When a cursorless enumeration CLOSES (Graph handed back a real deltaLink
  // rather than a capped continuation), everything that survived it has been
  // re-stamped — so anything older is genuinely gone. Lane FIFO on the shared
  // ordering key guarantees this runs after every ingest above.
  if (fullEnumeration && round.val.deltaLink !== null) {
    await enqueueKnowledgeEvent(
      tenantId,
      'reconcile.drive',
      { provider: SHAREPOINT_KNOWLEDGE_PROVIDER, driveId, syncEpoch },
      orderingKey
    );
  }

  // Cursor and counters written LAST and together: a crash before this point
  // replays the round into idempotent enqueues, which is the safe direction.
  await db
    .updateTable('content_watches')
    .set({
      cursor: result.cursor,
      last_synced_at: sql<Date>`NOW()`,
      last_run_items: result.items,
      total_items: sql<number>`total_items + ${result.items}`,
      // A capped round is mid-enumeration; only a real deltaLink means caught up.
      sync_status: round.val.deltaLink === null ? 'syncing' : 'idle',
      last_error: null,
      updated_at: sql<Date>`NOW()`,
    })
    .where('id', '=', row.id)
    .execute();

  const actor = await actorForAccount(db, tenantId, row.account_id);
  const fields = {
    component: COMPONENT,
    tenantId,
    scope: row.scope_label ?? driveId,
    // The opaque drive id stays searchable in the metadata.
    driveId,
    userName: actor.displayName,
    subject: actor.subject,
    items: result.items,
    skipped: result.skipped,
    unsupported: result.unsupported,
    oversized: result.oversized,
    removed: result.removed,
    // The names themselves, so a search on a filename finds the round that
    // took it in. `documents` is the phrase the sentence uses.
    titles: result.titles,
    documents: indexed.summary(),
  };
  if (result.items > 0 || result.removed > 0) {
    logger.info(
      'indexed {items} doc(s) from {scope} for {userName}: {documents} — {skipped} unchanged, {unsupported} unsupported, {oversized} oversized, {removed} removed',
      fields
    );
  } else {
    // "0 doc(s), 0 unchanged, 0 unsupported, 0 oversized, 0 removed" is a
    // poll that found nothing — true, frequent, and not worth a line
    // someone has to read past.
    logger.debug('no new docs from {scope} for {userName}', fields);
  }

  return result;
}
