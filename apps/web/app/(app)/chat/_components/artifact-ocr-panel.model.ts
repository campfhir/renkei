/**
 * What the OCR part of a file's details says (artifact-ocr-panel.tsx):
 * whether a read can be asked for, what the offer and its button say,
 * and, while a read is in flight, how far it has got and what the
 * estimate says is left. The panel holds the clock (a snapshot of the
 * run and a local tick between the page's refreshes) and passes the time
 * since the snapshot in; everything it shows from that is here, and
 * tested in artifact-ocr-panel.model.test.ts.
 */

import type { LibraryItem } from '@/lib/chat/artifact-library';
import { MIN_SAMPLES } from '@/lib/chat/artifact-ocr-estimate';

/** The progress bar never reaches the end on the estimate alone: the server says when it is done. */
const PROGRESS_CAP = 95;

type OcrItem = Pick<
  LibraryItem,
  'ocrSupported' | 'ocr' | 'extractStatus' | 'contentType' | 'filename' | 'ocrPages'
>;

/** A file OCR can read that has no read in flight. */
export function canRunOcr(item: Pick<LibraryItem, 'ocrSupported' | 'ocr'>): boolean {
  return item.ocrSupported && item.ocr === null;
}

/** The text's name: the file's own, without its extension, as the text route names it. */
export function textFilename(filename: string): string {
  return `${filename.replace(/\.[^.]+$/, '') || 'file'}.txt`;
}

/** OCR has read the file already: its text is there, and a read again replaces it. */
export function alreadyRead(item: Pick<LibraryItem, 'extractStatus'>): boolean {
  return item.extractStatus === 'done';
}

/** “45 s”, “2 min”, “1 min 12 s”. */
export function durationLabel(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

export interface OcrProgress {
  /** How full the bar is (0–95), or null when there is no estimate to measure against. */
  percent: number | null;
  /** "Reading the scan · 12 s so far". */
  sofar: string;
  /** What the estimate says. */
  estimate: string;
}

/** A read in flight, `sinceSnapshotMs` after the page's snapshot of it. */
export function ocrProgress(
  run: NonNullable<LibraryItem['ocr']>,
  sinceSnapshotMs: number
): OcrProgress {
  const elapsed = run.elapsedMs + sinceSnapshotMs;
  const { estimate } = run;
  const remaining =
    estimate.remainingMs === null ? null : Math.max(0, estimate.remainingMs - sinceSnapshotMs);
  const percent =
    estimate.totalMs && estimate.totalMs > 0
      ? Math.min(PROGRESS_CAP, (elapsed / estimate.totalMs) * 100)
      : null;
  return {
    percent,
    sofar: `Reading the scan · ${durationLabel(elapsed)} so far`,
    estimate: estimate.overdue
      ? `Taking longer than the ${estimate.basedOn} similar files before it.`
      : remaining !== null
        ? `About ${durationLabel(remaining)} left, from ${estimate.basedOn} similar files.`
        : `No estimate yet: it needs ${MIN_SAMPLES} finished reads of similar files, and there are ${estimate.basedOn} so far.`,
  };
}

/**
 * A picture is described from its own bytes, so it is never "waiting for
 * OCR" as far as the person is concerned: OCR only adds any text in it.
 */
export function isPicture(contentType: string): boolean {
  return contentType.startsWith('image/');
}

export interface OcrOffer {
  /** "Read 2 pages by OCR.", once a read has finished. */
  pages: string | null;
  /** Whether the text can be downloaded (the file has been read). */
  download: boolean;
  explanation: string;
  button: string;
}

/** The offer for a file that can be read, or null when the panel shows none. */
export function ocrOffer(item: OcrItem): OcrOffer | null {
  if (!canRunOcr(item)) return null;
  const read = alreadyRead(item);
  return {
    pages:
      item.ocrPages !== null
        ? `Read ${item.ocrPages} ${item.ocrPages === 1 ? 'page' : 'pages'} by OCR.`
        : null,
    download: read,
    explanation: read
      ? 'The full text is read. A read again replaces it with a fresh OCR of the file.'
      : isPicture(item.contentType)
        ? 'OCR reads any text in this picture. Its description is written from the picture itself.'
        : 'OCR reads the full text of this file, for the assistant and for people, including scans and pages a text layer misses.',
    button: read
      ? 'Read again with OCR'
      : item.extractStatus === 'ocr_failed'
        ? 'Try OCR again'
        : 'Run OCR',
  };
}
