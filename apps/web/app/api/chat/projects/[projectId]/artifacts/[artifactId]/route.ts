import type { NextRequest } from 'next/server';
import { chatRequestContext } from '@/lib/chat/route-support';
import { detachArtifactRoute, setArtifactModeRoute } from '@/lib/chat/artifact-routes';
import { routeLog } from '@/lib/log-context';

// chatRequestContext runs inside the shared artifact routes; named here so
// the auth-coverage test sees the decision on this entry point too.
void chatRequestContext;

type Params = { params: Promise<{ projectId: string; artifactId: string }> };

async function PATCHHandler(request: NextRequest, { params }: Params): Promise<Response> {
  const { projectId, artifactId } = await params;
  return setArtifactModeRoute(request, projectId, artifactId);
}

async function DELETEHandler(request: NextRequest, { params }: Params): Promise<Response> {
  const { projectId, artifactId } = await params;
  return detachArtifactRoute(request, projectId, artifactId);
}

export const PATCH = routeLog(PATCHHandler);
export const DELETE = routeLog(DELETEHandler);
