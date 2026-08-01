import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db';
import { getConfig } from '@/lib/env';
import { decrypt } from '@/lib/crypto';

interface JsonRpcRequest {
  jsonrpc: string;
  method: string;
  params?: any;
  id?: string | number;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  result?: any;
  error?: { code: number; message: string; data?: any };
  id?: string | number;
}

interface JiraGrant {
  cloud_id: string;
  access_token: string;
  refresh_token?: string;
  expires_at: string;
  scope: string;
}

/**
 * MCP Gateway - routes JSON-RPC requests to Jira Cloud API.
 *
 * Flow:
 * 1. Client sends JSON-RPC 2.0 request to /mcp/{siteId}
 * 2. Resolve siteId to tenant + cloud_id
 * 3. Look up encrypted Atlassian grant (user's access token)
 * 4. Decrypt grant using TOKEN_ENCRYPTION_KEY
 * 5. Build corresponding Jira REST API request
 * 6. Execute request, handle errors
 * 7. Return response as JSON-RPC
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ siteId: string }> }
) {
  const { siteId } = await params;
  const db = getDatabase();
  const config = getConfig();

  let body: JsonRpcRequest;
  try {
    body = (await request.json()) as JsonRpcRequest;
  } catch {
    return NextResponse.json(
      { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } },
      { status: 400 }
    );
  }

  // Validate JSON-RPC 2.0 structure
  if (body.jsonrpc !== '2.0' || !body.method) {
    return NextResponse.json(
      { jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id: body.id },
      { status: 400 }
    );
  }

  try {
    // Resolve site ID to tenant and cloud ID
    const site = await db
      .selectFrom('tenant_jira_sites')
      .select(['site_id', 'tenant_id', 'cloud_id', 'jira_url', 'enabled'])
      .where('site_id', '=', siteId)
      .executeTakeFirst();

    if (!site || !site.enabled) {
      return NextResponse.json(
        {
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal error',
            data: { detail: 'Site not found or disabled' },
          },
          id: body.id,
        },
        { status: 404 }
      );
    }

    // Look up grant for this site's cloud_id
    // For MVP, use the first available grant (in production, extract user from API key/context)
    const grant = await db
      .selectFrom('atlassian_grants')
      .select(['encrypted_token', 'expires_at'])
      .where('cloud_id', '=', site.cloud_id)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();

    if (!grant) {
      return NextResponse.json(
        {
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal error',
            data: { detail: 'No grants found for this site' },
          },
          id: body.id,
        },
        { status: 404 }
      );
    }

    // Check if grant is expired
    const expiresAt = new Date(grant.expires_at);
    if (expiresAt < new Date()) {
      return NextResponse.json(
        {
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal error',
            data: { detail: 'Grant token expired' },
          },
          id: body.id,
        },
        { status: 401 }
      );
    }

    // Decrypt grant token
    let accessToken: string;
    try {
      const decrypted = decrypt(grant.encrypted_token);
      const grantData = JSON.parse(decrypted) as JiraGrant;
      accessToken = grantData.access_token;
    } catch (err) {
      console.error('Failed to decrypt grant:', err);
      return NextResponse.json(
        {
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal error',
            data: { detail: 'Failed to decrypt grant' },
          },
          id: body.id,
        },
        { status: 500 }
      );
    }

    // For MVP, stub the Jira API proxy - echo back the request
    // In production, map body.method to appropriate Jira REST endpoints
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        result: {
          message: `MCP method '${body.method}' received for site ${site.cloud_id}`,
          params: body.params,
        },
        id: body.id,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('MCP gateway error:', error);
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal error',
        },
        id: body.id,
      },
      { status: 500 }
    );
  }
}
