/**
 * Jump-to-path search over one share for the permissions navigator —
 * operator-only, like the browse listing beside it. The fileshare worker
 * walks the real tree (bounded: folders visited, results, wall time) so
 * an admin can reach /it/policies from anywhere without typing the path.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { clientFailure, fsAdminSearch } from '@/lib/file-shares/service-client';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; shareId: string }> }
): Promise<NextResponse> {
  const { slug, shareId } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  if (!(await checkAccess(tenant.id, [ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const query = request.nextUrl.searchParams.get('q') ?? '';
  const found = await fsAdminSearch(tenant.id, shareId, query);
  if (!found.ok) {
    const failure = clientFailure(found.err);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
  return NextResponse.json({ results: found.val.results, truncated: found.val.truncated });
}
