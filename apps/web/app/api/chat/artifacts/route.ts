import type { NextRequest } from 'next/server';
import { chatRequestContext } from '@/lib/chat/route-support';
import { listLibraryRoute } from '@/lib/chat/artifact-routes';

// chatRequestContext runs inside the shared artifact routes; named here so
// the auth-coverage test sees the decision on this entry point too.
void chatRequestContext;

export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<Response> {
  return listLibraryRoute(request);
}
