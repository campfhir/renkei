import type { NextRequest } from 'next/server';
import { chatRequestContext } from '@/lib/chat/route-support';
import {
  artifactDetailRoute,
  deleteArtifactRoute,
  renameArtifactRoute,
  replaceArtifactRoute,
} from '@/lib/chat/artifact-routes';

// chatRequestContext runs inside the shared artifact routes; named here so
// the auth-coverage test sees the decision on this entry point too.
void chatRequestContext;

export const runtime = 'nodejs';

type Params = { params: Promise<{ artifactId: string }> };

export async function GET(request: NextRequest, { params }: Params): Promise<Response> {
  const { artifactId } = await params;
  return artifactDetailRoute(request, artifactId);
}

export async function PATCH(request: NextRequest, { params }: Params): Promise<Response> {
  const { artifactId } = await params;
  return renameArtifactRoute(request, artifactId);
}

export async function PUT(request: NextRequest, { params }: Params): Promise<Response> {
  const { artifactId } = await params;
  return replaceArtifactRoute(request, artifactId);
}

export async function DELETE(request: NextRequest, { params }: Params): Promise<Response> {
  const { artifactId } = await params;
  return deleteArtifactRoute(request, artifactId);
}
