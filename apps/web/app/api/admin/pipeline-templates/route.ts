/**
 * The org's pipeline templates (pipeline_templates) — the whole catalog
 * to read, operator-only to add to. The project-templates routes' shape.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import {
  createPipelineTemplate,
  listPipelineTemplates,
  parsePipelineTemplatePayload,
} from '@/lib/code/pipeline-templates';

export async function GET(
  _request: NextRequest
): Promise<NextResponse> {
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  const templates = await listPipelineTemplates(dbResult.val);
  return NextResponse.json({ templates });
}

export async function POST(
  request: NextRequest
): Promise<NextResponse> {
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const body: unknown = await request.json().catch(() => null);
  const parsed = parsePipelineTemplatePayload(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  const created = await createPipelineTemplate(dbResult.val, parsed);
  if (!created.ok) {
    return NextResponse.json({ error: 'A template with that name exists' }, { status: 409 });
  }
  return NextResponse.json({ id: created.id }, { status: 201 });
}
