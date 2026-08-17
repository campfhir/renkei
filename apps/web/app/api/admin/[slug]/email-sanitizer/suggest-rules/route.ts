/**
 * Org-model rule suggestions for the sanitizer. Synchronous — the operator
 * clicked a button and is watching. Nothing is persisted: suggestions come
 * back for review, and each one the operator accepts goes through the
 * ordinary POST /rules route with its validation.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getDatabase } from '@renkei/db';
import { suggestSanitizerRules } from '@/lib/email-sanitizer/suggest-rules';

export async function POST(
  _request: NextRequest,
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

  const result = await suggestSanitizerRules(dbResult.val, tenantRef.id);
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 422 });
  return NextResponse.json({ suggestions: result.suggestions });
}
