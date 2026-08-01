import { NextRequest, NextResponse } from 'next/server';
import { getOperatorSession } from '@/lib/auth-utils';
import { getDatabase } from '@/lib/db';

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
  const q = searchParams.get('q') || '';
  const sortParam = searchParams.get('sort');

  const db = getDatabase();

  try {
    // Fetch tenant to verify access
    const tenant = await db
      .selectFrom('tenants')
      .select(['id'])
      .where('slug', '=', slug)
      .executeTakeFirst();

    if (!tenant) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
    }

    // For now, return all logs or filtered by simple criteria
    // TODO: Parse bored-logs query string and build proper SQL
    let query = db.selectFrom('logs').select(['log_id', 'message', 'logged_timestamp', 'level']);

    // Simple level filter for demo
    if (q.includes('level:error')) {
      query = query.where('level', '=', 'error');
    } else if (q.includes('level:warn')) {
      query = query.where('level', '=', 'warn');
    }

    // Default sort by timestamp desc
    query = query.orderBy('logged_timestamp', 'desc').limit(100);

    const logs = await query.execute();

    return NextResponse.json({
      logs,
      total: logs.length,
      hasMore: false,
    });
  } catch (error) {
    console.error('Error fetching logs:', error);
    return NextResponse.json({ error: 'Failed to fetch logs' }, { status: 500 });
  }
}
