/**
 * The document ledger (migration 168): what work the model and the OCR
 * connector did on files a person uploaded. Written by the artifact digest
 * and the OCR run, attributed to the uploader, never to whoever happened to
 * view the file. Read by the usage pages the way the image ledger is read:
 * totals over a span in the viewer's zone, org-wide or for one person.
 */

import { getDataStore } from '@renkei/db';
import { logger } from '@/lib/logger';
import type { UsageSpan } from './user-utilization';

/** `ocr`: a read by the OCR connector; `summary`: a digest of text; `describe`: a picture described. */
export type DocumentKind = 'ocr' | 'summary' | 'describe';

export interface RecordDocumentUsageInput {
  /** The uploader: the person the work is billed to. */
  subject: string;
  artifactId: string | null;
  kind: DocumentKind;
  pages?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** Writes one row. A failed write is logged and never fails the work it describes. */
export async function recordDocumentUsage(input: RecordDocumentUsageInput): Promise<void> {
  try {
    await getDataStore().usage.recordDocument({
      subject: input.subject,
      artifactId: input.artifactId,
      kind: input.kind,
      pages: Math.max(0, Math.round(input.pages ?? 0)),
      inputTokens: Math.max(0, Math.round(input.inputTokens ?? 0)),
      outputTokens: Math.max(0, Math.round(input.outputTokens ?? 0)),
    });
  } catch (error) {
    logger.warn('document usage not recorded', {
      component: 'web/document-usage',
      subject: input.subject,
      artifactId: input.artifactId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface DocumentTotals {
  /** OCR reads run, and the pages those reads went over. */
  ocrReads: number;
  pages: number;
  /** Summaries written of text a file already had. */
  summaries: number;
  /** Pictures described by the model. */
  pictures: number;
  /** What the model billed for summaries and descriptions. OCR bills pages, not tokens. */
  inputTokens: number;
  outputTokens: number;
}

export const ZERO_DOCUMENT_TOTALS: DocumentTotals = {
  ocrReads: 0,
  pages: 0,
  summaries: 0,
  pictures: 0,
  inputTokens: 0,
  outputTokens: 0,
};

export async function getDocumentTotals(
  span: UsageSpan,
  timeZone: string,
  ownerSubject: string | null = null
): Promise<DocumentTotals> {
  const rows = await getDataStore().usage.documentByKind({ span, timeZone }, ownerSubject);
  const totals: DocumentTotals = { ...ZERO_DOCUMENT_TOTALS };
  for (const row of rows) {
    totals.inputTokens += row.inputTokens;
    totals.outputTokens += row.outputTokens;
    if (row.kind === 'ocr') {
      totals.ocrReads += row.count;
      totals.pages += row.pages;
    } else if (row.kind === 'summary') {
      totals.summaries += row.count;
    } else if (row.kind === 'describe') {
      totals.pictures += row.count;
    }
  }
  return totals;
}
