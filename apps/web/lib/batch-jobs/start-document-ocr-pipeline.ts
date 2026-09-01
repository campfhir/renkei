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

export interface StartDocumentOcrPipelineInput {
  tenantId: string;
  subject: string;
  shareId: string;
  /** Folder path from the share root; defaults to "/". */
  path?: string;
  grouping: DocumentGrouping;
}

export async function startDocumentOcrPipeline(
  db: Kysely<DB>,
  input: StartDocumentOcrPipelineInput
): Promise<BatchJobRow> {
  const batch = await createBatch(db, {
    tenantId: input.tenantId,
    subject: input.subject,
    kind: DOCUMENT_OCR_PIPELINE_KIND,
    config: { shareId: input.shareId, path: input.path || '/', grouping: input.grouping },
  });
  await enqueueDiscover(batchJobsQueue().producer, input.tenantId, batch.id);
  return batch;
}
