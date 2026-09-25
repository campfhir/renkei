/**
 * Bitbucket webhook delivery verification
 * (app/api/webhooks/bitbucket/[tenantId]/route.ts): Bitbucket Cloud
 * does not sign deliveries, so a repository webhook is registered by
 * hand with a `?secret=` query parameter on its URL, checked here
 * against the same value stored on the Bitbucket connector.
 */

import { timingSafeEqual } from 'node:crypto';

export function verifyBitbucketSecret(provided: string | null, secret: string): boolean {
  if (!provided || !secret) return false;
  const left = Buffer.from(provided, 'utf8');
  const right = Buffer.from(secret, 'utf8');
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}
