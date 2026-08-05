/**
 * MCP endpoint using official MCP SDK.
 *
 * Standards-compliant protocol handling using @modelcontextprotocol/sdk.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db';
import { getJiraGrant } from '@/lib/tenant-operations';
import { recordSession } from '@/lib/audit';
import { createLogger } from '@campfhir/bored-logs';
import { createMCPServer } from './sdk-server';
import { handleMCPRequest, parseJSONRPCMessage } from './http-transport';

interface MCPMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: any;
}

/**
 * GET handler: Return server capabilities and tool list.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> },
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

    // Get Jira grant
    const grants = await db
      .selectFrom('atlassian_grants')
      .select(['account_id'])
      .where('tenant_id', '=', tenantId)
      .limit(1)
      .execute();

    if (grants.length === 0) {
      return NextResponse.json(
        {
          error: 'No Jira grant configured',
          message: 'Please connect your Jira instance first',
        },
        { status: 400 },
      );
    }

    const grant = await getJiraGrant(tenantId, grants[0].account_id);
    if (!grant) {
      return NextResponse.json({ error: 'Failed to retrieve Jira grant' }, { status: 500 });
    }

    // Create MCP server
    const server = createMCPServer({
      tenantId,
      accountId: grants[0].account_id,
      siteUrl: grant.siteUrl,
      accessToken: grant.accessToken,
      maxJqlResults: 100,
    });

    // Get tool list from server
    const toolsResponse = await handleMCPRequest(server, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });

    const tools = (toolsResponse as any).result?.tools || [];

    return NextResponse.json({
      protocolVersion: '2024-11-05',
      capabilities: {
        resources: {},
        tools: {},
      },
      serverInfo: {
        name: 'Jira Renkei MCP',
        version: '1.0.0',
      },
      tools,
    });
  } catch (error) {
    console.error('MCP GET error:', error);
    return NextResponse.json({ error: 'Failed to initialize MCP server' }, { status: 500 });
  }
}

/**
 * POST handler: Process tool calls and MCP protocol messages.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> },
) {
  const { tenantId } = await params;
  const db = getDatabase();
  const userAgent = request.headers.get('user-agent') || undefined;
  const ipAddress = request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
                   request.headers.get('x-real-ip') ||
                   undefined;

  let body: MCPMessage | undefined;

  try {
    body = (await request.json()) as MCPMessage;

    // Verify tenant and get grant
    const tenant = await db
      .selectFrom('tenants')
      .select('id')
      .where('id', '=', tenantId)
      .executeTakeFirst();

    if (!tenant) {
      return NextResponse.json({
        jsonrpc: '2.0',
        id: body?.id,
        error: { code: -32000, message: 'Tenant not found' },
      });
    }

    const grants = await db
      .selectFrom('atlassian_grants')
      .select(['account_id'])
      .where('tenant_id', '=', tenantId)
      .limit(1)
      .execute();

    if (grants.length === 0) {
      return NextResponse.json({
        jsonrpc: '2.0',
        id: body?.id,
        error: { code: -32000, message: 'No Jira grant configured' },
      });
    }

    const accountId = grants[0].account_id;
    const grant = await getJiraGrant(tenantId, accountId);
    if (!grant) {
      return NextResponse.json({
        jsonrpc: '2.0',
        id: body?.id,
        error: { code: -32000, message: 'Failed to retrieve Jira grant' },
      });
    }

    // Create MCP server
    const server = createMCPServer({
      tenantId,
      accountId,
      siteUrl: grant.siteUrl,
      accessToken: grant.accessToken,
      maxJqlResults: 100,
    });

    // Parse and validate JSON-RPC message
    const mcpMessage = parseJSONRPCMessage(body);
    if (!mcpMessage) {
      return NextResponse.json({
        jsonrpc: '2.0',
        id: body?.id,
        error: { code: -32700, message: 'Invalid JSON-RPC message' },
      });
    }

    // Handle the request through the SDK
    const response = await handleMCPRequest(server, mcpMessage);

    // Record tool call for audit
    if (mcpMessage.method === 'tools/call') {
      await recordSession({
        tenantId,
        accountId,
        userAgent,
        ipAddress,
      });

      const logger = createLogger();
      if ((response as any).error) {
        logger.error('[mcp:{tenantId}] Tool error: {method}', {
          tenantId,
          method: mcpMessage.params?.name || 'unknown',
          accountId,
          userAgent,
          ipAddress,
          status: 'failure',
          error: (response as any).error.message,
        });
      } else {
        logger.info('[mcp:{tenantId}] Tool call: {method}', {
          tenantId,
          method: mcpMessage.params?.name || 'unknown',
          accountId,
          userAgent,
          ipAddress,
          status: 'success',
        });
      }
    }

    return NextResponse.json(response);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('MCP POST error:', error);

    return NextResponse.json({
      jsonrpc: '2.0',
      id: body?.id,
      error: { code: -32603, message: `Internal error: ${errorMsg}` },
    });
  }
}
