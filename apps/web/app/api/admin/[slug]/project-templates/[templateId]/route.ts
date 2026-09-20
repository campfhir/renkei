/**
 * One code-project template: rename/re-author (PUT) or delete (DELETE)
 * — operator-only. A built-in id never matches a row, so both routes
 * simply 404 on one rather than needing a special case.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getDatabase } from '@renkei/db';
import {
  deleteCodeProjectTemplate,
  parseTemplatePayload,
  updateCodeProjectTemplate,
} from '@/lib/code/project-templates';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; templateId: string }> }
): Promise<NextResponse> {
  const { slug, templateId } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  if (!(await checkAccess(tenant.id, [ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  const parsed = parseTemplatePayload(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const updated = await updateCodeProjectTemplate(dbResult.val, tenant.id, templateId, parsed);
  if (!updated.ok) {
    const status = updated.error === 'duplicate' ? 409 : 404;
    const error =
      updated.error === 'duplicate' ? 'A template with that name exists' : 'Template not found';
    return NextResponse.json({ error }, { status });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string; templateId: string }> }
): Promise<NextResponse> {
  const { slug, templateId } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  if (!(await checkAccess(tenant.id, [ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const deleted = await deleteCodeProjectTemplate(dbResult.val, tenant.id, templateId);
  if (!deleted) return NextResponse.json({ error: 'Template not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
