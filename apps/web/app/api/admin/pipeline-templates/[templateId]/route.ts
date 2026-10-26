/** One pipeline template: rewrite (PUT) or delete (DELETE) — operator-only. */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { getDatabase } from '@renkei/db';
import {
  deletePipelineTemplate,
  parsePipelineTemplatePayload,
  updatePipelineTemplate,
} from '@/lib/code/pipeline-templates';
import { routeLog } from '@/lib/log-context';

async function PUTHandler(
  request: NextRequest,
  { params }: { params: Promise<{ templateId: string }> }
): Promise<NextResponse> {
  const { templateId } = await params;
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const body: unknown = await request.json().catch(() => null);
  const parsed = parsePipelineTemplatePayload(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  const updated = await updatePipelineTemplate(dbResult.val, templateId, parsed);
  if (!updated.ok) {
    const status = updated.error === 'duplicate' ? 409 : 404;
    const error =
      updated.error === 'duplicate' ? 'A template with that name exists' : 'Template not found';
    return NextResponse.json({ error }, { status });
  }
  return NextResponse.json({ ok: true });
}

async function DELETEHandler(
  _request: NextRequest,
  { params }: { params: Promise<{ templateId: string }> }
): Promise<NextResponse> {
  const { templateId } = await params;
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  const deleted = await deletePipelineTemplate(dbResult.val, templateId);
  if (!deleted) return NextResponse.json({ error: 'Template not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export const PUT = routeLog(PUTHandler);
export const DELETE = routeLog(DELETEHandler);
