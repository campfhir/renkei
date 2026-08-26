/**
 * Who may see a share — operator-only. A grant row IS discoverability:
 * adding one makes the share exist for that subject, removing one erases
 * it (and cascades that subject's path rules via the composite FK).
 * Subjects travel in the body/query, never as a path segment — OIDC
 * subjects carry URL-hostile characters.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { deleteGrant, getShare, listGrants, upsertGrant } from '@renkei/connector-fileshares';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { recordAuditEvent } from '@/lib/audit-events';
import { parseGrantPayload } from '@/lib/file-shares/parse';

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

  const grants = await listGrants(dbResult.val, tenant.id, shareId);
  if (!grants.ok) return NextResponse.json({ error: 'Could not read grants' }, { status: 500 });

  return NextResponse.json({
    grants: grants.val.map((grant) => ({
      subject: grant.subject,
      defaultAccess: grant.defaultAccess,
      createdBy: grant.createdBy,
      createdAt: grant.createdAt.toISOString(),
    })),
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; shareId: string }> }
): Promise<NextResponse> {
  const { slug, shareId } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  const session = await checkAccess(tenant.id, [ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  const parsed = parseGrantPayload(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  // Grants on a share that does not exist in this tenant must not silently
  // create dangling rows (the FK would refuse anyway; the 404 says why).
  const share = await getShare(dbResult.val, tenant.id, shareId);
  if (!share.ok || !share.val) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const existing = await listGrants(dbResult.val, tenant.id, shareId);
  const isUpdate = existing.ok && existing.val.some((grant) => grant.subject === parsed.subject);

  const saved = await upsertGrant(
    dbResult.val,
    tenant.id,
    shareId,
    parsed.subject,
    parsed.defaultAccess,
    session.subject
  );
  if (!saved.ok) return NextResponse.json({ error: 'Could not save the grant' }, { status: 500 });

  recordAuditEvent({
    tenantId: tenant.id,
    actorSubject: session.subject,
    action: isUpdate ? 'fileshare.grant_updated' : 'fileshare.grant_added',
    targetKind: 'fileshare',
    targetLabel: share.val.summary.name,
    details: { subject: parsed.subject, access: parsed.defaultAccess },
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; shareId: string }> }
): Promise<NextResponse> {
  const { slug, shareId } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  const session = await checkAccess(tenant.id, [ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const subject = request.nextUrl.searchParams.get('subject') ?? '';
  if (!subject) return NextResponse.json({ error: 'subject is required' }, { status: 400 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const share = await getShare(dbResult.val, tenant.id, shareId);
  const removed = await deleteGrant(dbResult.val, tenant.id, shareId, subject);
  if (!removed.ok) {
    return NextResponse.json({ error: 'Could not remove the grant' }, { status: 500 });
  }
  if (!removed.val) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  recordAuditEvent({
    tenantId: tenant.id,
    actorSubject: session.subject,
    action: 'fileshare.grant_removed',
    targetKind: 'fileshare',
    targetLabel: share.ok && share.val ? share.val.summary.name : shareId,
    details: { subject },
  });
  return NextResponse.json({ ok: true });
}
