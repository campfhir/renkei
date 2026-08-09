import { getLogShipping } from '@/lib/log-ingest';
import { logger } from '@/lib/logger';

/**
 * Ingest endpoint for e2e-encrypted log shipping — the worker (and any future
 * application) POSTs sealed batches here; verified records land in the logs
 * table with the shipper's own application/version. Auth is the shared
 * LOG_SHIP_API_KEY bearer gate; the sibling /api/logs/register endpoint
 * completes the pipeline.
 */
export async function POST(request: Request): Promise<Response> {
  const shipping = await getLogShipping();
  if (!shipping) return new Response(null, { status: 503 });

  const response = await shipping.ingest(request);
  if (response.status === 401) {
    logger.warn('log shipment rejected: bad or missing API key', {
      component: 'web/log-ingest',
      ip: request.headers.get('x-forwarded-for') ?? undefined,
    });
  }
  return response;
}
