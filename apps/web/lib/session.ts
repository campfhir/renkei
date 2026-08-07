/**
 * Server-side browser sessions.
 *
 * The cookie carries only an opaque random id; subject and roles live in the
 * database. This is deliberate: the previous scheme put roles in an unsigned,
 * non-httpOnly cookie, so a client could self-grant renkei-operator by editing
 * document.cookie. Nothing derived from a session may be read from the cookie.
 */

import { randomUUID } from 'crypto';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { getDatabase } from '@/lib/db';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { logger } from '@/lib/logger';

const COOKIE_PREFIX = 'renkei_session_';

/** Sessions are per-tenant so one browser can hold several without collision. */
export function sessionCookieName(tenantId: string): string {
  return `${COOKIE_PREFIX}${tenantId}`;
}

export interface Session {
  id: string;
  tenantId: string;
  subject: string;
  roles: string[];
  expiresAt: Date;
}

export function sessionCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

export async function createSession(
  tenantId: string,
  subject: string,
  roles: string[],
  ttlSeconds: number
): Promise<Result<Session, 'SESSION_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('SESSION_ERROR' as const);
  const db = dbResult.val;

  const id = randomUUID();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  try {
    await db
      .insertInto('sessions')
      .values({ id, tenant_id: tenantId, subject, roles, expires_at: expiresAt })
      .execute();
  } catch (error) {
    logger.error('[Session] Failed to create session', {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return err('SESSION_ERROR' as const);
  }

  logger.info('[Session] Created', {
    tenantId,
    subject,
    roles,
    expiresAt: expiresAt.toISOString(),
  });
  return ok({ id, tenantId, subject, roles, expiresAt });
}

/**
 * Resolve a session id to its owner. Returns null when the session is unknown,
 * expired, or belongs to a different tenant — callers must fail closed on null.
 * An expired row is deleted rather than left to accumulate.
 */
export async function getSessionById(sessionId: string, tenantId: string): Promise<Session | null> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return null;
  const db = dbResult.val;

  const row = await db
    .selectFrom('sessions')
    .select(['id', 'tenant_id', 'subject', 'roles', 'expires_at'])
    .where('id', '=', sessionId)
    .where('tenant_id', '=', tenantId)
    .executeTakeFirst();

  if (!row) return null;

  if (new Date(row.expires_at) < new Date()) {
    await db.deleteFrom('sessions').where('id', '=', sessionId).execute();
    logger.debug('[Session] Expired session discarded', { tenantId, sessionId });
    return null;
  }

  await db
    .updateTable('sessions')
    .set({ last_used_at: new Date() })
    .where('id', '=', sessionId)
    .execute();

  return {
    id: row.id,
    tenantId: row.tenant_id,
    subject: row.subject,
    roles: row.roles,
    expiresAt: new Date(row.expires_at),
  };
}

/** For route handlers, which receive the request directly. */
export async function getSessionFromRequest(
  request: NextRequest,
  tenantId: string
): Promise<Session | null> {
  const sessionId = request.cookies.get(sessionCookieName(tenantId))?.value;
  if (!sessionId) return null;
  return getSessionById(sessionId, tenantId);
}

/** For server components, which read cookies from the async store. */
export async function getSessionFromCookies(tenantId: string): Promise<Session | null> {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(sessionCookieName(tenantId))?.value;
  if (!sessionId) return null;
  return getSessionById(sessionId, tenantId);
}

export async function destroySession(sessionId: string): Promise<void> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return;
  await dbResult.val.deleteFrom('sessions').where('id', '=', sessionId).execute();
}

export function hasRole(session: Session | null, role: string): boolean {
  return session?.roles.includes(role) ?? false;
}
