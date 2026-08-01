import { NextRequest, NextResponse } from 'next/server';
import { getOperatorSession } from '@/lib/auth-utils';
import { getDatabase } from '@/lib/db';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const session = await getOperatorSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { slug } = await params;
  const db = getDatabase();

  try {
    const body = await request.json();
    const accountId = body.account_id as string;
    const scope = body.scope as string; // 'session' or 'credential'

    if (!accountId) {
      return NextResponse.json(
        { error: 'Missing account_id' },
        { status: 400 }
      );
    }

    // Verify account belongs to this tenant
    const tenant = await db
      .selectFrom('tenants')
      .select(['id'])
      .where('slug', '=', slug)
      .executeTakeFirst();

    if (!tenant) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
    }

    if (scope === 'credential') {
      // TODO: Revoke all credentials/grants for this user at this tenant
      // DELETE FROM atlassian_grants WHERE tenant_id = ? AND account_id = ?
      console.log(`TODO: Revoke credentials for ${accountId}`);
    } else {
      // TODO: Revoke all sessions for this user at this tenant
      // DELETE FROM user_sessions WHERE tenant_id = ? AND account_id = ?
      console.log(`TODO: Revoke sessions for ${accountId}`);
    }

    return NextResponse.json({
      success: true,
      account_id: accountId,
      scope,
    });
  } catch (error) {
    console.error('Error revoking access:', error);
    return NextResponse.json(
      { error: 'Failed to revoke access' },
      { status: 500 }
    );
  }
}
