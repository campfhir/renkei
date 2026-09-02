/**
 * The batch_* tools — starting and checking on a batch job (the generic
 * batch_jobs/batch_job_items framework, packages/batch-jobs-store). This
 * tool module only ever creates a batch row and enqueues its discovery
 * message; everything else (grouping, OCR, staging) runs in
 * apps/worker's dedicated batch-jobs-worker — see
 * apps/worker/src/batch-jobs/document-ocr-pipeline.ts for the one kind
 * registered today.
 *
 * There is deliberately no separate "read an assembled document" tool:
 * document-ocr-pipeline stages each finished document as an ordinary
 * markdown file in the sandbox, tagged with the batch's id — the existing
 * sandbox_list_files(batchId) and sandbox_read_file tools already cover
 * finding and reading it.
 *
 * sandbox_ocr_file is the ad-hoc counterpart: OCR one already-staged
 * sandbox file interactively, without a batch at all.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { getDatabase } from '@renkei/db';
import { getBatch, listBatches, listItems } from '@renkei/batch-jobs-store';
import { callMistralOcr, resolveMistralOcrConfig, describeMistralOcrError } from '@renkei/connector-mistral-ocr';
import { sbReadFile, clientFailure as sandboxClientFailure } from '@renkei/sandbox-client';
import {
  startDocumentOcrPipeline,
  type AfterProcessing,
  type DocumentGrouping,
} from '@/lib/batch-jobs/start-document-ocr-pipeline';
import { afterProcessingRefusal, normalizeFolderPath } from '@/lib/batch-jobs/pipeline-options';
import { listConnectedShares } from '@renkei/connector-fileshares';
import { logger } from '@/lib/logger';
import type { MCPToolContext } from '../common';

/** The connector key the batch-job capabilities register under. */
export const BATCH_JOBS_MCP_CONNECTOR = 'batch-jobs';

