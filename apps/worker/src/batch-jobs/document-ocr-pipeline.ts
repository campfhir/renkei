/**
 * The first batch-job kind: split/group a fileshare folder's documents into
 * logical documents, OCR each constituent file with Mistral (one call per
 * FILE, never a manual pre-split into page images — see connector-mistral-ocr's
 * own comment on why), and stage each logical document's assembled OCR text
 * in the sandbox for a downstream classify-and-file agent to read and index
 * into OnBase.
 *
 * Source files vary by folder (confirmed with the batch's author): some
 * folders hold whole multi-page documents (one PDF/TIFF per document —
 * `grouping: {strategy: 'whole-file'}`), others hold a scanner's per-page
 * dump that needs correlating back into one logical document by filename
 * (`grouping: {strategy: 'filename-pattern', pattern}`, a regex with named
 * captures `documentKey` and `page`). A file that doesn't match the
 * pattern becomes its own single-file group rather than being dropped —
 * losing a file silently is worse than mis-grouping one.
 *
 * ## Never the same file twice (`skipProcessed`, default on)
 *
 * A folder scanned nightly still holds last night's files. Whether one was
 * already processed is DETERMINISTIC — the SHA-256 of its bytes against the
 * `batch_processed_files` ledger (@renkei/batch-jobs-store processed-files),
 * never a model's opinion — and checked twice, each time before anything
 * billed:
 *
 *   1. At discovery, from the listing alone: a file whose path, size and
 *      modified time match what the ledger recorded when it was hashed is
 *      skipped without being read. Recorded as an item with status
 *      'skipped' so the batch page shows it, never enqueued.
 *   2. At item time, after the read the OCR needs anyway: the bytes are
 *      hashed, and a hash the ledger knows ends the item as skipped before
 *      the Mistral call. This is what catches a re-copied or renamed file.
 *
 * A group (one logical document) is skipped only when EVERY file in it is
 * known; one new page means the whole document is assembled again. Opting
 * out (`skipProcessed: false`) means the ledger is neither read nor
 * written by this batch.
 *
 * ## What happens to the source afterwards (`afterProcessing`, default keep)
 *
 * Opt-in, per batch: delete each source file, or move it to a folder — on
 * the same share (a server-side rename) or on another (write there, then
 * remove here; the bytes were already in hand for the OCR). Moving to a
 * folder the share serves as "done" is the natural complement of the
 * ledger for someone who would rather see a clean inbox than trust a
 * table. The file server judges every one of these with the owner's own
 * credentials; consent at the Renkei boundary is checked when the batch
 * is created (apps/web/lib/batch-jobs/pipeline-options.ts), not here.
 *
 * A post-processing failure fails the ITEM, with the staged sandbox file
 * still in the result: the OCR is done and paid for, the ledger has the
 * hash (so a rerun skips it), but the batch's contract — process AND move —
 * was not met, and the owner should see that rather than a clean finish.
 */

import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import {
  fsListFolder,
  fsMoveEntry,
  fsReadFile,
  fsRemoveEntry,
  fsStatEntry,
  fsWriteFile,
  clientFailure as fileshareClientFailure,
  type FileshareTarget,
} from '@renkei/fileshares-client';
import { sbWriteFile, clientFailure as sandboxClientFailure } from '@renkei/sandbox-client';
import {
  callMistralOcr,
  resolveMistralOcrConfig,
  describeMistralOcrError,
} from '@renkei/connector-mistral-ocr';
import {
  DOCUMENT_OCR_PIPELINE_KIND,
  findProcessedByPath,
  findProcessedHashes,
  matchesProcessedStat,
  recordProcessedFiles,
} from '@renkei/batch-jobs-store';
import { registerBatchJobKind, type DiscoverOutcome, type RunItemOutcome } from './kinds';
import type { BatchJobItemRow, BatchJobRow } from './store';
import { logger } from '../logger';

export { DOCUMENT_OCR_PIPELINE_KIND };

const COMPONENT = 'batch-jobs/document-ocr-pipeline';

interface WholeFileGrouping {
  strategy: 'whole-file';
}
interface FilenamePatternGrouping {
  strategy: 'filename-pattern';
  pattern: string;
}
type Grouping = WholeFileGrouping | FilenamePatternGrouping;

export type AfterProcessing =
  { action: 'keep' } | { action: 'delete' } | { action: 'move'; shareId: string; path: string };

