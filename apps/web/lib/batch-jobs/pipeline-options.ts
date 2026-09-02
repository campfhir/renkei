/**
 * Parsing/validating document-ocr-pipeline's two optional behaviours from
 * an untrusted JSON body — the sibling of grouping.ts, shared by the
 * one-off start route, the schedule CRUD routes and the MCP tool so none
 * of them can drift on what's accepted:
 *
 *  - `skipProcessed` (default TRUE, opt-out): consult and maintain the
 *    processed-files ledger so a file is never OCR'd twice.
 *  - `afterProcessing` (default keep, opt-in): what to do with a source
 *    file once its document is staged — delete it, or move it to a folder
 *    on the same or another share.
 *
 * `afterProcessingRefusal` is the consent gate for the second: moving or
 * deleting on a share is exactly what the connection's own "write tools"
 * and "delete tools" choices on the Connectors page cover, so a batch may
 * only do to a share what its owner has already allowed the tools to do
 * there. Checked once, when the batch or schedule is created — the file
 * server still judges every operation with the owner's own credentials.
 */

import type { ConnectedShare } from '@renkei/connector-fileshares';
import type { AfterProcessing } from './start-document-ocr-pipeline';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Absent means on. Anything but a boolean is refused rather than guessed. */
export function parseSkipProcessed(value: unknown): boolean | null {
  if (value === undefined || value === null) return true;
  return typeof value === 'boolean' ? value : null;
}

/**
 * A destination folder: Unix style, rooted, no `..` — the same spelling
 * rule every fileshare boundary enforces, applied before a batch stores
 * it, so a bad path is a 400 now rather than a failed item at 2am.
 */
export function normalizeFolderPath(raw: string): string | null {
  const folded = raw.replace(/\\/g, '/').trim();
  const parts = folded.split('/').filter((part) => part.length > 0);
  if (parts.some((part) => part === '.' || part === '..')) return null;
  return parts.length === 0 ? '/' : `/${parts.join('/')}`;
}

export const AFTER_PROCESSING_SHAPE =
  'afterProcessing must be {action:"keep"}, {action:"delete"} or {action:"move", shareId, path}';

export function parseAfterProcessing(value: unknown): AfterProcessing | null {
  if (value === undefined || value === null) return { action: 'keep' };
  if (!isRecord(value)) return null;
  if (value.action === 'keep') return { action: 'keep' };
  if (value.action === 'delete') return { action: 'delete' };
  if (value.action === 'move') {
    const shareId = typeof value.shareId === 'string' ? value.shareId : '';
    if (!shareId) return null;
    const path = normalizeFolderPath(typeof value.path === 'string' ? value.path : '/');
    if (!path) return null;
    return { action: 'move', shareId, path };
  }
  return null;
}

export const SOURCE_NOT_CONNECTED = 'Unknown file share, or you have not connected it yet';

/**
 * Null when the caller may do this to these shares; otherwise the sentence
 * to refuse with. Also the one place the source share's own connection is
 * required to exist, so every start path shares that check too.
 */
export function afterProcessingRefusal(
  connected: ConnectedShare[],
  sourceShareId: string,
  afterProcessing: AfterProcessing
): string | null {
  const source = connected.find((entry) => entry.share.id === sourceShareId);
  if (!source) return SOURCE_NOT_CONNECTED;
  if (afterProcessing.action === 'keep') return null;

  // Both delete and move remove the source file: that is the "delete
  // tools" consent, which itself presumes "write tools".
  const verb = afterProcessing.action === 'delete' ? 'Deleting' : 'Moving';
  if (source.connection.toolAccess !== 'read_write') {
    return `${verb} source files needs write tools enabled for "${source.share.name}" on the Connectors page`;
  }
  if (!source.connection.allowDelete) {
    return `${verb} source files needs delete tools enabled for "${source.share.name}" on the Connectors page`;
  }
  if (afterProcessing.action === 'delete') return null;

  if (afterProcessing.shareId === sourceShareId) return null;
  const destination = connected.find((entry) => entry.share.id === afterProcessing.shareId);
  if (!destination) return 'The destination share is unknown, or you have not connected it yet';
  if (destination.connection.toolAccess !== 'read_write') {
    return `Moving files there needs write tools enabled for "${destination.share.name}" on the Connectors page`;
  }
  return null;
}
