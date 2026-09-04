/**
 * Tries the storage configuration the operator is ABOUT to save — the
 * form's fields, the stored key when none was typed — by writing, reading
 * and removing a probe object. A failed probe is a successful request:
 * it answers ok:false at HTTP 200.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { parseStorageInput, testStorage } from '@/lib/storage-admin';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  const access = await checkAccess(tenantRef.id, [ROLE_OPERATOR]);
  if (!access) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const input = parseStorageInput(await request.json().catch(() => null));
  if (typeof input === 'string') return NextResponse.json({ error: input }, { status: 400 });
  return NextResponse.json(await testStorage(tenantRef.id, input));
}
