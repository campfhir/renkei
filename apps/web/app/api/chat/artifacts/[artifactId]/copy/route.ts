import type { NextRequest } from 'next/server';
import { chatRequestContext } from '@/lib/chat/route-support';
import { copyRoute } from '@/lib/chat/artifact-routes';
import { routeLog } from '@/lib/log-context';

// chatRequestContext runs inside the shared artifact routes; named here so
// the auth-coverage test sees the decision on this entry point too.
void chatRequestContext;

export const runtime = 'nodejs';

async function POSTHandler(
  request: NextRequest,
  { params }: { params: Promise<{ artifactId: string }> }
): Promise<Response> {
  const { artifactId } = await params;
  return copyRoute(request, artifactId);
}

export const POST = routeLog(POSTHandler);
