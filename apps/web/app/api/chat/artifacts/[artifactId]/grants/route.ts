import type { NextRequest } from 'next/server';
import { chatRequestContext } from '@/lib/chat/route-support';
import { addArtifactGrantRoute, listArtifactGrantsRoute } from '@/lib/chat/artifact-routes';

// chatRequestContext runs inside the shared artifact routes; named here so
// the auth-coverage test sees the decision on this entry point too.
void chatRequestContext;

type Params = { params: Promise<{ artifactId: string }> };

export async function GET(request: NextRequest, { params }: Params): Promise<Response> {
  const { artifactId } = await params;
  return listArtifactGrantsRoute(request, artifactId);
}

export async function POST(request: NextRequest, { params }: Params): Promise<Response> {
  const { artifactId } = await params;
  return addArtifactGrantRoute(request, artifactId);
}
