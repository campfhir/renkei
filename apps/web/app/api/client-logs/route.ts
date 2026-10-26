import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { getSessionFromRequest } from '@/lib/session';
import { routeLog } from '@/lib/log-context';

/**
 * Errors the browser reports (lib/client-logs.ts). Anyone may send one, so the
 * body is capped and every field is trimmed; the signed-in person is added
 * from the request's context: the browser, the page and the signed-in person. Answers 204 whatever happens to the
 * record, so reporting never shows the person an error.
 */

export const runtime = 'nodejs';

const MAX_BODY_BYTES = 16_384;
const MAX_FIELD_CHARS = 4_000;

function field(value: unknown): string | undefined {
  return typeof value === 'string' ? value.slice(0, MAX_FIELD_CHARS) : undefined;
}

async function POSTHandler(request: NextRequest): Promise<Response> {
  const text = await request.text().catch(() => '');
  if (text.length > MAX_BODY_BYTES) return new NextResponse(null, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  // Looking up the session records the signed-in person on the request's log
  // context. It decides nothing here: an anonymous report is still written.
  await getSessionFromRequest(request);
  // The page, the browser and the person come from the request's context.
  logger.error('the page hit an error: {message}', {
    component: field(record.component) ?? 'web/client',
    message: field(record.message) ?? 'unknown error',
    stack: field(record.stack),
  });
  return new NextResponse(null, { status: 204 });
}

export const POST = routeLog(POSTHandler);
