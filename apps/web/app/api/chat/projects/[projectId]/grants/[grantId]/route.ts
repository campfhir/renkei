import type { NextRequest } from 'next/server';
import { revokeGrantRoute } from '@/lib/chat/grant-routes';
import { chatRequestContext } from '@/lib/chat/route-support';
import { routeLog } from '@/lib/log-context';

// See ../route.ts — the session decision lives in the shared grant routes.
void chatRequestContext;

async function DELETEHandler(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; grantId: string }> }
): Promise<Response> {
  const { projectId, grantId } = await params;
  return revokeGrantRoute(request, 'chat_project', projectId, grantId);
}

export const DELETE = routeLog(DELETEHandler);