interface PipelineConfig {
  shareId: string;
  path: string;
  grouping: Grouping;
  skipProcessed: boolean;
  afterProcessing: AfterProcessing;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseAfterProcessing(raw: unknown): AfterProcessing | { error: string } {
  if (raw === undefined || raw === null) return { action: 'keep' };
  if (!isRecord(raw)) return { error: 'config.afterProcessing must be an object.' };
  const action = str(raw.action);
  if (action === 'keep' || action === '') return { action: 'keep' };
  if (action === 'delete') return { action: 'delete' };
  if (action === 'move') {
    const shareId = str(raw.shareId);
    if (!shareId) return { error: 'config.afterProcessing.shareId is required to move files.' };
    return { action: 'move', shareId, path: str(raw.path) || '/' };
  }
  return { error: 'config.afterProcessing.action must be "keep", "move" or "delete".' };
}

function parseConfig(raw: Record<string, unknown>): PipelineConfig | { error: string } {
  const shareId = str(raw.shareId);
  const path = str(raw.path) || '/';
  if (!shareId) return { error: 'config.shareId is required.' };
  // Absent means on: the ledger is the default, opting out is the choice.
  const skipProcessed = raw.skipProcessed !== false;
  const afterProcessing = parseAfterProcessing(raw.afterProcessing);
  if ('error' in afterProcessing) return afterProcessing;
  const groupingRaw = isRecord(raw.grouping) ? raw.grouping : {};
  const strategy = str(groupingRaw.strategy);
  if (strategy === 'whole-file') {
    return { shareId, path, grouping: { strategy: 'whole-file' }, skipProcessed, afterProcessing };
  }
  if (strategy === 'filename-pattern') {
    const pattern = str(groupingRaw.pattern);
    if (!pattern)
      return { error: 'config.grouping.pattern is required for filename-pattern grouping.' };
    if (!pattern.includes('?<documentKey>') || !pattern.includes('?<page>')) {
      return {
        error: 'config.grouping.pattern must have documentKey and page named capture groups.',
      };
    }
    return {
      shareId,
      path,
      grouping: { strategy: 'filename-pattern', pattern },
      skipProcessed,
      afterProcessing,
    };
  }
  return { error: 'config.grouping.strategy must be "whole-file" or "filename-pattern".' };
}

function baseName(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function joinFolder(folder: string, name: string): string {
  return folder === '/' || folder === '' ? `/${name}` : `${folder.replace(/\/+$/, '')}/${name}`;
}

/** What discovery knows about one source file — carried on the item payload. */
interface SourceEntry {
  path: string;
  size: number | null;
  modifiedAt: string | null;
}

interface Group {
  documentKey: string;
  sources: SourceEntry[];
}

function groupByFilenamePattern(entries: SourceEntry[], pattern: string): Group[] {
  const regex = new RegExp(pattern);
  const byKey = new Map<string, { entry: SourceEntry; page: number }[]>();
  const ungrouped: Group[] = [];
  for (const entry of entries) {
    const match = regex.exec(fileName(entry.path));
    const documentKey = match?.groups?.documentKey;
    const pageRaw = match?.groups?.page;
    if (!documentKey || pageRaw === undefined || Number.isNaN(Number(pageRaw))) {
      // Never silently drop a file the pattern didn't recognize.
      ungrouped.push({ documentKey: baseName(entry.path), sources: [entry] });
      continue;
    }
    const pages = byKey.get(documentKey) ?? [];
    pages.push({ entry, page: Number(pageRaw) });
    byKey.set(documentKey, pages);
  }
  const grouped: Group[] = Array.from(byKey.entries()).map(([documentKey, pages]) => ({
    documentKey,
    sources: pages.sort((a, b) => a.page - b.page).map((page) => page.entry),
  }));
  return [...grouped, ...ungrouped];
}

const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

function contentTypeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const ALREADY_PROCESSED = 'already-processed';

function itemPayload(group: Group, shareId: string): Record<string, unknown> {
  return {
    documentKey: group.documentKey,
    sourcePaths: group.sources.map((source) => source.path),
    sources: group.sources,
    shareId,
  };
}

async function discover(db: Kysely<DB>, batch: BatchJobRow): Promise<DiscoverOutcome> {
  const config = parseConfig(batch.config);
  if ('error' in config) return { ok: false, error: config.error };

  const listed = await fsListFolder(
    { tenantId: batch.tenant_id, shareId: config.shareId, subject: batch.subject },
    config.path
  );
  if (!listed.ok) return { ok: false, error: fileshareClientFailure(listed.err).message };

  const entries: SourceEntry[] = listed.val.entries
    .filter((entry) => entry.kind === 'file')
    .map((entry) => ({
      path: entry.path,
      size: typeof entry.size === 'number' ? entry.size : null,
      modifiedAt: typeof entry.modifiedAt === 'string' ? entry.modifiedAt : null,
    }));

  const groups: Group[] =
    config.grouping.strategy === 'whole-file'
      ? entries.map((entry) => ({ documentKey: baseName(entry.path), sources: [entry] }))
      : groupByFilenamePattern(entries, config.grouping.pattern);

  if (!config.skipProcessed) {
    return {
      ok: true,
      items: groups.map((group) => itemPayload(group, config.shareId)),
      skipped: [],
    };
  }

  // The fast path: one query for every listed path, then a pure comparison
  // per file. A file that fails it is not "new" — it is merely "read me and
  // hash me", which item time does.
  const recorded = await findProcessedByPath(
    db,
    batch.tenant_id,
    config.shareId,
    entries.map((entry) => entry.path)
  );
  const isKnown = (source: SourceEntry): boolean => {
    const row = recorded.get(source.path);
    return row !== undefined && matchesProcessedStat(row, source);
  };

  const items: Record<string, unknown>[] = [];
  const skipped: Record<string, unknown>[] = [];
  for (const group of groups) {
    const payload = itemPayload(group, config.shareId);
    if (group.sources.every(isKnown)) skipped.push({ ...payload, skipReason: ALREADY_PROCESSED });
    else items.push(payload);
  }
  return { ok: true, items, skipped };
}

function sourcesOf(item: BatchJobItemRow): SourceEntry[] {
  const raw = Array.isArray(item.payload.sources) ? item.payload.sources : [];
  const fromSources: SourceEntry[] = raw.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.path !== 'string' || !entry.path) return [];
    return [
      {
        path: entry.path,
        size: typeof entry.size === 'number' ? entry.size : null,
        modifiedAt: typeof entry.modifiedAt === 'string' ? entry.modifiedAt : null,
      },
    ];
  });
  if (fromSources.length > 0) return fromSources;
  // Items written before `sources` existed carry only the paths.
  const paths = Array.isArray(item.payload.sourcePaths)
    ? item.payload.sourcePaths.filter((p): p is string => typeof p === 'string')
    : [];
  return paths.map((path) => ({ path, size: null, modifiedAt: null }));
}

