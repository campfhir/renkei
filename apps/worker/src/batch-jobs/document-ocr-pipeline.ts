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
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { fsListFolder, fsReadFile, clientFailure as fileshareClientFailure } from '@renkei/fileshares-client';
import { sbWriteFile, clientFailure as sandboxClientFailure } from '@renkei/sandbox-client';
import { callMistralOcr, resolveMistralOcrConfig, describeMistralOcrError } from '@renkei/connector-mistral-ocr';
import { DOCUMENT_OCR_PIPELINE_KIND } from '@renkei/batch-jobs-store';
import { registerBatchJobKind, type DiscoverOutcome, type RunItemOutcome } from './kinds';
import type { BatchJobItemRow, BatchJobRow } from './store';
import { logger } from '../logger';

export { DOCUMENT_OCR_PIPELINE_KIND };

interface WholeFileGrouping {
  strategy: 'whole-file';
}
interface FilenamePatternGrouping {
  strategy: 'filename-pattern';
  pattern: string;
}
type Grouping = WholeFileGrouping | FilenamePatternGrouping;

interface PipelineConfig {
  shareId: string;
  path: string;
  grouping: Grouping;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseConfig(raw: Record<string, unknown>): PipelineConfig | { error: string } {
  const shareId = str(raw.shareId);
  const path = str(raw.path) || '/';
  if (!shareId) return { error: 'config.shareId is required.' };
  const groupingRaw = isRecord(raw.grouping) ? raw.grouping : {};
  const strategy = str(groupingRaw.strategy);
  if (strategy === 'whole-file') {
    return { shareId, path, grouping: { strategy: 'whole-file' } };
  }
  if (strategy === 'filename-pattern') {
    const pattern = str(groupingRaw.pattern);
    if (!pattern) return { error: 'config.grouping.pattern is required for filename-pattern grouping.' };
    if (!pattern.includes('?<documentKey>') || !pattern.includes('?<page>')) {
      return { error: 'config.grouping.pattern must have documentKey and page named capture groups.' };
    }
    return { shareId, path, grouping: { strategy: 'filename-pattern', pattern } };
  }
  return { error: 'config.grouping.strategy must be "whole-file" or "filename-pattern".' };
}

function baseName(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

interface Group {
  documentKey: string;
  sourcePaths: string[];
}

function groupByFilenamePattern(paths: string[], pattern: string): Group[] {
  const regex = new RegExp(pattern);
  const byKey = new Map<string, { path: string; page: number }[]>();
  const ungrouped: Group[] = [];
  for (const path of paths) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const match = regex.exec(name);
    const documentKey = match?.groups?.documentKey;
    const pageRaw = match?.groups?.page;
    if (!documentKey || pageRaw === undefined || Number.isNaN(Number(pageRaw))) {
      // Never silently drop a file the pattern didn't recognize.
      ungrouped.push({ documentKey: baseName(path), sourcePaths: [path] });
      continue;
    }
    const entries = byKey.get(documentKey) ?? [];
    entries.push({ path, page: Number(pageRaw) });
    byKey.set(documentKey, entries);
  }
  const grouped: Group[] = Array.from(byKey.entries()).map(([documentKey, entries]) => ({
    documentKey,
    sourcePaths: entries.sort((a, b) => a.page - b.page).map((entry) => entry.path),
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

async function discover(_db: Kysely<DB>, batch: BatchJobRow): Promise<DiscoverOutcome> {
  const config = parseConfig(batch.config);
  if ('error' in config) return { ok: false, error: config.error };

  const listed = await fsListFolder(
    { tenantId: batch.tenant_id, shareId: config.shareId, subject: batch.subject },
    config.path
  );
  if (!listed.ok) return { ok: false, error: fileshareClientFailure(listed.err).message };

  const filePaths = listed.val.entries.filter((entry) => entry.kind === 'file').map((entry) => entry.path);
  const groups: Group[] =
    config.grouping.strategy === 'whole-file'
      ? filePaths.map((path) => ({ documentKey: baseName(path), sourcePaths: [path] }))
      : groupByFilenamePattern(filePaths, config.grouping.pattern);

  return {
    ok: true,
    items: groups.map((group) => ({
      documentKey: group.documentKey,
      sourcePaths: group.sourcePaths,
      shareId: config.shareId,
    })),
  };
}

async function runItem(
  _db: Kysely<DB>,
  batch: BatchJobRow,
  item: BatchJobItemRow
): Promise<RunItemOutcome> {
  const documentKey = str(item.payload.documentKey) || item.id;
  const shareId = str(item.payload.shareId);
  const sourcePaths = Array.isArray(item.payload.sourcePaths)
    ? item.payload.sourcePaths.filter((p): p is string => typeof p === 'string')
    : [];
  if (!shareId || sourcePaths.length === 0) {
    return { ok: false, error: 'Item payload carries no share or source paths.' };
  }

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

  const sections: string[] = [];
  let pageCount = 0;
  for (const path of sourcePaths) {
    const read = await fsReadFile({ tenantId: batch.tenant_id, shareId, subject: batch.subject }, path);
    if (!read.ok) return { ok: false, error: fileshareClientFailure(read.err).message };

    const ocr = await callMistralOcr(
      mistralConfig.val,
      {
        bytes: read.val,
        filename: path,
        contentType: contentTypeFor(path),
      },
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

  return {
    ok: true,
    result: {
      documentKey,
      sandboxFileId: staged.val.id,
      pageCount,
      sourcePaths,
    },
  };
}

registerBatchJobKind(DOCUMENT_OCR_PIPELINE_KIND, { discover, runItem });
