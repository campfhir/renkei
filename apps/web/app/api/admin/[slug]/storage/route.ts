/**
 * Org-admin configuration of the organization's file storage — the Azure
 * Blob account chat uploads and the files tools produce are kept in.
 * GET reports presence only; the account key never leaves the server.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { parseStorageInput, readStorage, saveStorage } from '@/lib/storage-admin';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  const access = await checkAccess(tenantRef.id, [ROLE_OPERATOR]);
  if (!access) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const view = await readStorage(tenantRef.id);
  if (view === 'ERROR') {
    return NextResponse.json(
      { error: 'Could not read the storage configuration' },
      { status: 500 }
    );
  }
  return NextResponse.json(view);
}

export async function PUT(
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
  const saved = await saveStorage(tenantRef.id, input);
  if (typeof saved === 'string') {
    return NextResponse.json({ error: saved }, { status: saved.startsWith('The ') ? 400 : 500 });
  }
  return NextResponse.json(saved);
}
