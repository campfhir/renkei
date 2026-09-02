/**
 * The document-ocr-pipeline start glue — create the batch row, enqueue its
 * discovery message — shared by the batch_start_document_pipeline MCP tool
 * (apps/web/lib/mcp-tools/batch-jobs/index.ts, for an agent) and the plain
 * POST route (apps/web/app/api/tenant/[tenantId]/batch-jobs/route.ts, for a
 * human using the "start a batch job" form) so the two paths cannot drift.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { createBatch, enqueueDiscover, DOCUMENT_OCR_PIPELINE_KIND, type BatchJobRow } from '@renkei/batch-jobs-store';
import { batchJobsQueue } from '@renkei/queue';

export type DocumentGrouping =
  | { strategy: 'whole-file' }
  | { strategy: 'filename-pattern'; pattern: string };

/**
 * What happens to a source file once its document is staged. `move` may
 * name another share: the pipeline reads the bytes for OCR anyway, so a
 * cross-share move is write-there-then-remove-here, with SMB vs SFTP left
 * to the fileshare worker like every other operation.
 */
export type AfterProcessing =
  | { action: 'keep' }
  | { action: 'delete' }
  | { action: 'move'; shareId: string; path: string };

/** The config a document-ocr-pipeline batch or schedule carries. */
export interface DocumentPipelineConfig {
  shareId: string;
  path: string;
  grouping: DocumentGrouping;
  /** Consult and maintain the processed-files ledger (default true). */
  skipProcessed: boolean;
  afterProcessing: AfterProcessing;
}

export interface StartDocumentOcrPipelineInput {
  tenantId: string;
  subject: string;
  /** A human-readable name to tell this batch apart from others in the list. */
  name: string;
  shareId: string;
  /** Folder path from the share root; defaults to "/". */
  path?: string;
  grouping: DocumentGrouping;
  /** Skip files an earlier batch already processed (default true). */
  skipProcessed?: boolean;
  /** What to do with each source file afterwards (default keep). */
  afterProcessing?: AfterProcessing;
  /** Set when this run was spawned by a schedule firing, not a one-off start. */
  scheduleId?: string;
}

/** The one shape both batches and schedules store — never assembled by hand elsewhere. */
export function documentPipelineConfig(input: {
  shareId: string;
  path?: string;
  grouping: DocumentGrouping;
  skipProcessed?: boolean;
  afterProcessing?: AfterProcessing;
}): DocumentPipelineConfig {
  return {
    shareId: input.shareId,
    path: input.path || '/',
    grouping: input.grouping,
    skipProcessed: input.skipProcessed ?? true,
    afterProcessing: input.afterProcessing ?? { action: 'keep' },
  };
}

export async function startDocumentOcrPipeline(
  db: Kysely<DB>,
  input: StartDocumentOcrPipelineInput
): Promise<BatchJobRow> {
  const batch = await createBatch(db, {
    tenantId: input.tenantId,
    subject: input.subject,
    name: input.name,
    kind: DOCUMENT_OCR_PIPELINE_KIND,
    config: { ...documentPipelineConfig(input) },
    scheduleId: input.scheduleId,
  });
  await enqueueDiscover(batchJobsQueue().producer, input.tenantId, batch.id);
  return batch;
}
