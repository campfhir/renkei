import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db';
import { getUserSessions, revokeSession } from '@/lib/audit';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
) {
  const { tenantId } = await params;
  const db = getDatabase();
  const { searchParams } = new URL(request.url);
  const accountId = searchParams.get('accountId');
  const operatorKey = request.headers.get('x-operator-key');

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

    // Check permissions
    if (!operatorKey && !accountId) {
      return NextResponse.json(
        { error: 'Either x-operator-key header or accountId parameter required' },
        { status: 400 }
      );
    }

    // Tenant operator: can see all sessions in tenant
    if (operatorKey) {
      const expectedKey = process.env[`OPERATOR_KEY_${tenantId}`.toUpperCase()];
      if (!expectedKey || operatorKey !== expectedKey) {
        return NextResponse.json({ error: 'Invalid operator credentials' }, { status: 403 });
      }

      // Return all sessions for this tenant
      const allSessions = await db
        .selectFrom('jira_sessions')
        .select([
          'id',
          'account_id as accountId',
          'user_agent as userAgent',
          'ip_address as ipAddress',
          'last_used_at as lastUsedAt',
          'created_at as createdAt',
        ])
        .where('tenant_id', '=', tenantId)
        .orderBy('last_used_at', 'desc')
        .execute();

      return NextResponse.json({
        role: 'tenant_operator',
        tenantId,
        sessions: allSessions.map((s) => ({
          id: s.id,
          accountId: s.accountId,
          userAgent: s.userAgent || 'Unknown',
          ipAddress: s.ipAddress || 'Unknown',
          lastUsedAt: s.lastUsedAt,
          createdAt: s.createdAt,
        })),
      });
    }

    // Jira user: can only see their own sessions
    if (!accountId) {
      return NextResponse.json(
        { error: 'accountId parameter required for jira_user access' },
        { status: 400 }
      );
    }

    const grant = await db
      .selectFrom('atlassian_grants')
      .select('account_id')
      .where('tenant_id', '=', tenantId)
      .where('account_id', '=', accountId)
      .executeTakeFirst();

    if (!grant) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    const sessions = await getUserSessions(tenantId, accountId);

    return NextResponse.json({
      role: 'jira_user',
      accountId,
      sessions: sessions.map((s) => ({
        id: s.id,
        userAgent: s.userAgent || 'Unknown',
        ipAddress: s.ipAddress || 'Unknown',
        lastUsedAt: s.lastUsedAt,
        createdAt: s.createdAt,
      })),
    });
  } catch (error) {
    console.error('Failed to fetch sessions:', error);
    return NextResponse.json({ error: 'Failed to fetch sessions' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
) {
  const { tenantId } = await params;
  const db = getDatabase();
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('sessionId');
  const targetAccountId = searchParams.get('accountId');
  const operatorKey = request.headers.get('x-operator-key');

  if (!sessionId) {
    return NextResponse.json({ error: 'sessionId query parameter required' }, { status: 400 });
  }

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

    // Verify session exists and get its owner
    const session = await db
      .selectFrom('jira_sessions')
      .select(['id', 'account_id as accountId'])
      .where('id', '=', sessionId)
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();

    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    // Check permissions
    if (!operatorKey && !targetAccountId) {
      return NextResponse.json(
        { error: 'Either x-operator-key header or accountId parameter required' },
        { status: 400 }
      );
    }

    // Tenant operator: can revoke any session
    if (operatorKey) {
      const expectedKey = process.env[`OPERATOR_KEY_${tenantId}`.toUpperCase()];
      if (!expectedKey || operatorKey !== expectedKey) {
        return NextResponse.json({ error: 'Invalid operator credentials' }, { status: 403 });
      }

      await revokeSession(sessionId, tenantId);
      console.log(`[Tenant ${tenantId}] Operator revoked session ${sessionId} (user: ${session.accountId})`);

      return NextResponse.json({ success: true, revokedSession: sessionId });
    }

    // Jira user: can only revoke their own sessions
    if (targetAccountId !== session.accountId) {
      return NextResponse.json({ error: 'Cannot revoke other users sessions' }, { status: 403 });
    }

    // Verify user has a grant
    const grant = await db
      .selectFrom('atlassian_grants')
      .select('account_id')
      .where('tenant_id', '=', tenantId)
      .where('account_id', '=', targetAccountId)
      .executeTakeFirst();

    if (!grant) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    await revokeSession(sessionId, tenantId);
    console.log(`[Tenant ${tenantId}] User ${targetAccountId} revoked their session ${sessionId}`);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to revoke session:', error);
    return NextResponse.json({ error: 'Failed to revoke session' }, { status: 500 });
  }
}
