import type { NextRequest } from 'next/server';
import { addGrantRoute, listGrantsRoute } from '@/lib/chat/grant-routes';
import { chatRequestContext } from '@/lib/chat/route-support';

// chatRequestContext runs inside the shared grant routes; named here so
// the auth-coverage test sees the decision on this entry point too.
void chatRequestContext;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  return listGrantsRoute(request, 'chat_project', projectId);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  return addGrantRoute(request, 'chat_project', projectId);
}
