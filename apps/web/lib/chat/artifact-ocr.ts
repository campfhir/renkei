/**
 * OCR on request for a library file: a scan or an image the chat upload
 * left as needs_ocr, or a file whose OCR failed. The owner asks for it from
 * the Artifacts page; the run goes in the background (Next's `after()`), the
 * text is sealed under the file's own key as it is for chat uploads, and
 * the digest is written from it, which is what search reads.
 *
 * Progress is the run's start (artifacts.ocr_started_at), and the estimate
 * is built from the timings of runs that finished (artifact-ocr-estimate.ts).
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { getOrgSettings } from '@renkei/settings';
import { resolveMistralOcrConfig } from '@renkei/connector-mistral-ocr';
import { logger } from '@/lib/logger';
import { createOutboundRedactor } from '@/lib/chat/outbound-redaction';
import { artifactCipher, type ArtifactAccess } from './artifact-access';
import { digestPendingArtifacts } from './artifact-digest';
import { getAttachments, isOcrCandidate, ocrOne } from './attachments';
import { estimateOcrRemaining, type OcrEstimate, type OcrSample } from './artifact-ocr-estimate';

/** A run that has not finished in this long is treated as dead, and may be started again. */
export const OCR_STALE_MS = 15 * 60_000;
/** The most recent finished runs the estimate reads. */
const OCR_SAMPLE_LIMIT = 200;

export type OcrRefusal = 'unsupported' | 'unconfigured' | 'running';

/** Whether OCR can be asked for this file now, and if not, why not. */
export function ocrRefusalFor(access: ArtifactAccess): OcrRefusal | null {
  const row = access.row;
  if (!isOcrCandidate(row.filename, row.contentType)) return 'unsupported';
  return null;
}

/**
 * Marks the file as being read, if nothing else is reading it. The update
 * is conditional, so two requests at once start one run between them.
 */
export async function claimArtifactOcr(
  db: Kysely<DB>,
  artifactId: string
): Promise<OcrRefusal | null> {
  if (!(await resolveMistralOcrConfig()).ok) return 'unconfigured';
  const now = new Date();
  const claimed = await db
    .updateTable('artifacts')
    .set({ ocr_started_at: now, updated_at: now })
    .where('id', '=', artifactId)
    .where((eb) =>
      eb.or([
        eb('ocr_started_at', 'is', null),
        eb('ocr_started_at', '<', new Date(now.getTime() - OCR_STALE_MS)),
      ])
    )
    .executeTakeFirst();
  return Number(claimed.numUpdatedRows) > 0 ? null : 'running';
}

async function clearStart(db: Kysely<DB>, artifactId: string): Promise<void> {
  await db
    .updateTable('artifacts')
    .set({ ocr_started_at: null, updated_at: new Date() })
    .where('id', '=', artifactId)
    .execute();
}

/**
 * Reads one file the viewer owns, then digests it. Runs after the response
 * that asked for it; nothing here reports back except the file's own state.
 */
export async function runArtifactOcr(
  db: Kysely<DB>,
  artifactId: string,
  viewerSubject: string
): Promise<void> {
  try {
    const [row] = await getAttachments(db, [artifactId]);
    if (!row) return;
    const cipher = await artifactCipher(db, row, viewerSubject, 'owner', null);
    if (cipher.unavailable) {
      await clearStart(db, artifactId);
      return;
    }
    const settings = await getOrgSettings();
    const status = await ocrOne(
      db,
      row,
      settings.ok ? createOutboundRedactor(settings.val) : null,
      cipher
    );
    if (status === 'done') {
      await digestPendingArtifacts(db, viewerSubject, await getAttachments(db, [artifactId]));
    }
  } catch (error) {
    logger.warn('artifact OCR failed: {message}', {
      component: 'chat/artifact-ocr',
      message: error instanceof Error ? error.message : String(error),
    });
    await clearStart(db, artifactId).catch(() => undefined);
  }
}

/** The finished runs the estimate is built from, org-wide: timings and sizes, never text. */
export async function ocrSamples(db: Kysely<DB>): Promise<OcrSample[]> {
  const rows = await db
    .selectFrom('artifacts')
    .select(['size_bytes', 'ocr_millis'])
    .where('ocr_millis', 'is not', null)
    .orderBy('ocr_finished_at', 'desc')
    .limit(OCR_SAMPLE_LIMIT)
    .execute();
  return rows.map((row) => ({ sizeBytes: Number(row.size_bytes), millis: row.ocr_millis ?? 0 }));
}

export interface OcrRun {
  startedAt: string;
  elapsedMs: number;
  /** A run past the stale window: shown as stalled, and it can be started again. */
  stalled: boolean;
  estimate: OcrEstimate;
}

/** What a library row says about its OCR run now, or null when none is in flight. */
export function ocrRunFor(
  startedAt: Date | null,
  sizeBytes: number,
  samples: OcrSample[],
  now: number = Date.now()
): OcrRun | null {
  if (!startedAt) return null;
  const elapsedMs = Math.max(0, now - startedAt.getTime());
  return {
    startedAt: startedAt.toISOString(),
    elapsedMs,
    stalled: elapsedMs > OCR_STALE_MS,
    estimate: estimateOcrRemaining(samples, sizeBytes, elapsedMs),
  };
}
