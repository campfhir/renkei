/**
 * Timeouts and attachment-payload hygiene for the MCP tool layer's outbound
 * HTTP — deliberately dependency-free. Several tool test suites mock
 * ../common wholesale (it transitively pulls @renkei/db), so anything that
 * must stay REAL under those mocks cannot live there.
 *
 * Every packages/connector-* client already aborts at 15s; the web-side
 * clients (jiraFetch, the Confluence and Graph clients, Outlook's local
 * helpers) historically did not — which is how a stalled upstream turned
 * into a tool call that never returns while the MCP SSE keepalive kept the
 * connection looking healthy forever.
 */

/** Reads and ordinary writes: matches the connector packages' 15s abort. */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Multipart/byte uploads: a 20MB attachment on a slow uplink legitimately
 * takes minutes of transfer; 120s also matches the nginx proxy_read_timeout
 * the deployment docs recommend, so the two layers agree on who gives up.
 */
export const UPLOAD_TIMEOUT_MS = 120_000;

/** A caller-supplied signal wins; otherwise the request gets a deadline. */
export function timeoutSignal(init: RequestInit | undefined, ms: number): AbortSignal {
  return init?.signal ?? AbortSignal.timeout(ms);
}

/** AbortSignal.timeout aborts with a TimeoutError; plain aborts do not. */
export function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

export type DecodedAttachment =
  | { ok: true; buffer: Buffer<ArrayBuffer> }
  | { ok: false; error: string };

/**
 * Base64 attachment payload → Buffer, strictly. Buffer.from(x, 'base64')
 * never throws — it silently drops what it cannot decode, which turns a
 * data: URL prefix or a truncated payload into a CORRUPT file rather than
 * an error. So: strip an optional data:*;base64, prefix (models send those;
 * the schema docs promise they are accepted), drop whitespace (models wrap
 * base64 in newlines), then validate the alphabet and padding before
 * decoding. Size caps stay at the call sites — they are org-configurable.
 */
export function decodeBase64Attachment(input: string): DecodedAttachment {
  let text = input.trim();
  if (text.startsWith('data:')) {
    const prefix = /^data:[^,]*;base64,/i.exec(text);
    if (!prefix) {
      return {
        ok: false,
        error: 'The data: URL is not base64-encoded — send the bytes as base64.',
      };
    }
    text = text.slice(prefix[0].length);
  }
  const clean = text.replace(/\s+/g, '');
  if (!clean || clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
    return {
      ok: false,
      error:
        'contentBase64 is not valid base64 (check for truncation, or a data: URL that is not base64-encoded).',
    };
  }
  return { ok: true, buffer: Buffer.from(clean, 'base64') };
}

/**
 * The schema-level character budget for a base64 field carrying at most
 * maxBytes of decoded content — 4/3 inflation plus headroom for a data:
 * prefix and padding.
 */
export function base64LengthFor(maxBytes: number): number {
  return Math.ceil(maxBytes / 3) * 4 + 128;
}
