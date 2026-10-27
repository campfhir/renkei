/**
 * Reading the image ledger (migration 132) the way the usage pages read
 * the voice ledger: totals over a span in the viewer's zone, org-wide or
 * for one person, and everyone's totals for the leaderboard of who draws
 * the most (by the bytes of the pictures kept, with the tokens the
 * provider billed beside it).
 */

import { getDataStore } from '@renkei/db';
import { spanWindow, type UsageSpan } from './user-utilization';
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
  return getDataStore().usageLedgers.imageTotals({
    window: spanWindow(span, timeZone),
    subject: ownerSubject,
  });
}

/** Everyone who had an image drawn in the span; unranked. */
export async function getImageUsers(span: UsageSpan, timeZone: string): Promise<ImageUserRow[]> {
  const store = getDataStore();
  const [usage, identities] = await Promise.all([
    store.usageLedgers.imageBySubject({ window: spanWindow(span, timeZone) }),
    store.identities.list(),
  ]);
  const identityBySubject = new Map(identities.map((row) => [row.subject, row]));
  return usage.map((row) => {
    const identity = identityBySubject.get(row.subject);
    return {
      subject: row.subject,
      label: identity?.displayName || identity?.email || row.subject,
      images: row.images,
      bytes: row.bytes,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
    };
  });
}
