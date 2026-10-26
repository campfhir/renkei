import type { NextRequest } from 'next/server';
import { chatRequestContext } from '@/lib/chat/route-support';
import { attachArtifactRoute, listProjectArtifactsRoute } from '@/lib/chat/artifact-routes';
import { routeLog } from '@/lib/log-context';

// chatRequestContext runs inside the shared artifact routes; named here so
// the auth-coverage test sees the decision on this entry point too.
void chatRequestContext;

type Params = { params: Promise<{ projectId: string }> };

async function GETHandler(request: NextRequest, { params }: Params): Promise<Response> {
  const { projectId } = await params;
  return listProjectArtifactsRoute(request, projectId);
}

async function POSTHandler(request: NextRequest, { params }: Params): Promise<Response> {
  const { projectId } = await params;
  return attachArtifactRoute(request, projectId);
}

export const GET = routeLog(GETHandler);
export const POST = routeLog(POSTHandler);
