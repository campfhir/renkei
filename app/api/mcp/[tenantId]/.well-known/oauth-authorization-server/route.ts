import { NextRequest, NextResponse } from 'next/server';
import { getConfig } from '@/lib/env';
import { getDatabase } from '@/lib/db';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;

  const configResult = getConfig();
  if (!configResult.ok) {
    return NextResponse.json({ error: 'Config error' }, { status: 500 });
  }
  const config = configResult.val;

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
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

    const baseUrl = config.PUBLIC_BASE_URL;
    const tenantPath = `/api/mcp/${tenantId}`;
    const dcrEnabled = config.ENABLE_DCR !== 'false';

    const metadata = {
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}${tenantPath}/oauth/authorize`,
      token_endpoint: `${baseUrl}${tenantPath}/oauth/token`,
      ...(dcrEnabled && {
        registration_endpoint: `${baseUrl}${tenantPath}/oauth/register`,
      }),
      response_types_supported: ['code'],
      response_modes_supported: ['query', 'fragment'],
      grant_types_supported: dcrEnabled
        ? ['authorization_code', 'refresh_token']
        : ['authorization_code'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      introspection_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      code_challenge_methods_supported: ['S256', 'plain'],
      scopes_supported: ['openid', 'profile', 'email'],
      claims_supported: ['sub', 'name', 'email', 'email_verified'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      service_documentation: 'https://github.com/campfhir/renkei',
      ui_locales_supported: ['en-US'],
    };

    return NextResponse.json(metadata);
  } catch (error) {
    console.error('[OAuth Metadata] Error:', error);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
