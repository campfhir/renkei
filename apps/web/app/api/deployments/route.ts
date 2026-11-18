/**
 * GET: the Deployments page — what each code project's pipeline last
 * deployed to each environment, the newest deployments across them, and
 * the targets (lib/ci/deployments.ts). The projects the person can open.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext } from '@/lib/chat/route-support';
import { deploymentsOverview } from '@/lib/ci/deployments';

export async function GET(request: NextRequest): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  return NextResponse.json(await deploymentsOverview(ready.context.session.subject));
}
