/**
 * The etag of a file's text: what the code pane's save must match
 * (`If-Match`) for the checkout's file to be overwritten. A hash of the
 * text as read — the same text the pane edits — never of disk bytes, so
 * both sides of the comparison see the file the same way.
 */

import { createHash } from 'node:crypto';

export function etagOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
}
