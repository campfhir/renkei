/**
 * The pipeline template catalog a project's Pipelines page offers: any
 * signed-in member can read it (they need it to start a pipeline file),
 * narrowed to one host with `?provider=`; only operators add to it
 * (/api/admin/[slug]/pipeline-templates).
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext } from '@/lib/chat/route-support';
import { listPipelineTemplates } from '@/lib/code/pipeline-templates';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<Response> {
  const { tenantId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const provider = request.nextUrl.searchParams.get('provider') ?? undefined;
  const templates = await listPipelineTemplates(ready.context.db, tenantId, provider);
  return NextResponse.json({ templates });
}
