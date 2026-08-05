import { NextRequest, NextResponse } from 'next/server';
import { getOperatorSession } from '@/lib/auth-utils';
import { getDatabase } from '@/lib/db';

interface QueryFilter {
  field: string;
  operator: '=' | '>' | '<' | '>=' | '<=' | 'like';
  value: string;
}

function parseBoredLogsQuery(q: string): QueryFilter[] {
  const filters: QueryFilter[] = [];

  // Split by space, but respect quoted strings
  const parts = q.match(/(?:[^\s"]+|"[^"]*")+/g) || [];

  for (const part of parts) {
    // Handle "field:operator:value" format
    // Simplified patterns: level:error, timestamp:>2024-01-01, message:contains text
    const match = part.match(/^([a-z_]+):([>=<]*)(.+)$/i);
    if (!match) continue;

    const [, field, opStr, value] = match;
    const trimmedValue = value.replace(/^["']|["']$/g, '');

    let operator: QueryFilter['operator'] = '=';
    if (opStr === '>') operator = '>';
    else if (opStr === '<') operator = '<';
    else if (opStr === '>=') operator = '>=';
    else if (opStr === '<=') operator = '<=';

    filters.push({
      field: field.toLowerCase(),
      operator,
      value: trimmedValue,
    });
  }

  return filters;
}

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

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
  const db = dbResult.val;

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

    // Parse bored-logs query and build SQL
    const filters = parseBoredLogsQuery(q);

    let query = db
      .selectFrom('logs')
      .select(['log_id', 'message', 'logged_timestamp', 'level']);

    // Apply filters from parsed query
    for (const filter of filters) {
      if (filter.field === 'level') {
        query = query.where('level', '=', filter.value);
      } else if (filter.field === 'timestamp') {
        const timestamp = new Date(filter.value);
        if (filter.operator === '>') {
          query = query.where('logged_timestamp', '>', timestamp);
        } else if (filter.operator === '<') {
          query = query.where('logged_timestamp', '<', timestamp);
        } else if (filter.operator === '>=') {
          query = query.where('logged_timestamp', '>=', timestamp);
        } else if (filter.operator === '<=') {
          query = query.where('logged_timestamp', '<=', timestamp);
        } else {
          query = query.where('logged_timestamp', '=', timestamp);
        }
      } else if (filter.field === 'message') {
        // Case-insensitive LIKE search
        query = query.where('message', 'like', `%${filter.value}%`);
      }
    }

    // Default sort by timestamp desc, limit to 100
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
