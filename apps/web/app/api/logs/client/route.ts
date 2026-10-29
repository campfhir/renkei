/**
 * Where the browser reports what went wrong on its side: a failed fetch, a
 * caught error, a render that hit the error boundary. The browser has no
 * logger of its own that reaches storage, so `lib/client-logger.ts` posts
 * here and the line is written through the server's logger with the
 * caller's subject — which is what puts it in their own Activity view.
 *
 * Signed-in only, and the subject comes from the session, never the body.
 * Bodies are bounded and the endpoint is rate limited per person, so a page
 * stuck in an error loop costs a few hundred rows, not the table.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { checkInboundLimit } from '@/lib/inbound-rate-limit';
import { logger } from '@/lib/logger';
import { parseClientLogBody } from '@/lib/client-log-body';

const LIMITS = {
  perClient: { limit: 60, windowMs: 60_000 },
  global: { limit: 3_000, windowMs: 60_000 },
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  // Keyed on the subject rather than the forwarded address: the person is known.
  const verdict = checkInboundLimit('client-logs', `subject:${session.subject}`, LIMITS);
  if (!verdict.allowed) {
    return NextResponse.json(
      { error: 'Too many log lines' },
      { status: 429, headers: { 'Retry-After': String(verdict.retryAfterSeconds) } }
    );
  }

  const body = parseClientLogBody(await request.json().catch(() => null));
  if (!body) return NextResponse.json({ error: 'Malformed log line' }, { status: 400 });

  const fields = {
    ...body.attrs,
    component: `client/${body.component}`,
    subject: session.subject,
    ...(body.page ? { page: body.page } : {}),
    ...(body.stack ? { stack: body.stack } : {}),
    userAgent: request.headers.get('user-agent') ?? undefined,
  };
  if (body.level === 'error') logger.error(body.message, fields);
  else if (body.level === 'warn') logger.warn(body.message, fields);
  else logger.info(body.message, fields);
  return NextResponse.json({ ok: true });
}
