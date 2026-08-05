import { NextRequest, NextResponse } from 'next/server';
import { getOperatorSession } from '@/lib/auth-utils';
import { getDatabase } from '@/lib/db';

/**
 * WebSocket endpoint for real-time log streaming.
 * Clients can subscribe to log updates with optional filtering.
 *
 * Usage: ws://localhost:3000/api/admin/[slug]/logs/stream?q=level:error
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const session = await getOperatorSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { slug } = await params;
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q') || '';

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: "Database error" }, { status: 500 });
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
