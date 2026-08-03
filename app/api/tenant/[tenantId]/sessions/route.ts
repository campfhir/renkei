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

  if (!accountId) {
    return NextResponse.json({ error: 'accountId query parameter required' }, { status: 400 });
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

    // Verify user has a grant in this tenant
    const grant = await db
      .selectFrom('atlassian_grants')
      .select('account_id')
      .where('tenant_id', '=', tenantId)
      .where('account_id', '=', accountId)
      .executeTakeFirst();

    if (!grant) {
      return NextResponse.json({ error: 'User not found in this tenant' }, { status: 403 });
    }

    const sessions = await getUserSessions(tenantId, accountId);

    return NextResponse.json({
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
  const accountId = searchParams.get('accountId');

  if (!sessionId || !accountId) {
    return NextResponse.json(
      { error: 'sessionId and accountId query parameters required' },
      { status: 400 }
    );
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

    // Verify user has a grant in this tenant
    const grant = await db
      .selectFrom('atlassian_grants')
      .select('account_id')
      .where('tenant_id', '=', tenantId)
      .where('account_id', '=', accountId)
      .executeTakeFirst();

    if (!grant) {
      return NextResponse.json({ error: 'User not found in this tenant' }, { status: 403 });
    }

    // Verify session belongs to this user
    const session = await db
      .selectFrom('jira_sessions')
      .select('id')
      .where('id', '=', sessionId)
      .where('tenant_id', '=', tenantId)
      .where('account_id', '=', accountId)
      .executeTakeFirst();

    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    // Revoke the session
    const success = await revokeSession(sessionId, tenantId);

    if (!success) {
      return NextResponse.json({ error: 'Failed to revoke session' }, { status: 500 });
    }

    console.log(`[Tenant ${tenantId}] User ${accountId} revoked session ${sessionId}`);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to revoke session:', error);
    return NextResponse.json({ error: 'Failed to revoke session' }, { status: 500 });
  }
}