const MAX_OCR_TEXT_CHARS = 60_000;

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errText(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function targetOf(context: MCPToolContext): { tenantId: string; subject: string } | string {
  if (!context.subject) return 'No signed-in identity on this request.';
  return { tenantId: context.tenantId, subject: context.subject };
}

const groupingSchema = z.union([
  z.object({ strategy: z.literal('whole-file') }),
  z.object({
    strategy: z.literal('filename-pattern'),
    pattern: z
      .string()
      .describe('A regex with named captures ?<documentKey> and ?<page>, e.g. ^(?<documentKey>.+)-p(?<page>\\d+)\\.tif$'),
  }),
]);

const afterProcessingSchema = z.union([
  z.object({ action: z.literal('keep') }),
  z.object({ action: z.literal('delete') }),
  z.object({
    action: z.literal('move'),
    shareId: z.string().uuid().describe('The share to move into — the source share, or another one.'),
    path: z.string().describe('Destination FOLDER from that share\'s root, Unix style (e.g. /processed).'),
  }),
]);

function batchSummaryLine(batch: {
  id: string;
  kind: string;
  status: string;
  total: number | null;
  succeeded: number;
  failed: number;
  skipped: number;
}): string {
  const done = batch.succeeded + batch.failed + batch.skipped;
  const progress = batch.total === null ? 'discovering…' : `${done}/${batch.total}`;
  const skipped = batch.skipped > 0 ? `, ${batch.skipped} skipped as already processed` : '';
  return `${batch.id} — ${batch.kind} — ${batch.status} — ${progress} (${batch.succeeded} ok, ${batch.failed} failed${skipped})`;
}

export function registerBatchJobTools(server: McpServer, context: MCPToolContext): void {
  server.registerTool(
    'batch_start_document_pipeline',
    {
      title: 'Batch Jobs · Act — Start an OCR pipeline over a fileshare folder',
      description:
        'Split/group a fileshare folder\'s documents, OCR each with Mistral Document AI, and ' +
        'stage each finished document\'s text in your sandbox scratch space (tagged with the ' +
        'returned batchId) for a later step to classify and file into OnBase. Runs in the ' +
        'background — this only starts it; poll with batch_get_job. Use grouping ' +
        '{strategy: "whole-file"} when each source file is already a complete document, or ' +
        '{strategy: "filename-pattern", pattern} when the folder holds a scanner\'s separate ' +
        'per-page files that need correlating back into one document by filename. Files an ' +
        'earlier batch already processed (same bytes, by SHA-256) are skipped by default, so ' +
        'the same folder can be run again safely; afterProcessing can move or delete each ' +
        'source file once its document is staged (needs write/delete tools enabled for the ' +
        'share on the Connectors page).',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        name: z.string().min(1).describe('A human-readable name for this batch, e.g. "Invoices — March 2026".'),
        shareId: z.string().uuid().describe('From fileshare_list_shares.'),
        path: z.string().optional().describe('Folder path from the share root (default "/").'),
        grouping: groupingSchema,
        skipProcessed: z
          .boolean()
          .optional()
          .describe(
            'Default true: skip any file whose contents an earlier batch on this share already ' +
              'processed, and record the files this batch processes. false processes every file ' +
              'and keeps no record.'
          ),
        afterProcessing: afterProcessingSchema
          .optional()
          .describe('Default {action:"keep"}. Opt in to delete each source file, or move it to a folder.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');

      const grouping: DocumentGrouping = groupingSchema.parse(args.grouping);
      const shareId = str(args.shareId);
      const skipProcessed = typeof args.skipProcessed === 'boolean' ? args.skipProcessed : true;
      const parsedAfter: AfterProcessing =
        args.afterProcessing === undefined ? { action: 'keep' } : afterProcessingSchema.parse(args.afterProcessing);
      let afterProcessing: AfterProcessing = parsedAfter;
      if (parsedAfter.action === 'move') {
        const folder = normalizeFolderPath(parsedAfter.path);
        if (!folder) return errText('afterProcessing.path must be a folder path with no ".." segments.');
        afterProcessing = { ...parsedAfter, path: folder };
      }

      // The share must be one the caller connected, and moving/deleting on
      // it must be within what they allowed the tools on the Connectors
      // page — same gate the plain form goes through.
      const connected = await listConnectedShares(dbResult.val, target.tenantId, target.subject);
      if (!connected.ok) return errText('Could not read your file shares.');
      const refusal = afterProcessingRefusal(connected.val, shareId, afterProcessing);
      if (refusal) return errText(refusal);

      const batch = await startDocumentOcrPipeline(dbResult.val, {
        tenantId: target.tenantId,
        subject: target.subject,
        name: str(args.name),
        shareId,
        path: str(args.path) || '/',
        grouping,
        skipProcessed,
        afterProcessing,
      });

      return textResult(
        `Started batch ${batch.id}. It's discovering the folder now; check progress with ` +
          `batch_get_job (batchId: "${batch.id}").`
      );
    }
  );

  server.registerTool(
    'batch_get_job',
    {
      title: 'Batch Jobs · Read — Check on a batch job',
      description: 'Status and progress of one batch job you started.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ batchId: z.string().uuid() }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');

      const batch = await getBatch(dbResult.val, str(args.batchId), target.tenantId);
      if (!batch || batch.subject !== target.subject) return errText('No such batch job.');
      return textResult(batchSummaryLine(batch));
    }
  );

  server.registerTool(
    'batch_list_jobs',
    {
      title: 'Batch Jobs · Read — List your recent batch jobs',
      description: 'The batch jobs you have started recently, most recent first.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');

      const batches = await listBatches(dbResult.val, target.tenantId, target.subject, { limit: 20 });
      if (batches.length === 0) return textResult('No batch jobs yet.');
      return textResult(batches.map(batchSummaryLine).join('\n'));
    }
  );

  server.registerTool(
    'batch_list_items',
    {
      title: 'Batch Jobs · Read — List one batch job\'s items',
      description:
        'The documents/units of work within one batch, with their status and (once succeeded) ' +
        'the sandbox fileId a result was staged to — read it with sandbox_read_file.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        batchId: z.string().uuid(),
        status: z.enum(['pending', 'processing', 'succeeded', 'failed', 'skipped']).optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');

      const batch = await getBatch(dbResult.val, str(args.batchId), target.tenantId);
      if (!batch || batch.subject !== target.subject) return errText('No such batch job.');

      const items = await listItems(dbResult.val, batch.id, { status: str(args.status) || undefined, limit: 200 });
      if (items.length === 0) return textResult('No items (yet).');
      return textResult(
        items
          .map((item) => {
            const documentKey = str(item.payload.documentKey) || item.id;
            const sandboxFileId = item.result ? str(item.result.sandboxFileId) : '';
            const reason = item.status === 'skipped' && item.result ? str(item.result.reason) : '';
            return (
              `${item.id} — "${documentKey}" — ${item.status}` +
              (sandboxFileId ? ` — sandbox file ${sandboxFileId}` : '') +
              (reason ? ` (${reason})` : '')
            );
          })
          .join('\n')
      );
    }
  );

  server.registerTool(
    'sandbox_ocr_file',
    {
      title: 'Sandbox · Act — OCR a staged file with Mistral Document AI',
      description:
        'Run OCR on a file already staged in your sandbox scratch space (see sandbox_download_url, ' +
        'sandbox_fetch_from_fileshare) and return its extracted text. For a whole folder of ' +
        'documents, use batch_start_document_pipeline instead — this is the one-off, interactive path.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        fileId: z.string().uuid().describe('From sandbox_list_files or a stage tool.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);

      const mistralConfig = await resolveMistralOcrConfig(target.tenantId);
      if (!mistralConfig.ok) {
        return errText(
          mistralConfig.err === 'unconfigured'
            ? 'The Mistral OCR connector is not configured for this org.'
            : 'Could not read the Mistral OCR connector configuration.'
        );
      }

      const read = await sbReadFile(target, str(args.fileId));
      if (!read.ok) return errText(sandboxClientFailure(read.err).message);

      const ocr = await callMistralOcr(
        mistralConfig.val,
        {
          bytes: read.val.bytes,
          filename: read.val.filename,
          contentType: read.val.contentType || 'application/octet-stream',
        },
        { logger }
      );
      if (!ocr.ok) return errText(describeMistralOcrError(ocr.err));

      const text = ocr.val.pages.map((page) => page.markdown).join('\n\n');
      const truncated = text.length > MAX_OCR_TEXT_CHARS;
      const body = truncated ? text.slice(0, MAX_OCR_TEXT_CHARS) : text;
      return textResult(
        `${body}${truncated ? `\n\n[note: truncated to ${MAX_OCR_TEXT_CHARS} characters]` : ''}`
      );
    }
  );
}
