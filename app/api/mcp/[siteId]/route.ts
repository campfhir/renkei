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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ siteId: string }> }
) {
  const { siteId } = await params;
  const db = getDatabase();
  const config = getConfig();

  try {
    // Parse the MCP request (JSON-RPC 2.0)
    const body = (await request.json()) as JsonRpcRequest;

    if (body.jsonrpc !== '2.0' || !body.method) {
      return NextResponse.json(
        {
          jsonrpc: '2.0',
          error: { code: -32600, message: 'Invalid Request' },
        } as JsonRpcResponse,
        { status: 400 }
      );
    }

    // Resolve site ID to tenant and cloud ID
    const site = await db
      .selectFrom('tenant_jira_sites')
      .select(['site_id', 'tenant_id', 'cloud_id', 'enabled'])
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
        } as JsonRpcResponse,
        { status: 404 }
      );
    }

    // TODO: Look up encrypted grant for this cloud_id
    // TODO: Decrypt grant using TOKEN_ENCRYPTION_KEY
    // TODO: Validate grant is still fresh (check expiration)
    // TODO: Build Jira API request using grant's access token
    // TODO: Execute request against Jira Cloud
    // TODO: Handle Jira API errors and rate limits
    // TODO: Return response as JSON-RPC

    // Stub response for now
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal error',
          data: { detail: 'MCP gateway not fully implemented' },
        },
        id: body.id,
      } as JsonRpcResponse,
      { status: 501 }
    );
  } catch (error) {
    console.error('MCP gateway error:', error);
    const id = (await request.json()).id;
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal error',
        },
        id,
      } as JsonRpcResponse,
      { status: 500 }
    );
  }
}
