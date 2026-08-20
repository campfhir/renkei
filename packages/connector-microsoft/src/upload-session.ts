/**
 * Graph upload sessions — the large-file write path. The simple endpoints
 * top out early (drive PUT :/content at 4MB, message attachment POST at
 * ~3MB); past that Graph requires createUploadSession + sequential
 * Content-Range PUTs. One generic runner covers both variants — callers
 * supply the createUploadSession path and body:
 *
 *   drive item:  POST /drives/{driveId}/items/{parentId}:/{name}:/createUploadSession
 *                { item: { '@microsoft.graph.conflictBehavior': … } }
 *   message att: POST /me/messages/{id}/attachments/createUploadSession
 *                { AttachmentItem: { attachmentType: 'file', name, size } }
 *
 * The session's uploadUrl is PRE-AUTHORIZED — chunks are PUT to it with NO
 * Authorization header (Graph rejects one on some session hosts). Chunks
 * must be multiples of 320 KiB except the last; 5 MiB (16 × 320 KiB) keeps
 * the request count low without long single PUTs.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { graphRequest, type GraphRequestOptions } from './client';

/** 16 × 320KiB — Graph requires non-final chunks be 320KiB multiples. */
export const UPLOAD_SESSION_CHUNK_BYTES = 16 * 320 * 1024;

/** Per-chunk transfer budget; a 5MiB chunk on a slow uplink is minutes-safe. */
const CHUNK_TIMEOUT_MS = 120_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function graphUploadViaSession(
  accessToken: string,
  createSessionPath: string,
  createSessionBody: unknown,
  bytes: Uint8Array,
  options?: GraphRequestOptions & { chunkBytes?: number }
): Promise<Result<Record<string, unknown>, 'GRAPH_API_ERROR'>> {
  const session = await graphRequest(accessToken, createSessionPath, {
    method: 'POST',
    body: JSON.stringify(createSessionBody),
    lane: options?.lane,
  });
  if (!session.ok) return session;
  const uploadUrl = isRecord(session.val) ? session.val.uploadUrl : undefined;
  if (typeof uploadUrl !== 'string' || !uploadUrl) {
    return err('GRAPH_API_ERROR' as const, {
      message: 'createUploadSession returned no uploadUrl',
    });
  }

  const chunkBytes = options?.chunkBytes ?? UPLOAD_SESSION_CHUNK_BYTES;
  const total = bytes.byteLength;
  for (let start = 0; start < total; start += chunkBytes) {
    const end = Math.min(start + chunkBytes, total);
    // Copy into a plain-ArrayBuffer view (a subarray of a larger buffer
    // would otherwise upload the whole backing store).
    const chunk = new Uint8Array(end - start);
    chunk.set(bytes.subarray(start, end));

    let response: Response;
    try {
      response = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Length': String(chunk.byteLength),
          'Content-Range': `bytes ${start}-${end - 1}/${total}`,
        },
        body: chunk,
        signal: AbortSignal.timeout(CHUNK_TIMEOUT_MS),
      });
    } catch (error) {
      // Best-effort cancel so Graph does not hold a dangling session.
      await fetch(uploadUrl, { method: 'DELETE' }).catch(() => undefined);
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return err('GRAPH_API_ERROR' as const, {
        message: timedOut
          ? `upload session chunk timed out after ${CHUNK_TIMEOUT_MS}ms`
          : 'upload session unreachable',
      });
    }
    if (!response.ok) {
      await fetch(uploadUrl, { method: 'DELETE' }).catch(() => undefined);
      return err('GRAPH_API_ERROR' as const, {
        message: `upload session chunk answered ${response.status}`,
        cause: response.status,
      });
    }
    if (end === total) {
      // The final PUT answers 200/201 with the created item (drives) or
      // 201 with the attachment; some variants answer with an empty body.
      const parsed: unknown = await response.json().catch(() => ({}));
      return ok(isRecord(parsed) ? parsed : {});
    }
    // Non-final chunks answer 202 with nextExpectedRanges — sequential
    // uploads never need to inspect them.
  }
  return err('GRAPH_API_ERROR' as const, { message: 'upload session sent no bytes' });
}
