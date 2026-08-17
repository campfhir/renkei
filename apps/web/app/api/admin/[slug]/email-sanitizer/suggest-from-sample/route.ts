/**
 * Paste-a-sample analysis: the admin's own example body in, proposed
 * banner-library phrases out. Synchronous — the operator is watching.
 * Nothing persists; accepted phrases go through POST /banners.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getDatabase } from '@renkei/db';
import { suggestBannerPhrasesFromSample } from '@/lib/email-sanitizer/suggest-from-sample';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  if (!(await checkAccess(tenantRef.id, [ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database error' }, { status: 500 });

  const body: unknown = await request.json().catch(() => null);
  const payload: { text?: unknown } = typeof body === 'object' && body !== null ? body : {};
  if (typeof payload.text !== 'string' || !payload.text.trim()) {
    return NextResponse.json({ error: 'Paste a sample email body first.' }, { status: 400 });
  }

  const result = await suggestBannerPhrasesFromSample(dbResult.val, tenantRef.id, payload.text);
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 422 });
  return NextResponse.json(result);
}
