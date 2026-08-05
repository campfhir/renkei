import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db';
import { setTenantOidc } from '@/lib/tenant-operations';

interface OidcConfigRequest {
  discoveryEndpoint: string;
  clientId: string;
  clientSecret: string;
  roleClaim?: string;
  operatorIdpValue?: string;
  userIdpValue?: string;
}

function isOidcConfigRequest(data: unknown): data is OidcConfigRequest {
  if (typeof data !== 'object' || data === null) return false;
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const obj = data as Record<string, unknown>;
  return typeof obj.discoveryEndpoint === 'string' && typeof obj.clientId === 'string' && typeof obj.clientSecret === 'string';
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
  const db = dbResult.val;

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

    const body = await request.json();
    if (!isOidcConfigRequest(body)) {
      return NextResponse.json(
        { error: 'Invalid request body format' },
        { status: 400 }
      );
    }

    // Validate required fields
    if (!body.discoveryEndpoint || !body.clientId || !body.clientSecret) {
      return NextResponse.json(
        { error: 'Missing required fields: discoveryEndpoint, clientId, clientSecret' },
        { status: 400 }
      );
    }

    // Fetch and validate discovery endpoint
    let issuer: string;
    try {
      const discoveryResponse = await fetch(body.discoveryEndpoint);
      if (!discoveryResponse.ok) {
        return NextResponse.json(
          { error: `Failed to fetch discovery endpoint: ${discoveryResponse.status}` },
          { status: 400 }
        );
      }

      const discovery = await discoveryResponse.json();
      issuer = discovery.issuer;

      if (!issuer) {
        return NextResponse.json(
          { error: 'Discovery endpoint missing issuer field' },
          { status: 400 }
        );
      }

      console.log(`[Tenant ${tenantId}] Fetched issuer from discovery: ${issuer}`);
    } catch (error) {
      console.error(`[Tenant ${tenantId}] Failed to fetch discovery endpoint:`, error);
      return NextResponse.json(
        { error: 'Failed to fetch OIDC discovery endpoint' },
        { status: 400 }
      );
    }

    // Store OIDC configuration
    const setResult = await setTenantOidc(tenantId, {
      issuer,
      clientId: body.clientId,
      clientSecret: body.clientSecret,
      roleClaim: body.roleClaim,
      operatorIdpValue: body.operatorIdpValue || null,
      userIdpValue: body.userIdpValue || null,
    });

    if (!setResult.ok) {
      console.error(`[Tenant ${tenantId}] Failed to save OIDC configuration:`, setResult);
      return NextResponse.json(
        { error: 'Failed to save OIDC configuration' },
        { status: 500 }
      );
    }

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
): Promise<NextResponse> {
  const { tenantId } = await params;
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
  const db = dbResult.val;

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
      .select(['issuer', 'client_id', 'role_claim', 'operator_idp_value', 'user_idp_value'])
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
      operatorIdpValue: oidc.operator_idp_value,
      userIdpValue: oidc.user_idp_value,
    });
  } catch (error) {
    console.error('OIDC config fetch error:', error);
    return NextResponse.json({ error: 'Failed to fetch OIDC configuration' }, { status: 500 });
  }
}
