/**
 * One rule — operator-only. PATCH changes its access level in place;
 * DELETE removes it (the path's effective access falls back to the next
 * longest rule, or the layer default).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { clearFileShareCache, deleteRule, getShare } from '@renkei/connector-fileshares';
import { isAccessLevel } from '@renkei/connector-fileshares';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { recordAuditEvent } from '@/lib/audit-events';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; shareId: string; ruleId: string }> }
): Promise<NextResponse> {
  const { slug, shareId, ruleId } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  const session = await checkAccess(tenant.id, [ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  const access = isRecord(body) ? body.access : undefined;
  if (!isAccessLevel(access)) {
    return NextResponse.json(
      { error: "access must be 'none', 'read' or 'read_write'" },
      { status: 400 }
    );
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const updated = await dbResult.val
    .updateTable('file_share_path_rules')
    .set({ access, updated_at: new Date().toISOString() })
    .where('tenant_id', '=', tenant.id)
    .where('share_id', '=', shareId)
    .where('id', '=', ruleId)
    .executeTakeFirst();
  if (updated.numUpdatedRows === BigInt(0)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  clearFileShareCache();

  const share = await getShare(dbResult.val, tenant.id, shareId);
  recordAuditEvent({
    tenantId: tenant.id,
    actorSubject: session.subject,
    action: 'fileshare.rule_updated',
    targetKind: 'fileshare',
    targetLabel: share.ok && share.val ? share.val.summary.name : shareId,
    details: { ruleId, access },
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string; shareId: string; ruleId: string }> }
): Promise<NextResponse> {
  const { slug, shareId, ruleId } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  const session = await checkAccess(tenant.id, [ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  // For the audit line: which path was un-ruled.
  const known = await dbResult.val
    .selectFrom('file_share_path_rules')
    .select(['path', 'subject'])
    .where('tenant_id', '=', tenant.id)
    .where('share_id', '=', shareId)
    .where('id', '=', ruleId)
    .executeTakeFirst();

  const removed = await deleteRule(dbResult.val, tenant.id, shareId, ruleId);
  if (!removed.ok)
    return NextResponse.json({ error: 'Could not delete the rule' }, { status: 500 });
  if (!removed.val) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const share = await getShare(dbResult.val, tenant.id, shareId);
  recordAuditEvent({
    tenantId: tenant.id,
    actorSubject: session.subject,
    action: 'fileshare.rule_removed',
    targetKind: 'fileshare',
    targetLabel: share.ok && share.val ? share.val.summary.name : shareId,
    details: { ruleId, path: known?.path },
  });
  return NextResponse.json({ ok: true });
}
