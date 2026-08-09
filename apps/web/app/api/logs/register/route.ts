import { getLogShipping } from '@/lib/log-ingest';
import { logger } from '@/lib/logger';

/**
 * E2E client registration for log shipping: a shipper POSTs its ECDSA public
 * signing key, the server answers with its ECDH public encryption key. The
 * path is the HttpAdapter's default guess (`<endpoint>/register`).
 *
 * Registration is trust-on-first-use, so it sits behind the SAME bearer gate
 * as ingest — plus bored-logs' key pinning: a registered clientId can only
 * re-register with the key it already holds (409 otherwise).
 */
export async function POST(request: Request): Promise<Response> {
  const shipping = await getLogShipping();
  if (!shipping) return new Response(null, { status: 503 });

  const response = await shipping.register(request);
  if (response.status === 401) {
    logger.warn('log shipper registration rejected: bad or missing API key', {
      component: 'web/log-ingest',
      ip: request.headers.get('x-forwarded-for') ?? undefined,
    });
  }
  return response;
}
