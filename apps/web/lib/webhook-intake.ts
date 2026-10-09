/**
 * What every inbound webhook route does before it touches the database
 * (app/api/webhooks/*): throttle, check the credential header's shape, and
 * read a bounded body.
 *
 * ORDER MATTERS. These routes are unauthenticated by nature — the provider
 * calls them — so anyone can call them, and the cheapest refusal has to
 * come first. A delivery with no signature header at all is not from the
 * provider; it must be refused before a connector config is decrypted or a
 * tenant row is read, or the route is a free database read for whoever
 * floods it. The body is read only after the header's shape passes, and
 * never past the cap: Content-Length is a claim, so the stream is counted
 * as it arrives and abandoned the moment it exceeds the limit.
 *
 * The shape checks are deliberately coarse — the right length and alphabet
 * for the provider's HMAC — and prove nothing about authenticity. Each
 * route's real verification (verifyGitHubSignature, verifyZoomSignature,
 * …) still runs afterwards against the raw bytes; this only keeps requests
 * that could not possibly verify from costing anything.
 */

import { NextResponse } from 'next/server';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { checkInboundLimit, type RateLimitVerdict } from '@/lib/inbound-rate-limit';

/**
 * Provider payloads are small — a Graph notification batch or a GitHub
 * workflow_run is tens of kilobytes; a megabyte is a generous ceiling that
 * still stops a flood of large bodies from occupying the route.
 */
export const WEBHOOK_MAX_BODY_BYTES = 1_048_576;

/**
 * Per forwarded client address AND per tenant endpoint, both per minute.
 * Keyed by provider + tenant, so one tenant's burst (Graph sends one
 * notification per mailbox change, in bursts) never consumes another's
 * budget. Higher than the voice routes' 120/2,000 because a provider's
 * delivery rate is not a person's typing rate; still far below what a
 * flood produces.
 */
export const WEBHOOK_LIMITS = {
  perClient: { limit: 600, windowMs: 60_000 },
  global: { limit: 6_000, windowMs: 60_000 },
};

export function checkWebhookLimit(
  provider: string,
  tenantId: string,
  request: Request
): RateLimitVerdict {
  return checkInboundLimit(`webhooks/${provider}:${tenantId}`, request, WEBHOOK_LIMITS);
}

/** 429 with Retry-After; the body says nothing about which limit tripped. */
export function tooManyRequests(verdict: RateLimitVerdict): NextResponse {
  return NextResponse.json(
    { error: 'Too many requests' },
    { status: 429, headers: { 'Retry-After': String(verdict.retryAfterSeconds) } }
  );
}

export function payloadTooLarge(): NextResponse {
  return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
}

/** 401 before anything was read: the credential header is absent or could not be a signature. */
export function malformedSignature(): NextResponse {
  return NextResponse.json({ error: 'Missing or malformed signature' }, { status: 401 });
}

/** `X-Hub-Signature-256: sha256=<64 hex>` */
export const GITHUB_SIGNATURE_SHAPE = /^sha256=[0-9a-f]{64}$/i;
/** `x-zm-signature: v0=<64 hex>` */
export const ZOOM_SIGNATURE_SHAPE = /^v0=[0-9a-f]{64}$/i;
/** Zoom's `x-zm-request-timestamp`: epoch seconds. */
export const ZOOM_TIMESTAMP_SHAPE = /^\d{9,11}$/;
/** `x-spark-signature`: hex HMAC-SHA1. */
export const WEBEX_SIGNATURE_SHAPE = /^[0-9a-f]{40}$/i;

/** Whether a header value exists and has the provider's signature shape. */
export function hasSignatureShape(
  value: string | null | undefined,
  shape: RegExp
): value is string {
  return typeof value === 'string' && shape.test(value.trim());
}

/**
 * The raw body as text, or TOO_LARGE. Refused on the declared
 * Content-Length first, then again as the bytes actually arrive — a
 * chunked or lying sender cannot get past the cap by omitting or
 * understating the header.
 */
export async function readWebhookBody(
  request: Request,
  maxBytes: number = WEBHOOK_MAX_BODY_BYTES
): Promise<Result<string, 'TOO_LARGE'>> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) return err('TOO_LARGE' as const);

  const body = request.body;
  if (!body) return ok('');
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return err('TOO_LARGE' as const);
    }
    chunks.push(value);
  }
  return ok(Buffer.concat(chunks).toString('utf8'));
}
