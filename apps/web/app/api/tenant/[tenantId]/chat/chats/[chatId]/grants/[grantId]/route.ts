import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext, jsonError } from '@/lib/chat/route-support';
import { revokeResourceGrant } from '@/lib/chat/access';
import { revokeChatKey } from '@/lib/chat/chat-keys';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; chatId: string; grantId: string }> }
): Promise<Response> {
  const { tenantId, chatId, grantId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const revoked = await revokeResourceGrant(db, tenantId, session.subject, 'chat', chatId, grantId);
  if (!revoked) return jsonError(404, 'not-found', 'No such share');
  // The grant is gone; so is their wrapping of the chat's key.
  await revokeChatKey(db, tenantId, chatId, revoked);
  return NextResponse.json({ ok: true });
}