interface ReadSource extends SourceEntry {
  bytes: Uint8Array;
  contentHash: string;
}

type AfterProcessingOutcome =
  | { action: 'keep' }
  | { action: 'delete'; removed: string[] }
  | { action: 'move'; shareId: string; movedTo: string[] };

function opType(err: { kind: string; type?: string }): string {
  return err.kind === 'op' && typeof err.type === 'string' ? err.type : '';
}

/**
 * Delete or move each source file, in order, stopping at the first failure
 * — the error names the file, and the files before it are already handled
 * (a rerun skips the document by hash and leaves the rest where it is,
 * which is the visible, fixable state). Same-share moves are server-side
 * renames; cross-share moves write the bytes already in hand and then
 * remove the source, probing the destination first so nothing clobbers.
 */
async function applyAfterProcessing(
  config: AfterProcessing,
  source: FileshareTarget,
  files: ReadSource[]
): Promise<AfterProcessingOutcome | { error: string }> {
  if (config.action === 'keep') return { action: 'keep' };

  if (config.action === 'delete') {
    const removed: string[] = [];
    for (const file of files) {
      const gone = await fsRemoveEntry(source, file.path);
      if (!gone.ok) {
        return {
          error: `could not delete ${file.path}: ${fileshareClientFailure(gone.err).message}`,
        };
      }
      removed.push(file.path);
    }
    return { action: 'delete', removed };
  }

  const target: FileshareTarget = { ...source, shareId: config.shareId };
  const movedTo: string[] = [];
  for (const file of files) {
    if (config.shareId === source.shareId) {
      const moved = await fsMoveEntry(source, file.path, config.path);
      if (!moved.ok) {
        return {
          error: `could not move ${file.path}: ${fileshareClientFailure(moved.err).message}`,
        };
      }
      movedTo.push(moved.val.path);
      continue;
    }
    const destination = joinFolder(config.path, fileName(file.path));
    const probe = await fsStatEntry(target, destination);
    if (probe.ok)
      return {
        error: `could not move ${file.path}: ${destination} already exists on the destination share`,
      };
    if (opType(probe.err) !== 'not_found') {
      return { error: `could not move ${file.path}: ${fileshareClientFailure(probe.err).message}` };
    }
    const written = await fsWriteFile(target, destination, file.bytes);
    if (!written.ok) {
      return {
        error: `could not move ${file.path}: ${fileshareClientFailure(written.err).message}`,
      };
    }
    const gone = await fsRemoveEntry(source, file.path);
    if (!gone.ok) {
      return {
        error: `copied ${file.path} to the destination share but could not remove the original: ${fileshareClientFailure(gone.err).message}`,
      };
    }
    movedTo.push(written.val.path);
  }
  return { action: 'move', shareId: config.shareId, movedTo };
}

