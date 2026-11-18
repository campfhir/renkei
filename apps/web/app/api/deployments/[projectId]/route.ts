/**
 * GET: one code project's deployments — each environment, its history,
 * and each promotion (the commits the next environment would get, the pull
 * request between them), read from the host with the person's own grant.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { jsonError } from '@/lib/chat/route-support';
import { deploymentDetail } from '@/lib/ci/deployments';
import { builderContext } from '@/lib/ci/pipeline-builder-access';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  const found = await builderContext(request, projectId);
  if (!found.ok) return found.response;
  const { subject, origin } = found.context;
  const detail = await deploymentDetail({ subject, origin }, projectId);
  if (!detail)
    return jsonError(404, 'not-found', 'This project has no pipeline built in Renkei yet.');
  return NextResponse.json(detail);
}
