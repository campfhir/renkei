/**
 * GitHub webhook delivery verification
 * (app/api/webhooks/github/[tenantId]/route.ts): every delivery carries
 * `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw body under
 * the App's Webhook secret>`. Verified over the RAW body string —
 * re-serializing parsed JSON would change byte order and break the
 * digest, the same reasoning packages/connector-zoom/src/webhook.ts
 * documents for Zoom's own signature.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyGitHubSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string
): boolean {
  if (!signatureHeader || !secret) return false;
  const prefix = 'sha256=';
  if (!signatureHeader.startsWith(prefix)) return false;
  const expected = prefix + createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(signatureHeader, 'utf8');
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}
