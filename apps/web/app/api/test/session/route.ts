/**
 * Sign-in for the browser suite (playwright.config.ts): the one
 * thing a spec cannot do through the app's own routes, because OIDC needs
 * an identity provider. Everything else a spec stages through the REST
 * routes the UI calls.
 *
 *   POST { roles?, displayName?, email? }
 *     → 200 { subject, sessionId }, with the session cookie set
 *
 * A fresh subject every call, recorded the way the OIDC callback records
 * one (lib/identity.ts's upsertIdentity, then lib/session.ts's
 * createSession). Roles default to ['renkei-user']; the email defaults to
 * the subject.
 *
 * Answers 404 — as if it did not exist — unless this process runs on the
 * memory store (RENKEI_DATA_STORE=memory, see instrumentation.ts) AND the
 * request carries RENKEI_MEMORY_SEED_TOKEN in `x-renkei-seed-token`.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getMemoryDataStore } from '@renkei/db';
import { upsertIdentity } from '@/lib/identity';
import {
  SESSION_TTL_SECONDS,
  createSession,
  sessionCookieName,
  sessionCookieOptions,
} from '@/lib/session';
import { logger } from '@/lib/logger';

const TOKEN_HEADER = 'x-renkei-seed-token';
const MAX_ROLES = 16;

function authorized(request: NextRequest): boolean {
  const expected = process.env.RENKEI_MEMORY_SEED_TOKEN ?? '';
  if (!getMemoryDataStore() || expected.length === 0) return false;
  const a = Buffer.from(request.headers.get(TOKEN_HEADER) ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!authorized(request)) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body: unknown = await request.json().catch(() => ({}));
  const input: { roles?: unknown; displayName?: unknown; email?: unknown } =
    typeof body === 'object' && body !== null ? body : {};
  const roles = Array.isArray(input.roles)
    ? input.roles.filter((role): role is string => typeof role === 'string').slice(0, MAX_ROLES)
    : ['renkei-user'];
  const subject = `e2e-${randomUUID()}@example.test`;
  const email = stringOf(input.email) ?? subject;
  const displayName = stringOf(input.displayName);

  const recorded = await upsertIdentity(subject, { email, displayName, idpGroups: [] });
  if (!recorded.ok) {
    logger.error('Could not record: {error}', {
      component: 'api/test/session',
      error: recorded.err.message ?? recorded.err.type,
    });
    return NextResponse.json({ error: 'Could not record' }, { status: 500 });
  }
  const session = await createSession(subject, roles, SESSION_TTL_SECONDS);
  if (!session.ok) {
    logger.error('Could not sign in: {error}', {
      component: 'api/test/session',
      error: session.err.message ?? session.err.type,
    });
    return NextResponse.json({ error: 'Could not sign in' }, { status: 500 });
  }

  const response = NextResponse.json({ subject, sessionId: session.val.id });
  response.cookies.set(
    sessionCookieName(),
    session.val.id,
    sessionCookieOptions(SESSION_TTL_SECONDS)
  );
  return response;
}
