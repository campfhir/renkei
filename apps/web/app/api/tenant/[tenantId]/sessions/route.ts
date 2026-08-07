import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db';
import { getUserSessions, revokeSession } from '@/lib/audit';
import { getSessionFromRequest } from '@/lib/session';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;
  const { searchParams } = new URL(request.url);
  const accountId = searchParams.get('accountId');
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userRoles = new Set(session.roles);

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

    // renkei-operator: can see all sessions in tenant
    if (userRoles.has('renkei-operator')) {
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
        role: 'renkei-operator',
        roles: [...userRoles],
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

    // renkei-user: can only see their own sessions
    if (userRoles.has('renkei-user')) {
      if (!accountId) {
        return NextResponse.json({ error: 'accountId parameter required' }, { status: 400 });
      }

      const grant = await db
        .selectFrom('provider_grants')
        .select('provider_account_id')
        .where('tenant_id', '=', tenantId)
        .where('provider', '=', 'atlassian')
        .where('provider_account_id', '=', accountId)
        .executeTakeFirst();

      if (!grant) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
      }

      const sessionsResult = await getUserSessions(tenantId, accountId);
      if (!sessionsResult.ok) {
        return NextResponse.json({ error: 'Database error' }, { status: 500 });
      }
      const sessions = sessionsResult.val;

      return NextResponse.json({
        role: 'renkei-user',
        roles: [...userRoles],
        accountId,
        sessions: sessions.map((s) => ({
          id: s.id,
          userAgent: s.userAgent || 'Unknown',
          ipAddress: s.ipAddress || 'Unknown',
          lastUsedAt: s.lastUsedAt,
          createdAt: s.createdAt,
        })),
      });
    }

    return NextResponse.json({ error: 'Invalid user role' }, { status: 403 });
  } catch (error) {
    console.error('Failed to fetch sessions:', error);
    return NextResponse.json({ error: 'Failed to fetch sessions' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('sessionId');
  const targetAccountId = searchParams.get('accountId');
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userRoles = new Set(session.roles);

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

    // renkei-operator: can revoke any session
    if (userRoles.has('renkei-operator')) {
      const revokeResult = await revokeSession(sessionId, tenantId);
      if (!revokeResult.ok) {
        return NextResponse.json({ error: 'Database error' }, { status: 500 });
      }
      console.log(
        `[Tenant ${tenantId}] Operator revoked session ${sessionId} (user: ${session.accountId})`
      );
      return NextResponse.json({ success: true, revokedSession: sessionId });
    }

    // renkei-user: can only revoke their own sessions
    if (userRoles.has('renkei-user')) {
      if (!targetAccountId) {
        return NextResponse.json({ error: 'accountId parameter required' }, { status: 400 });
      }

      if (targetAccountId !== session.accountId) {
        return NextResponse.json({ error: 'Cannot revoke other users sessions' }, { status: 403 });
      }

      // Verify user has a grant
      const grant = await db
        .selectFrom('provider_grants')
        .select('provider_account_id')
        .where('tenant_id', '=', tenantId)
        .where('provider', '=', 'atlassian')
        .where('provider_account_id', '=', targetAccountId)
        .executeTakeFirst();

      if (!grant) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
      }

      const revokeResult = await revokeSession(sessionId, tenantId);
      if (!revokeResult.ok) {
        return NextResponse.json({ error: 'Database error' }, { status: 500 });
      }
      console.log(
        `[Tenant ${tenantId}] User ${targetAccountId} revoked their session ${sessionId}`
      );
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: 'Invalid user role' }, { status: 403 });
  } catch (error) {
    console.error('Failed to revoke session:', error);
    return NextResponse.json({ error: 'Failed to revoke session' }, { status: 500 });
  }
}
