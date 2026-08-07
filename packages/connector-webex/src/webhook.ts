/**
 * WebEx webhook mechanics: signature verification and payload parsing.
 *
 * WebEx signs each delivery with HMAC-SHA1 of the raw body using the secret
 * chosen at webhook registration, sent as the X-Spark-Signature header.
 * Verification runs over the RAW body string — re-serializing parsed JSON
 * would change byte order and break the digest.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

export function verifyWebexSignature(rawBody: string, signature: string, secret: string): boolean {
  if (!signature || !secret) return false;

  const expected = createHmac('sha1', secret).update(rawBody, 'utf8').digest('hex');
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(signature.trim().toLowerCase(), 'utf8');
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

/** The `${resource}.${event}` type the events pipeline routes on. */
export const WEBEX_MESSAGE_CREATED = 'messages.created';

export interface WebexWebhookEvent {
  /** `${resource}.${event}`, e.g. 'messages.created'. */
  type: string;
  resource: string;
  event: string;
  /** The resource's id — for messages, the message id to fetch. */
  dataId: string;
  roomId: string | null;
  personId: string | null;
  personEmail: string | null;
  /** The raw webhook `data` object, kept whole on the event row. */
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
export function parseWebhookPayload(body: unknown): Result<WebexWebhookEvent, 'INVALID_PAYLOAD'> {
  if (!isRecord(body)) return err('INVALID_PAYLOAD' as const);

  const { resource, event, data } = body;
  if (typeof resource !== 'string' || typeof event !== 'string' || !isRecord(data)) {
    return err('INVALID_PAYLOAD' as const);
  }
  const dataId = data.id;
  if (typeof dataId !== 'string' || dataId.length === 0) {
    return err('INVALID_PAYLOAD' as const);
  }

  return ok({
    type: `${resource}.${event}`,
    resource,
    event,
    dataId,
    roomId: optionalString(data.roomId),
    personId: optionalString(data.personId),
    personEmail: optionalString(data.personEmail),
    data,
  });
}
