import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db';
import { getTenantAuditLogs, getUserAuditLogs } from '@/lib/audit';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
) {
  const { tenantId } = await params;
  const db = getDatabase();
  const { searchParams } = new URL(request.url);
  const accountId = searchParams.get('accountId');
  const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 500);
  const offset = Math.max(parseInt(searchParams.get('offset') || '0'), 0);

  try {
    // Verify tenant exists
    const tenant = await db
      .selectFrom('tenants')
      .select('id')
      .where('id', '=', tenantId)
      .executeTakeFirst();

    if (!tenant) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
    }

    // If accountId provided, verify user exists in this tenant
    if (accountId) {
      const grant = await db
        .selectFrom('atlassian_grants')
        .select('account_id')
        .where('tenant_id', '=', tenantId)
        .where('account_id', '=', accountId)
        .executeTakeFirst();

      if (!grant) {
        return NextResponse.json({ error: 'User not found in this tenant' }, { status: 403 });
      }

      const logs = await getUserAuditLogs(tenantId, accountId, limit, offset);

      return NextResponse.json({
        type: 'user',
        accountId,
        limit,
        offset,
        logs: logs.map((log) => ({
          id: log.id,
          toolName: log.toolName,
          status: log.status,
          error: log.errorMessage,
          timestamp: log.createdAt,
        })),
      });
    }

    // Return tenant-wide logs
    const logs = await getTenantAuditLogs(tenantId, limit, offset);

    return NextResponse.json({
      type: 'tenant',
      tenantId,
      limit,
      offset,
      logs: logs.map((log) => ({
        id: log.id,
        accountId: log.accountId,
        toolName: log.toolName,
        userAgent: log.userAgent || 'Unknown',
        ipAddress: log.ipAddress || 'Unknown',
        status: log.status,
        error: log.errorMessage,
        timestamp: log.createdAt,
      })),
    });
  } catch (error) {
    console.error('Failed to fetch audit logs:', error);
    return NextResponse.json({ error: 'Failed to fetch audit logs' }, { status: 500 });
  }
}
