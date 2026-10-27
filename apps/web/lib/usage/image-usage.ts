/**
 * Reading the image ledger (migration 132) the way the usage pages read
 * the voice ledger: totals over a span in the viewer's zone, org-wide or
 * for one person, and everyone's totals for the leaderboard of who draws
 * the most (by the bytes of the pictures kept, with the tokens the
 * provider billed beside it).
 */

import { getDataStore } from '@renkei/db';
import { labelOf, labelsBySubject } from './org-usage';
import type { UsageSpan } from './user-utilization';
import type { ImageUserRow } from './image-window';

export interface ImageTotals {
  /** Pictures drawn. */
  images: number;
  /** The files as kept. */
  bytes: number;
  /** What the provider billed, where it reports tokens (gpt-image does, FLUX does not). */
  inputTokens: number;
  outputTokens: number;
}

export const ZERO_IMAGE_TOTALS: ImageTotals = {
  images: 0,
  bytes: 0,
  inputTokens: 0,
  outputTokens: 0,
};

export async function getImageTotals(
  span: UsageSpan,
  timeZone: string,
  ownerSubject: string | null = null
): Promise<ImageTotals> {
  return getDataStore().usage.imageTotals({ span, timeZone }, ownerSubject);
}

/** Everyone who had an image drawn in the span; unranked. */
export async function getImageUsers(span: UsageSpan, timeZone: string): Promise<ImageUserRow[]> {
  const [usage, labels] = await Promise.all([
    getDataStore().usage.imageBySubject({ span, timeZone }),
    labelsBySubject(),
  ]);
  return usage.map((row) => ({
    subject: row.subject,
    label: labelOf(labels, row.subject),
    images: row.images,
    bytes: row.bytes,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
  }));
}
