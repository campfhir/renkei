import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db';
import { setTenantOidc } from '@/lib/tenant-operations';

interface OidcConfigRequest {
  issuer: string;
  clientId: string;
  clientSecret: string;
  roleClaim?: string;
  requiredRole?: string;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
) {
  const { tenantId } = await params;
  const db = getDatabase();

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

    const body = (await request.json()) as OidcConfigRequest;

    // Validate required fields
    if (!body.issuer || !body.clientId || !body.clientSecret) {
      return NextResponse.json(
        { error: 'Missing required fields: issuer, clientId, clientSecret' },
        { status: 400 }
      );
    }

    // Store OIDC configuration
    await setTenantOidc(tenantId, {
      issuer: body.issuer,
      clientId: body.clientId,
      clientSecret: body.clientSecret,
      roleClaim: body.roleClaim,
      requiredRole: body.requiredRole || null,
    });

    console.log(`[Tenant ${tenantId}] OIDC configuration updated`);

    return NextResponse.json({ success: true, tenantId });
  } catch (error) {
    console.error('OIDC config error:', error);
    return NextResponse.json({ error: 'Failed to save OIDC configuration' }, { status: 500 });
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
) {
  const { tenantId } = await params;
  const db = getDatabase();

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

    // Get OIDC configuration
    const oidc = await db
      .selectFrom('tenant_oidc')
      .select(['issuer', 'client_id', 'role_claim', 'required_role'])
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();

    if (!oidc) {
      return NextResponse.json({ configured: false });
    }

    return NextResponse.json({
      configured: true,
      issuer: oidc.issuer,
      clientId: oidc.client_id,
      roleClaim: oidc.role_claim,
      requiredRole: oidc.required_role,
    });
  } catch (error) {
    console.error('OIDC config fetch error:', error);
    return NextResponse.json({ error: 'Failed to fetch OIDC configuration' }, { status: 500 });
  }
}
