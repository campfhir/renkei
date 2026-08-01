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

    // Map MCP method to Jira REST endpoint and proxy request
    const jiraBaseUrl = `https://api.atlassian.com/site/${site.cloud_id}/rest/api/3`;
    let jiraUrl: string;
    let jiraMethod = 'GET';
    let jiraBody: string | undefined;

    const params = body.params || {};

    // Map common MCP methods to Jira endpoints
    switch (body.method) {
      case 'searchIssues':
        // GET /rest/api/3/issues/search with query params
        const searchParams = new URLSearchParams();
        if (params.jql) searchParams.append('jql', params.jql);
        if (params.maxResults) searchParams.append('maxResults', params.maxResults);
        if (params.startAt) searchParams.append('startAt', params.startAt);
        if (params.fields) searchParams.append('fields', params.fields.join(','));
        jiraUrl = `${jiraBaseUrl}/issues/search?${searchParams.toString()}`;
        break;

      case 'getIssue':
        // GET /rest/api/3/issues/{issueId}
        if (!params.issueId) {
          return NextResponse.json(
            {
              jsonrpc: '2.0',
              error: { code: -32602, message: 'Missing issueId parameter' },
              id: body.id,
            },
            { status: 400 }
          );
        }
        jiraUrl = `${jiraBaseUrl}/issues/${params.issueId}`;
        if (params.fields) {
          jiraUrl += `?fields=${params.fields.join(',')}`;
        }
        break;

      case 'createIssue':
        // POST /rest/api/3/issues
        jiraMethod = 'POST';
        jiraUrl = `${jiraBaseUrl}/issues`;
        jiraBody = JSON.stringify(params.fields || params);
        break;

      case 'updateIssue':
        // PUT /rest/api/3/issues/{issueId}
        jiraMethod = 'PUT';
        if (!params.issueId) {
          return NextResponse.json(
            {
              jsonrpc: '2.0',
              error: { code: -32602, message: 'Missing issueId parameter' },
              id: body.id,
            },
            { status: 400 }
          );
        }
        jiraUrl = `${jiraBaseUrl}/issues/${params.issueId}`;
        jiraBody = JSON.stringify(params.fields || params);
        break;

      case 'deleteIssue':
        // DELETE /rest/api/3/issues/{issueId}
        jiraMethod = 'DELETE';
        if (!params.issueId) {
          return NextResponse.json(
            {
              jsonrpc: '2.0',
              error: { code: -32602, message: 'Missing issueId parameter' },
              id: body.id,
            },
            { status: 400 }
          );
        }
        jiraUrl = `${jiraBaseUrl}/issues/${params.issueId}`;
        break;

      case 'getProject':
        // GET /rest/api/3/projects/{projectKey}
        if (!params.projectKey) {
          return NextResponse.json(
            {
              jsonrpc: '2.0',
              error: { code: -32602, message: 'Missing projectKey parameter' },
              id: body.id,
            },
            { status: 400 }
          );
        }
        jiraUrl = `${jiraBaseUrl}/projects/${params.projectKey}`;
        break;

      default:
        return NextResponse.json(
          {
            jsonrpc: '2.0',
            error: { code: -32601, message: `Method not found: ${body.method}` },
            id: body.id,
          },
          { status: 400 }
        );
    }

    // Make the Jira API request
    const jiraRequest: RequestInit = {
      method: jiraMethod,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    };

    if (jiraBody) {
      jiraRequest.body = jiraBody;
    }

    const jiraResponse = await fetch(jiraUrl, jiraRequest);

    if (!jiraResponse.ok) {
      if (jiraResponse.status === 401) {
        return NextResponse.json(
          {
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: 'Internal error',
              data: { detail: 'Authentication failed with Jira' },
            },
            id: body.id,
          },
          { status: 401 }
        );
      }

      const errorText = await jiraResponse.text();
      console.error(`Jira API error (${body.method}):`, errorText);

      return NextResponse.json(
        {
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Jira API error',
            data: { status: jiraResponse.status, detail: errorText },
          },
          id: body.id,
        },
        { status: jiraResponse.status }
      );
    }

    const jiraData = await jiraResponse.json();

    return NextResponse.json({
      jsonrpc: '2.0',
      result: jiraData,
      id: body.id,
    });
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
