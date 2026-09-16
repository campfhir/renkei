/**
 * One Mirth instance's config — operator-only, connection details only.
 * Credentials are each person's own, stored via the connectors page, and
 * never pass through the admin surface. A pinned CA is reported only as
 * present/absent on GET; the PEM itself is write-only from here.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { deleteInstance, getInstance, updateInstance } from '@renkei/connector-mirth';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { recordAuditEvent } from '@/lib/audit-events';
import { parseInstancePayload } from '@/lib/mirth/parse';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string; instanceId: string }> }
): Promise<NextResponse> {
  const { slug, instanceId } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  if (!(await checkAccess(tenant.id, [ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const instance = await getInstance(dbResult.val, tenant.id, instanceId);
  if (!instance.ok) {
    return NextResponse.json({ error: 'Could not read the instance' }, { status: 500 });
  }
  if (!instance.val) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({
    instance: { ...instance.val.summary, updatedAt: instance.val.updatedAt.toISOString() },
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; instanceId: string }> }
): Promise<NextResponse> {
  const { slug, instanceId } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  const session = await checkAccess(tenant.id, [ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  const parsed = parseInstancePayload(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const updated = await updateInstance(dbResult.val, tenant.id, instanceId, parsed.input);
  if (!updated.ok) {
    if (updated.err.type === 'DUPLICATE_NAME') {
      return NextResponse.json({ error: 'An instance with that name exists' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Could not update the instance' }, { status: 500 });
  }
  if (!updated.val) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  recordAuditEvent({
    tenantId: tenant.id,
    actorSubject: session.subject,
    action: 'mirth.instance.updated',
    targetKind: 'mirth-instance',
    targetLabel: parsed.input.name,
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string; instanceId: string }> }
): Promise<NextResponse> {
  const { slug, instanceId } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  const session = await checkAccess(tenant.id, [ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  // Read the name before the row goes, so the audit line names the thing.
  const instance = await getInstance(dbResult.val, tenant.id, instanceId);
  const name = instance.ok && instance.val ? instance.val.summary.name : instanceId;

  const deleted = await deleteInstance(dbResult.val, tenant.id, instanceId);
  if (!deleted.ok) {
    return NextResponse.json({ error: 'Could not delete the instance' }, { status: 500 });
  }
  if (!deleted.val) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  recordAuditEvent({
    tenantId: tenant.id,
    actorSubject: session.subject,
    action: 'mirth.instance.deleted',
    targetKind: 'mirth-instance',
    targetLabel: name,
  });
  return NextResponse.json({ ok: true });
}
