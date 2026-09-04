/**
 * Sharing a chat, read-only: who has it, and giving it to someone. The
 * role is always viewer — a shared chat can be read and watched, never
 * continued by anyone but its owner.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { grantResourceAccess, listResourceGrants } from '@/lib/chat/access';
import { parseExpiry } from '@/lib/chat/grant-input';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; chatId: string }> }
): Promise<Response> {
  const { tenantId, chatId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  return NextResponse.json({
    grants: await listResourceGrants(db, tenantId, session.subject, 'chat', chatId),
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; chatId: string }> }
): Promise<Response> {
  const { tenantId, chatId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const body = await readJsonBody(request);
  const granteeSubject = typeof body.granteeSubject === 'string' ? body.granteeSubject.trim() : '';
  if (!granteeSubject) return jsonError(400, 'invalid', 'Choose a person');
  const expiresAt = parseExpiry(body.expiresAt);
  if (expiresAt === undefined) return jsonError(400, 'invalid', 'Invalid expiry');
  const outcome = await grantResourceAccess(db, tenantId, session.subject, 'chat', chatId, {
    granteeSubject,
    role: 'viewer',
    expiresAt,
  });
  if (outcome === 'NOT_FOUND') return jsonError(404, 'not-found', 'No such chat');
  if (outcome === 'SELF') return jsonError(400, 'self', 'That is you');
  if (outcome === 'INVALID_ROLE') return jsonError(400, 'invalid', 'Chats are shared read-only');
  return NextResponse.json({ ok: true });
}
