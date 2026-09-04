import type { NextRequest } from 'next/server';
import { revokeGrantRoute } from '@/lib/chat/grant-routes';
import { chatRequestContext } from '@/lib/chat/route-support';

// See ../route.ts — the session decision lives in the shared grant routes.
void chatRequestContext;

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string; grantId: string }> }
): Promise<Response> {
  const { tenantId, projectId, grantId } = await params;
  return revokeGrantRoute(request, tenantId, 'chat_project', projectId, grantId);
}
