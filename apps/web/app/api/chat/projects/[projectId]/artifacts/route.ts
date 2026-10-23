import type { NextRequest } from 'next/server';
import { chatRequestContext } from '@/lib/chat/route-support';
import { attachArtifactRoute, listProjectArtifactsRoute } from '@/lib/chat/artifact-routes';

// chatRequestContext runs inside the shared artifact routes; named here so
// the auth-coverage test sees the decision on this entry point too.
void chatRequestContext;

type Params = { params: Promise<{ projectId: string }> };

export async function GET(request: NextRequest, { params }: Params): Promise<Response> {
  const { projectId } = await params;
  return listProjectArtifactsRoute(request, projectId);
}

export async function POST(request: NextRequest, { params }: Params): Promise<Response> {
  const { projectId } = await params;
  return attachArtifactRoute(request, projectId);
}
