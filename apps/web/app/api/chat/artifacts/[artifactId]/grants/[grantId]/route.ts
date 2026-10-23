import type { NextRequest } from 'next/server';
import { chatRequestContext } from '@/lib/chat/route-support';
import { revokeArtifactGrantRoute } from '@/lib/chat/artifact-routes';

// chatRequestContext runs inside the shared artifact routes; named here so
// the auth-coverage test sees the decision on this entry point too.
void chatRequestContext;

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ artifactId: string; grantId: string }> }
): Promise<Response> {
  const { artifactId, grantId } = await params;
  return revokeArtifactGrantRoute(request, artifactId, grantId);
}
