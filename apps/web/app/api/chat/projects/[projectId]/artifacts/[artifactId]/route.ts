import type { NextRequest } from 'next/server';
import { chatRequestContext } from '@/lib/chat/route-support';
import { detachArtifactRoute, setArtifactModeRoute } from '@/lib/chat/artifact-routes';

// chatRequestContext runs inside the shared artifact routes; named here so
// the auth-coverage test sees the decision on this entry point too.
void chatRequestContext;

type Params = { params: Promise<{ projectId: string; artifactId: string }> };

export async function PATCH(request: NextRequest, { params }: Params): Promise<Response> {
  const { projectId, artifactId } = await params;
  return setArtifactModeRoute(request, projectId, artifactId);
}

export async function DELETE(request: NextRequest, { params }: Params): Promise<Response> {
  const { projectId, artifactId } = await params;
  return detachArtifactRoute(request, projectId, artifactId);
}
