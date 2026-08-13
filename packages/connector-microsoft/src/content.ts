/**
 * Downloading a drive item's bytes — the one thing graphRequest structurally
 * cannot do (it forces `Accept: application/json` and calls `response.json()`,
 * so a PDF comes back as "Graph API returned no JSON").
 *
 * Two properties of Graph's download surface shape this file:
 *
 * 1. `GET /drives/{d}/items/{i}/content` answers **302** to a pre-authenticated
 *    URL on a different host. That URL must NOT receive our Authorization
 *    header — it carries its own credential, it is a different origin, and
 *    Azure blob endpoints reject requests bearing both. Node's fetch strips
 *    cross-origin auth headers on redirect in recent undici, but that is
 *    version-dependent and far too load-bearing to inherit silently, so the
 *    redirect is followed manually with a bare second request.
 *
 * 2. The preferred path avoids the redirect altogether: asking for the item
 *    with `$select=@microsoft.graph.downloadUrl` returns the same
 *    pre-authenticated URL inside ordinary JSON, and returns the item's
 *    current `cTag`/`size` in the very same call the caller needs anyway for
 *    change detection. One round trip, no redirect semantics to get wrong.
 *
 * The size ceiling is enforced TWICE — from the item's declared size before
 * any transfer, and again while streaming. A missing or lying Content-Length
 * must not be able to exhaust the worker's heap.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { TokenBucket } from '@renkei/rate-limit';
import { graphRequest, GRAPH_BASE_URL } from './client';

/**
 * Deliberately separate from client.ts's 15s JSON budget: a 25MB file over a
 * slow link legitimately exceeds it, and a download is not an API call whose
 * latency says anything about Graph's health.
 */
const CONTENT_TIMEOUT_MS = 60_000;

/** Anything larger is skipped rather than indexed. */
export const DRIVE_CONTENT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Its own bucket, not client.ts's. The CDN fetch is not a Graph API call and
 * must not spend Graph's rate budget — but a burst of documents still must
 * not open fifty sockets at once.
 */
const downloadLimiter = new TokenBucket({ capacity: 2, refillPerSecond: 2 });

export interface GraphDownloadOptions {
  maxBytes?: number;
  timeoutMs?: number;
}

export interface GraphContent {
  bytes: Uint8Array;
  contentType: string | null;
  /** The item as Graph reported it at download time — cTag, size, name… */
  item: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a body with a hard ceiling, aborting rather than trusting Content-Length. */
async function readCapped(
  response: Response,
  maxBytes: number
): Promise<Result<Uint8Array, 'GRAPH_API_ERROR' | 'CONTENT_TOO_LARGE'>> {
  const body = response.body;
  if (!body) return ok(new Uint8Array(0));

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return err('CONTENT_TOO_LARGE' as const, {
          message: `download exceeded ${maxBytes} bytes`,
        });
      }
      chunks.push(value);
    }
  } catch {
    return err('GRAPH_API_ERROR' as const, { message: 'download interrupted' });
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return ok(bytes);
}

/** Fetch a pre-authenticated URL with NO Authorization header. */
async function fetchUnauthenticated(
  url: string,
  maxBytes: number,
  timeoutMs: number
): Promise<
  Result<{ bytes: Uint8Array; contentType: string | null }, 'GRAPH_API_ERROR' | 'CONTENT_TOO_LARGE'>
> {
  await downloadLimiter.take();
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return err('GRAPH_API_ERROR' as const, {
      message: timedOut ? `download timed out after ${timeoutMs}ms` : 'download unreachable',
    });
  }
  if (!response.ok) {
    return err('GRAPH_API_ERROR' as const, {
      message: `download failed with ${response.status}`,
      cause: response.status,
    });
  }

  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    return err('CONTENT_TOO_LARGE' as const, {
      message: `declared size ${declared} exceeds ${maxBytes} bytes`,
    });
  }

  const read = await readCapped(response, maxBytes);
  if (!read.ok) return read;
  return ok({ bytes: read.val, contentType: response.headers.get('content-type') });
}

/**
 * Download one drive item's bytes, plus the item metadata as of this moment.
 *
 * The caller must persist the cTag from `item`, never the one it already had:
 * the file can change between a sync round and this download, and recording
 * the older tag would mean skipping a version that was never indexed.
 */
export async function graphDownload(
  accessToken: string,
  driveId: string,
  itemId: string,
  options?: GraphDownloadOptions
): Promise<Result<GraphContent, 'GRAPH_API_ERROR' | 'CONTENT_TOO_LARGE'>> {
  const maxBytes = options?.maxBytes ?? DRIVE_CONTENT_MAX_BYTES;
  const timeoutMs = options?.timeoutMs ?? CONTENT_TIMEOUT_MS;
  const base = `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`;

  const metadata = await graphRequest(
    accessToken,
    `${base}?$select=id,name,size,file,cTag,eTag,lastModifiedDateTime,webUrl,@microsoft.graph.downloadUrl`
  );
  if (!metadata.ok) return metadata;
  const item = isRecord(metadata.val) ? metadata.val : {};

  // Refuse before transferring anything when Graph already told us it is too big.
  const size = typeof item.size === 'number' ? item.size : null;
  if (size !== null && size > maxBytes) {
    return err('CONTENT_TOO_LARGE' as const, {
      message: `item size ${size} exceeds ${maxBytes} bytes`,
    });
  }

  const downloadUrl = item['@microsoft.graph.downloadUrl'];
  if (typeof downloadUrl === 'string' && downloadUrl) {
    const fetched = await fetchUnauthenticated(downloadUrl, maxBytes, timeoutMs);
    if (!fetched.ok) return fetched;
    return ok({ bytes: fetched.val.bytes, contentType: fetched.val.contentType, item });
  }

  // Fallback: /content, following the 302 by hand so the pre-authenticated
  // target never sees our bearer token.
  await downloadLimiter.take();
  let redirect: Response;
  try {
    redirect = await fetch(`${GRAPH_BASE_URL}${base}/content`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return err('GRAPH_API_ERROR' as const, { message: 'content request failed' });
  }

  const location = redirect.headers.get('location');
  if (redirect.status >= 300 && redirect.status < 400 && location) {
    const fetched = await fetchUnauthenticated(location, maxBytes, timeoutMs);
    if (!fetched.ok) return fetched;
    return ok({ bytes: fetched.val.bytes, contentType: fetched.val.contentType, item });
  }
  if (!redirect.ok) {
    return err('GRAPH_API_ERROR' as const, {
      message: `content request failed with ${redirect.status}`,
      cause: redirect.status,
    });
  }

  // Some drives answer 200 with the bytes inline rather than redirecting.
  const read = await readCapped(redirect, maxBytes);
  if (!read.ok) return read;
  return ok({
    bytes: read.val,
    contentType: redirect.headers.get('content-type'),
    item,
  });
}