async function runItem(
  db: Kysely<DB>,
  batch: BatchJobRow,
  item: BatchJobItemRow
): Promise<RunItemOutcome> {
  const config = parseConfig(batch.config);
  if ('error' in config) return { ok: false, error: config.error };

  const documentKey = str(item.payload.documentKey) || item.id;
  const shareId = str(item.payload.shareId);
  const sources = sourcesOf(item);
  if (!shareId || sources.length === 0) {
    return { ok: false, error: 'Item payload carries no share or source paths.' };
  }
  const sourcePaths = sources.map((source) => source.path);
  const target: FileshareTarget = { tenantId: batch.tenant_id, shareId, subject: batch.subject };

  const mistralConfig = await resolveMistralOcrConfig(batch.tenant_id);
  if (!mistralConfig.ok) {
    return {
      ok: false,
      error:
        mistralConfig.err === 'unconfigured'
          ? 'The Mistral OCR connector is not configured for this org.'
          : 'Could not read the Mistral OCR connector configuration.',
    };
  }

  // Read everything first: the hashes decide whether OCR happens at all,
  // and a cross-share move needs the bytes again afterwards.
  const files: ReadSource[] = [];
  for (const source of sources) {
    const read = await fsReadFile(target, source.path);
    if (!read.ok) return { ok: false, error: fileshareClientFailure(read.err).message };
    files.push({
      ...source,
      size: read.val.byteLength,
      bytes: read.val,
      contentHash: sha256Hex(read.val),
    });
  }
  const contentHashes = files.map((file) => file.contentHash);

  if (config.skipProcessed) {
    const known = await findProcessedHashes(db, batch.tenant_id, shareId, contentHashes);
    if (files.every((file) => known.has(file.contentHash))) {
      return {
        ok: true,
        skipped: true,
        result: {
          documentKey,
          sourcePaths,
          contentHashes,
          skipped: true,
          reason: ALREADY_PROCESSED,
        },
      };
    }
  }

  const sections: string[] = [];
  let pageCount = 0;
  for (const file of files) {
    const ocr = await callMistralOcr(
      mistralConfig.val,
      { bytes: file.bytes, filename: file.path, contentType: contentTypeFor(file.path) },
      { logger }
    );
    if (!ocr.ok) return { ok: false, error: describeMistralOcrError(ocr.err) };
    pageCount += ocr.val.pages.length;
    sections.push(ocr.val.pages.map((page) => page.markdown).join('\n\n'));
  }

  const assembled = sections.join('\n\n---\n\n');
  const staged = await sbWriteFile(
    { tenantId: batch.tenant_id, subject: batch.subject },
    {
      filename: `${documentKey}.md`,
      contentType: 'text/markdown',
      source: 'document-ocr-pipeline',
      batchId: batch.id,
    },
    new TextEncoder().encode(assembled)
  );
  if (!staged.ok) return { ok: false, error: sandboxClientFailure(staged.err).message };

  if (config.skipProcessed) {
    // Best-effort by design: the OCR is done and staged either way, and a
    // ledger write lost to a database blip costs one repeat later, not the
    // document now.
    try {
      await recordProcessedFiles(
        db,
        batch.tenant_id,
        shareId,
        batch.id,
        files.map((file) => ({
          contentHash: file.contentHash,
          path: file.path,
          size: file.size ?? file.bytes.byteLength,
          modifiedAt: file.modifiedAt ? new Date(file.modifiedAt) : null,
          documentKey,
        }))
      );
    } catch (error) {
      logger.warn(
        'batch {batchJobId}: could not record processed files for "{documentKey}": {error}',
        {
          component: COMPONENT,
          tenantId: batch.tenant_id,
          batchJobId: batch.id,
          documentKey,
          error: error instanceof Error ? error.message : String(error),
        }
      );
    }
  }

  const result: Record<string, unknown> = {
    documentKey,
    sandboxFileId: staged.val.id,
    pageCount,
    sourcePaths,
    contentHashes,
  };

  const after = await applyAfterProcessing(config.afterProcessing, target, files);
  if ('error' in after) {
    return {
      ok: false,
      error: `OCR’d and staged as sandbox file ${staged.val.id}, but ${after.error}`,
      result: {
        ...result,
        afterProcessing: { action: config.afterProcessing.action, error: after.error },
      },
    };
  }
  if (after.action !== 'keep') result.afterProcessing = after;

  return { ok: true, result };
}

registerBatchJobKind(DOCUMENT_OCR_PIPELINE_KIND, { discover, runItem });
