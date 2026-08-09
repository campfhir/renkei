import { timingSafeEqual } from 'node:crypto';

/**
 * Bearer-key gate for the log-shipping endpoints (/api/logs and
 * /api/logs/register). The same policy fronts both handlers — the bored-logs
 * registration endpoint is trust-on-first-use, so it must never be easier to
 * reach than ingest itself.
 *
 * Keys live in LOG_SHIP_API_KEY, comma-separated so a rotation can overlap
 * (accept old + new, flip the shippers, drop the old). No key configured
 * means shipping is off: fail closed, never open.
 *
 * This is the "API key" leg of the pipeline's auth; an OAuth2
 * client-credentials leg can slot in beside it later — the handlers only see
 * this one boolean.
 */
export function authorizeLogShipment(request: Request): boolean {
  const configured = (process.env.LOG_SHIP_API_KEY ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
  if (configured.length === 0) return false;

  const header = request.headers.get('authorization');
  const match = header?.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const presented = match[1].trim();

  return configured.some((key) => sameKey(presented, key));
}

function sameKey(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Length is not secret (it leaks via the comparison anyway); the contents are.
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
