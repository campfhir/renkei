import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext, jsonError } from '@/lib/chat/route-support';
import { revokeResourceGrant } from '@/lib/chat/access';
import { revokeKey } from '@/lib/chat/chat-keys';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ chatId: string; grantId: string }> }
): Promise<Response> {
  const { chatId, grantId } = await params;
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const revoked = await revokeResourceGrant(db, session.subject, 'chat', chatId, grantId);
  if (!revoked) return jsonError(404, 'not-found', 'No such share');
  // The grant is gone; so is their wrapping of the chat's key.
  await revokeKey(db, 'chat', chatId, revoked);
  return NextResponse.json({ ok: true });
}
