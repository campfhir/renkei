/**
 * One share's config — operator-only, connection details only. Credentials
 * are each person's own, stored via the connectors page, and never pass
 * through the admin surface.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { deleteShare, getShare, updateShare } from '@renkei/connector-fileshares';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { recordAuditEvent } from '@/lib/audit-events';
import { parseSharePayload } from '@/lib/file-shares/parse';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string; shareId: string }> }
): Promise<NextResponse> {
  const { slug, shareId } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  if (!(await checkAccess(tenant.id, [ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const share = await getShare(dbResult.val, tenant.id, shareId);
  if (!share.ok) return NextResponse.json({ error: 'Could not read the share' }, { status: 500 });
  if (!share.val) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({
    share: { ...share.val.summary, updatedAt: share.val.updatedAt.toISOString() },
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; shareId: string }> }
): Promise<NextResponse> {
  const { slug, shareId } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  const session = await checkAccess(tenant.id, [ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  const parsed = parseSharePayload(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const updated = await updateShare(dbResult.val, tenant.id, shareId, parsed.input);
  if (!updated.ok) {
    if (updated.err.type === 'DUPLICATE_NAME') {
      return NextResponse.json({ error: 'A share with that name exists' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Could not update the share' }, { status: 500 });
  }
  if (!updated.val) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  recordAuditEvent({
    tenantId: tenant.id,
    actorSubject: session.subject,
    action: 'fileshare.updated',
    targetKind: 'fileshare',
    targetLabel: parsed.input.name,
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string; shareId: string }> }
): Promise<NextResponse> {
  const { slug, shareId } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  const session = await checkAccess(tenant.id, [ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  // Read the name before the row goes, so the audit line names the thing.
  const share = await getShare(dbResult.val, tenant.id, shareId);
  const name = share.ok && share.val ? share.val.summary.name : shareId;

  const deleted = await deleteShare(dbResult.val, tenant.id, shareId);
  if (!deleted.ok) {
    return NextResponse.json({ error: 'Could not delete the share' }, { status: 500 });
  }
  if (!deleted.val) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  recordAuditEvent({
    tenantId: tenant.id,
    actorSubject: session.subject,
    action: 'fileshare.deleted',
    targetKind: 'fileshare',
    targetLabel: name,
  });
  return NextResponse.json({ ok: true });
}
