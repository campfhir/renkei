import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db';
import { getConfig } from '@/lib/env';

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

    // TODO: Look up grant for this cloud_id + user
    // In production:
    // 1. Extract user ID from request context
    // 2. Query atlassian_grants table for cloud_id + user_id
    // 3. Decrypt grant.encrypted_token using TOKEN_ENCRYPTION_KEY
    // 4. Check expiration - if expired, attempt refresh
    // 5. If refresh fails, return 401 Unauthorized

    // For MVP, we don't have grant lookup - stub response
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal error',
          data: {
            detail: 'Grant lookup not yet implemented - need user context',
          },
        },
        id: body.id,
      },
      { status: 501 }
    );

    // TODO: Once grant is available, continue with:
    // // Build Jira API URL
    // // For example, if method is "searchIssues", map to Jira REST endpoint
    // const jiraUrl = new URL(`https://api.atlassian.com/site/${site.cloud_id}/rest/api/3/issues/search`);
    //
    // // Build Jira request headers with grant.access_token
    // const jiraResponse = await fetch(jiraUrl.toString(), {
    //   method: 'GET',
    //   headers: {
    //     'Authorization': `Bearer ${grant.access_token}`,
    //     'Content-Type': 'application/json',
    //   },
    //   // Forward params as query/body depending on method
    // });
    //
    // // Handle Jira response
    // if (jiraResponse.status === 401) {
    //   // Token expired, attempt refresh
    //   // TODO: Refresh token, retry request
    // }
    //
    // const jiraData = await jiraResponse.json();
    // return NextResponse.json({
    //   jsonrpc: '2.0',
    //   result: jiraData,
    //   id: body.id,
    // });
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
