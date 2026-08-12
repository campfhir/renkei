/**
 * Update or delete one banner pattern. See ../route.ts for the create path
 * and the content-free rationale.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { upsertBannerPattern, deleteBannerPattern } from '@renkei/email-sanitizer';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> }
): Promise<NextResponse> {
  const { slug, id } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }
  const access = await checkAccess(tenantRef.id, [ROLE_OPERATOR]);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body)) {
    return NextResponse.json({ error: 'JSON body required' }, { status: 400 });
  }
  const { phrase } = body;
  if (typeof phrase !== 'string' || !phrase.trim()) {
    return NextResponse.json({ error: 'phrase is required' }, { status: 400 });
  }
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : true;

  const result = await upsertBannerPattern(tenantRef.id, { id, phrase, enabled });
  if (!result.ok) {
    return NextResponse.json({ error: 'Could not save the banner pattern' }, { status: 500 });
  }
  return NextResponse.json({ id: result.val });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> }
): Promise<NextResponse> {
  const { slug, id } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }
  const access = await checkAccess(tenantRef.id, [ROLE_OPERATOR]);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await deleteBannerPattern(tenantRef.id, id);
  if (!result.ok) {
    return NextResponse.json({ error: 'Could not delete the banner pattern' }, { status: 500 });
  }
  return NextResponse.json({ deleted: true });
}
