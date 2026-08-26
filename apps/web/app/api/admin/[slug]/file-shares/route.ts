/**
 * Share registry CRUD — operator-only. GETs report `hasCredentials` and
 * never a credential value; POST requires a complete credential or none
 * (a share without one stays unusable until an admin supplies it).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { parseEncryptionKey } from '@renkei/crypto';
import { createShare, encryptCredentials, listShares } from '@renkei/connector-fileshares';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { recordAuditEvent } from '@/lib/audit-events';
import { parseSharePayload } from '@/lib/file-shares/parse';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  if (!(await checkAccess(tenant.id, [ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const shares = await listShares(dbResult.val, tenant.id);
  if (!shares.ok) return NextResponse.json({ error: 'Could not read shares' }, { status: 500 });

  return NextResponse.json({
    shares: shares.val.map((row) => ({
      ...row.summary,
      updatedAt: row.updatedAt.toISOString(),
    })),
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  const session = await checkAccess(tenant.id, [ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  const parsed = parseSharePayload(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    return NextResponse.json({ error: 'Encryption key unavailable' }, { status: 500 });
  }
  const sealed = parsed.credentials ? encryptCredentials(parsed.credentials, keyResult.val) : null;

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const created = await createShare(dbResult.val, tenant.id, parsed.input, sealed);
  if (!created.ok) {
    if (created.err.type === 'DUPLICATE_NAME') {
      return NextResponse.json({ error: 'A share with that name exists' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Could not create the share' }, { status: 500 });
  }

  recordAuditEvent({
    tenantId: tenant.id,
    actorSubject: session.subject,
    action: 'fileshare.created',
    targetKind: 'fileshare',
    targetLabel: parsed.input.name,
    details: { protocol: parsed.input.protocol, host: parsed.input.host },
  });
  return NextResponse.json({ id: created.val }, { status: 201 });
}
