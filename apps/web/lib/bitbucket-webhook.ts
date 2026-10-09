/**
 * Bitbucket webhook delivery verification
 * (app/api/webhooks/bitbucket/[tenantId]/route.ts): Bitbucket Cloud
 * does not sign deliveries, so a repository webhook is registered by
 * hand carrying a shared secret, checked here against the same value
 * stored on the Bitbucket connector.
 *
 * The secret travels preferably in the `X-Renkei-Webhook-Secret` request
 * header (Bitbucket Cloud lets a webhook carry custom headers), and for
 * compatibility with webhooks registered before the header existed, as a
 * `?secret=` query parameter. The header is preferred because a URL is
 * copied, logged and shown in more places than a header ever is — the
 * proxy's request log redacts webhook queries for exactly that reason
 * (lib/request-log-redaction.ts).
 */

import { timingSafeEqual } from 'node:crypto';

export const BITBUCKET_WEBHOOK_SECRET_HEADER = 'x-renkei-webhook-secret';

/** The secret a delivery presented: header first, then the legacy query parameter. */
export function presentedBitbucketSecret(
  headers: Headers,
  searchParams: URLSearchParams
): string | null {
  const fromHeader = headers.get(BITBUCKET_WEBHOOK_SECRET_HEADER);
  if (fromHeader) return fromHeader;
  return searchParams.get('secret');
}

export function verifyBitbucketSecret(provided: string | null, secret: string): boolean {
  if (!provided || !secret) return false;
  const left = Buffer.from(provided, 'utf8');
  const right = Buffer.from(secret, 'utf8');
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}
