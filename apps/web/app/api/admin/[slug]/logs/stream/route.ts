import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getDatabase } from '@renkei/db';

/**
 * WebSocket endpoint for real-time log streaming.
 * Clients can subscribe to log updates with optional filtering.
 *
 * Usage: ws://localhost:3000/api/admin/[slug]/logs/stream?q=level:error
 */
export async function GET(
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
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q') || '';

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;

  // Verify tenant access
  const tenant = await db
    .selectFrom('tenants')
    .select(['id'])
    .where('slug', '=', slug)
    .executeTakeFirst();

  if (!tenant) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }

  // For now, return a simple message indicating WebSocket upgrade is needed
  // In a production environment, you would upgrade the connection here
  // using a library like ws or socket.io

  return NextResponse.json({
    message: 'WebSocket endpoint - upgrade your connection for real-time logs',
    endpoint: `/api/admin/${slug}/logs/stream?q=${encodeURIComponent(query)}`,
    supportedQueries: [
      'level:error',
      'level:warn',
      'level:info',
      'timestamp:>2024-01-01',
      'message:keyword',
    ],
  });
}
