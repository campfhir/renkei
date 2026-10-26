import type { NextRequest } from 'next/server';
import { revokeGrantRoute } from '@/lib/chat/grant-routes';
import { chatRequestContext } from '@/lib/chat/route-support';
import { routeLog } from '@/lib/log-context';

// See ../route.ts — the session decision lives in the shared grant routes.
void chatRequestContext;

async function DELETEHandler(
  request: NextRequest,
  { params }: { params: Promise<{ libraryId: string; grantId: string }> }
): Promise<Response> {
  const { libraryId, grantId } = await params;
  return revokeGrantRoute(request, 'prompt_library', libraryId, grantId);
}

export const DELETE = routeLog(DELETEHandler);
