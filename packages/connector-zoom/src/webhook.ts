/**
 * Zoom webhook mechanics: signature verification, endpoint URL validation,
 * and payload parsing.
 *
 * Zoom signs each delivery as `v0=` + HMAC-SHA256 of `v0:{timestamp}:{raw
 * body}` with the app's secret token, sent in x-zm-signature alongside
 * x-zm-request-timestamp. Verification runs over the RAW body string —
 * re-serializing parsed JSON would change byte order and break the digest.
 * Because the timestamp is part of the signed message, checking it against
 * the clock (Zoom documents a 5-minute window) also defeats replay of a
 * captured delivery: an old timestamp is rejected, and a rewritten one no
 * longer matches the signature.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

/** Zoom's documented replay window: reject deliveries older than 5 minutes. */
const REPLAY_WINDOW_MS = 300_000;

export function verifyZoomSignature(
  rawBody: string,
  signatureHeader: string | null,
  timestampHeader: string | null,
  secretToken: string,
  nowMs: number = Date.now()
): boolean {
  if (!signatureHeader || !timestampHeader || !secretToken) return false;

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(nowMs - timestamp * 1000) > REPLAY_WINDOW_MS) return false;

  const expected =
    'v0=' +
    createHmac('sha256', secretToken)
      .update(`v0:${timestampHeader}:${rawBody}`, 'utf8')
      .digest('hex');
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(signatureHeader.trim().toLowerCase(), 'utf8');
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

/**
 * Answer Zoom's endpoint.url_validation challenge: echo the plainToken with
 * its HMAC-SHA256 under the secret token. Zoom re-validates periodically, so
 * the receiving endpoint must keep answering this for its whole life, not
 * just at registration.
 */
export function buildUrlValidationResponse(
  plainToken: string,
  secretToken: string
): { plainToken: string; encryptedToken: string } {
  return {
    plainToken,
    encryptedToken: createHmac('sha256', secretToken).update(plainToken, 'utf8').digest('hex'),
  };
}

export interface ZoomWebhookEvent {
  /** Zoom's event name, e.g. 'recording.transcript_completed'. */
  type: string;
  hostId: string | null;
  hostEmail: string | null;
  /** The meeting's (recurring, reusable) numeric id, as a string. */
  meetingId: string | null;
  /** The meeting INSTANCE uuid — may contain '/', '=', '+'. */
  meetingUuid: string | null;
  /** Short-lived token some events carry for fetching the referenced asset. */
  downloadToken: string | null;
  /** The raw `payload.object`, kept whole on the event row. */
  data: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Narrow a parsed webhook body to the fields the pipeline needs. Returns an
 * error rather than throwing: a malformed body is a caller problem to report
 * with a 400, not a crash.
 */
export function parseZoomWebhookPayload(
  body: unknown
): Result<ZoomWebhookEvent, 'INVALID_PAYLOAD'> {
  if (!isRecord(body)) return err('INVALID_PAYLOAD' as const);

  const event = body.event;
  if (typeof event !== 'string' || event.length === 0) {
    return err('INVALID_PAYLOAD' as const);
  }

  const payload = isRecord(body.payload) ? body.payload : {};
  const object = isRecord(payload.object) ? payload.object : {};

  // Zoom sends the meeting id as a JSON number; keep it as a string so it
  // survives as an identifier, not arithmetic.
  const rawId = object.id;
  const meetingId =
    typeof rawId === 'string' && rawId.length > 0
      ? rawId
      : typeof rawId === 'number'
        ? String(rawId)
        : null;

  return ok({
    type: event,
    hostId: optionalString(object.host_id),
    hostEmail: optionalString(object.host_email),
    meetingId,
    meetingUuid: optionalString(object.uuid),
    downloadToken: optionalString(body.download_token),
    data: object,
  });
}

/**
 * The one event whose substance lives in `payload` directly instead of
 * `payload.object`: endpoint.url_validation carries payload.plainToken.
 * Kept as a separate narrow helper so ZoomWebhookEvent doesn't grow a field
 * that is null on every real event.
 */
export function urlValidationTokenOf(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const payload = body.payload;
  if (!isRecord(payload)) return null;
  return optionalString(payload.plainToken);
}
