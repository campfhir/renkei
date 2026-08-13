/**
 * Org-admin CRUD over the external-sender banner library — literal phrases
 * a mail gateway/transport rule prepends to messages (e.g. "CAUTION: This
 * Email is from an EXTERNAL source..."). Content-free the same way
 * classifier rules are: a phrase is boilerplate the org's own mail
 * infrastructure injects, never message content, so a new gateway wording
 * is a data change here rather than a code deploy. See
 * packages/email-sanitizer for the pipeline this configures.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { listBannerPatterns, upsertBannerPattern, SEED_BANNERS } from '@renkei/email-sanitizer';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }
  const access = await checkAccess(tenantRef.id, [ROLE_OPERATOR]);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await listBannerPatterns(tenantRef.id);
  if (!result.ok) {
    return NextResponse.json({ error: 'Could not read banner patterns' }, { status: 500 });
  }
  // The built-ins are always active regardless of this tenant's own rows —
  // returned so the UI can show them as a read-only baseline.
  return NextResponse.json({ banners: result.val, seeds: SEED_BANNERS });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
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

  const result = await upsertBannerPattern(tenantRef.id, { phrase, enabled });
  if (!result.ok) {
    return NextResponse.json({ error: 'Could not save the banner pattern' }, { status: 500 });
  }
  return NextResponse.json({ id: result.val });
}
