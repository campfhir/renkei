/**
 * The IdP group values sign-ins have recorded, for the audience picker's
 * suggestions. A convenience, never a gate: an admin may type a group
 * nobody has signed in with yet, and the rule takes effect when they do.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { observedIdpGroups } from '@/lib/identity';

export async function GET(
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

  const query = request.nextUrl.searchParams.get('q') ?? '';
  const values = await observedIdpGroups(dbResult.val, tenantRef.id, query.slice(0, 200));
  return NextResponse.json({ groups: values.map((value) => ({ key: value, label: value })) });
}
