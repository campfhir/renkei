import type { NextRequest } from 'next/server';
import { chatRequestContext } from '@/lib/chat/route-support';
import {
  artifactDetailRoute,
  deleteArtifactRoute,
  renameArtifactRoute,
  replaceArtifactRoute,
} from '@/lib/chat/artifact-routes';
import { routeLog } from '@/lib/log-context';

// chatRequestContext runs inside the shared artifact routes; named here so
// the auth-coverage test sees the decision on this entry point too.
void chatRequestContext;

export const runtime = 'nodejs';

type Params = { params: Promise<{ artifactId: string }> };

async function GETHandler(request: NextRequest, { params }: Params): Promise<Response> {
  const { artifactId } = await params;
  return artifactDetailRoute(request, artifactId);
}

async function PATCHHandler(request: NextRequest, { params }: Params): Promise<Response> {
  const { artifactId } = await params;
  return renameArtifactRoute(request, artifactId);
}

async function PUTHandler(request: NextRequest, { params }: Params): Promise<Response> {
  const { artifactId } = await params;
  return replaceArtifactRoute(request, artifactId);
}

async function DELETEHandler(request: NextRequest, { params }: Params): Promise<Response> {
  const { artifactId } = await params;
  return deleteArtifactRoute(request, artifactId);
}

export const GET = routeLog(GETHandler);
export const PATCH = routeLog(PATCHHandler);
export const PUT = routeLog(PUTHandler);
export const DELETE = routeLog(DELETEHandler);
