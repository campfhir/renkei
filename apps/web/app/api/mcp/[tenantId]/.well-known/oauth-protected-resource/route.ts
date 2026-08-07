import { NextRequest, NextResponse } from 'next/server';
import { getConfig } from '@/lib/env';
import { getDatabase } from '@renkei/db';

/**
 * Protected Resource Metadata for one tenant's MCP server (RFC 9728).
 *
 * This is what the `resource_metadata` parameter of the 401 challenge points
 * at. It previously pointed at the authorization server metadata instead, which
 * is a different document: a client following it looked for
 * `authorization_servers`, found none, and gave up before ever reaching the
 * registration endpoint. That is the whole of "couldn't register".
 *
 * `authorization_servers` is an array of issuer identifier strings, not
 * objects. Each entry must match the `issuer` of the corresponding
 * authorization server metadata exactly, or a client will reject it as a
 * mix-up.
 */
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

  const tenant = await db
    .selectFrom('tenants')
    .select('id')
    .where('id', '=', tenantId)
    .executeTakeFirst();

  if (!tenant) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }

  const baseUrl = config.PUBLIC_BASE_URL;
  const tenantIssuer = `${baseUrl}/api/mcp/${tenantId}`;

  return NextResponse.json({
    resource: tenantIssuer,
    authorization_servers: [tenantIssuer],
    scopes_supported: ['openid', 'profile', 'email'],
    bearer_methods_supported: ['header'],
    resource_documentation: 'https://github.com/campfhir/renkei',
  });
}
