/**
 * The document ledger (migration 168): what work the model and the OCR
 * connector did on files a person uploaded. Written by the artifact digest
 * and the OCR run, attributed to the uploader, never to whoever happened to
 * view the file. Read by the usage pages the way the image ledger is read:
 * totals over a span in the viewer's zone, org-wide or for one person.
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { logger } from '@/lib/logger';
import { inSpan, type UsageSpan } from './user-utilization';

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
export async function recordDocumentUsage(
  db: Kysely<DB>,
  input: RecordDocumentUsageInput
): Promise<void> {
  try {
    await db
      .insertInto('document_usage')
      .values({
        subject: input.subject,
        artifact_id: input.artifactId,
        kind: input.kind,
        pages: Math.max(0, Math.round(input.pages ?? 0)),
        input_tokens: Math.max(0, Math.round(input.inputTokens ?? 0)),
        output_tokens: Math.max(0, Math.round(input.outputTokens ?? 0)),
      })
      .execute();
  } catch (error) {
    logger.warn('document usage not recorded', {
      component: 'web/document-usage',
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

interface KindRow {
  kind: string;
  count: string;
  pages: string;
  input_tokens: string;
  output_tokens: string;
}

/** `AND subject = <subject>` when scoped, nothing when org-wide. */
function ownedBy(ownerSubject: string | null) {
  return ownerSubject === null ? sql`` : sql`AND subject = ${ownerSubject}`;
}

export async function getDocumentTotals(
  db: Kysely<DB>,
  span: UsageSpan,
  timeZone: string,
  ownerSubject: string | null = null
): Promise<DocumentTotals> {
  const result = await sql<KindRow>`
    SELECT kind,
           COUNT(*) AS count,
           COALESCE(SUM(pages), 0) AS pages,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens
    FROM document_usage
    WHERE ${inSpan('created_at', span, timeZone)}
      ${ownedBy(ownerSubject)}
    GROUP BY kind
  `.execute(db);
  const totals: DocumentTotals = { ...ZERO_DOCUMENT_TOTALS };
  for (const row of result.rows) {
    const count = Number(row.count);
    totals.inputTokens += Number(row.input_tokens);
    totals.outputTokens += Number(row.output_tokens);
    if (row.kind === 'ocr') {
      totals.ocrReads += count;
      totals.pages += Number(row.pages);
    } else if (row.kind === 'summary') {
      totals.summaries += count;
    } else if (row.kind === 'describe') {
      totals.pictures += count;
    }
  }
  return totals;
}
