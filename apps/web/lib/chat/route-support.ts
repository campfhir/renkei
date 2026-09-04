/**
 * The three lines every chat route starts with, once: the session, the
 * database, and a JSON error shape the client helpers understand.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import type { Kysely } from 'kysely';
import { getDatabase, type DB } from '@renkei/db';
import { getSessionFromRequest, type Session } from '@/lib/session';

export interface ChatRequestContext {
  db: Kysely<DB>;
  session: Session;
}

export function jsonError(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: message, code }, { status });
}

export async function chatRequestContext(
  request: NextRequest,
  tenantId: string
): Promise<{ ok: true; context: ChatRequestContext } | { ok: false; response: NextResponse }> {
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return { ok: false, response: jsonError(401, 'unauthenticated', 'Not signed in') };
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return { ok: false, response: jsonError(500, 'database', 'Database unavailable') };
  }
  return { ok: true, context: { db: dbResult.val, session } };
}

export async function readJsonBody(request: NextRequest): Promise<Record<string, unknown>> {
  const raw: unknown = await request.json().catch(() => null);
  const body: Record<string, unknown> = {};
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw)) body[key] = value;
  }
  return body;
}

export function optionalString(value: unknown, maxChars: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.slice(0, maxChars);
}
