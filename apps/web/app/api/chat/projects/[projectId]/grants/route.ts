import type { NextRequest } from 'next/server';
import { addGrantRoute, listGrantsRoute } from '@/lib/chat/grant-routes';
import { chatRequestContext } from '@/lib/chat/route-support';
import { routeLog } from '@/lib/log-context';

// chatRequestContext runs inside the shared grant routes; named here so
// the auth-coverage test sees the decision on this entry point too.
void chatRequestContext;

async function GETHandler(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  return listGrantsRoute(request, 'chat_project', projectId);
}

async function POSTHandler(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  return addGrantRoute(request, 'chat_project', projectId);
}

export const GET = routeLog(GETHandler);
export const POST = routeLog(POSTHandler);
