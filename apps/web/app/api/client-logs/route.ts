import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { getSessionFromRequest } from '@/lib/session';

/**
 * Errors the browser reports (lib/client-logs.ts). Anyone may send one, so the
 * body is capped and every field is trimmed; the signed-in person is added
 * from their session when there is one. Answers 204 whatever happens to the
 * record, so reporting never shows the person an error.
 */

export const runtime = 'nodejs';

const MAX_BODY_BYTES = 16_384;
const MAX_FIELD_CHARS = 4_000;

function field(value: unknown): string | undefined {
  return typeof value === 'string' ? value.slice(0, MAX_FIELD_CHARS) : undefined;
}

export async function POST(request: NextRequest): Promise<Response> {
  const text = await request.text().catch(() => '');
  if (text.length > MAX_BODY_BYTES) return new NextResponse(null, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const session = await getSessionFromRequest(request);
  logger.error('the page hit an error: {message}', {
    component: field(record.component) ?? 'web/client',
    message: field(record.message) ?? 'unknown error',
    stack: field(record.stack),
    page: field(record.page),
    browserAgent: field(record.browserAgent) ?? request.headers.get('user-agent') ?? undefined,
    user: session?.subject,
  });
  return new NextResponse(null, { status: 204 });
}
