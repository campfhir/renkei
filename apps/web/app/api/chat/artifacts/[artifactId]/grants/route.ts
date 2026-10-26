import type { NextRequest } from 'next/server';
import { chatRequestContext } from '@/lib/chat/route-support';
import { addArtifactGrantRoute, listArtifactGrantsRoute } from '@/lib/chat/artifact-routes';
import { routeLog } from '@/lib/log-context';

// chatRequestContext runs inside the shared artifact routes; named here so
// the auth-coverage test sees the decision on this entry point too.
void chatRequestContext;

type Params = { params: Promise<{ artifactId: string }> };

async function GETHandler(request: NextRequest, { params }: Params): Promise<Response> {
  const { artifactId } = await params;
  return listArtifactGrantsRoute(request, artifactId);
}

async function POSTHandler(request: NextRequest, { params }: Params): Promise<Response> {
  const { artifactId } = await params;
  return addArtifactGrantRoute(request, artifactId);
}

export const GET = routeLog(GETHandler);
export const POST = routeLog(POSTHandler);
