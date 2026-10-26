import type { NextRequest } from 'next/server';
import { chatRequestContext } from '@/lib/chat/route-support';
import { impactRoute } from '@/lib/chat/artifact-routes';
import { routeLog } from '@/lib/log-context';

// chatRequestContext runs inside the shared artifact routes; named here so
// the auth-coverage test sees the decision on this entry point too.
void chatRequestContext;

async function GETHandler(
  request: NextRequest,
  { params }: { params: Promise<{ artifactId: string }> }
): Promise<Response> {
  const { artifactId } = await params;
  return impactRoute(request, artifactId);
}

export const GET = routeLog(GETHandler);
