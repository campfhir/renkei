import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
  const db = dbResult.val;

  try {
    const body = await request.json();
    const { state, code } = body;

    if (!state || !code) {
      return NextResponse.json({ error: 'Missing state or code' }, { status: 400 });
    }

    // Look up pending OAuth state
    const pending = await db
      .selectFrom('pending_oidc_signin')
      .select(['tenant_id', 'expires_at'])
      .where('state', '=', state)
      .executeTakeFirst();

    if (!pending) {
      return NextResponse.json({ error: 'Invalid state' }, { status: 400 });
    }

    const expiresAt = new Date(pending.expires_at);
    if (expiresAt < new Date()) {
      return NextResponse.json({ error: 'State expired' }, { status: 400 });
    }

    // Verify tenant exists
    const tenant = await db
      .selectFrom('tenants')
      .select('id')
      .where('id', '=', pending.tenant_id)
      .executeTakeFirst();

    if (!tenant) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
    }

    // Delete state after verification
    await db
      .deleteFrom('pending_oidc_signin')
      .where('state', '=', state)
      .execute();

    return NextResponse.json({
      success: true,
      tenantId: pending.tenant_id,
      message: 'OAuth callback validation successful. In production, code would be exchanged for tokens.',
    });
  } catch (error) {
    console.error('Test callback error:', error);
    return NextResponse.json({ error: 'Test callback failed' }, { status: 500 });
  }
}
