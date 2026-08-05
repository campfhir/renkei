import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db';
import { getJiraGrant } from '@/lib/tenant-operations';
import { recordSession } from '@/lib/audit';
import { createLogger } from '@campfhir/bored-logs';
import { getAllToolDefinitions, executeTool } from '@/lib/mcp-tools';

interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    description: string | null;
    status: {
      name: string;
    };
    assignee: {
      displayName: string;
    } | null;
    created: string;
    updated: string;
  };
}

interface MCPResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

interface MCPCapabilities {
  resources: {
    listChanged?: boolean;
  };
}

interface MCPToolResult {
  type: 'text' | 'image' | 'resource';
  text?: string;
  url?: string;
  data?: string;
  mimeType?: string;
}

interface MCPMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: any;
}

interface MCPInitializeRequest extends MCPMessage {
  method: 'initialize';
  params: {
    protocolVersion: string;
    capabilities: any;
    clientInfo: {
      name: string;
      version: string;
    };
  };
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

    // Get the first Jira grant for this tenant (MVP: single user)
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
        { status: 400 }
      );
    }

    const grant = await getJiraGrant(tenantId, grants[0].account_id);
    if (!grant) {
      return NextResponse.json({ error: 'Failed to retrieve Jira grant' }, { status: 500 });
    }

    // Initialize MCP server response with all available tools
    const toolDefinitions = getAllToolDefinitions();
    const mcp: any = {
      protocolVersion: '2024-11-05',
      capabilities: {
        resources: {},
      } as MCPCapabilities,
      resources: [] as MCPResource[],
      tools: toolDefinitions,
    };

    // Add resources for each issue
    mcp.resources.push({
      uri: 'jira://issues',
      name: 'Jira Issues',
      description: 'Access to all Jira issues in this tenant',
      mimeType: 'application/json',
    });

    console.log(`[MCP ${tenantId}] Serving endpoint for ${grant.displayName}`);

    return NextResponse.json(mcp);
  } catch (error) {
    console.error('MCP endpoint error:', error);
    return NextResponse.json({ error: 'Failed to initialize MCP server' }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
) {
  const { tenantId } = await params;
  const db = getDatabase();
  const userAgent = request.headers.get('user-agent') || undefined;
  const ipAddress = request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
                   request.headers.get('x-real-ip') ||
                   undefined;

  let body: MCPMessage | undefined;

  try {
    body = await request.json() as MCPMessage;
    const { jsonrpc = '2.0', id, method, params: toolParams } = body;

    // Handle MCP initialization
    if (method === 'initialize') {
      const initReq = body as MCPInitializeRequest;
      console.log(`[MCP ${tenantId}] Initialize from ${initReq.params?.clientInfo?.name || 'unknown'}`);

      return NextResponse.json({
        jsonrpc,
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            resources: {},
            tools: {},
          },
          serverInfo: {
            name: 'Jira Renkei MCP',
            version: '1.0.0',
          },
        },
      });
    }

    // For non-initialize methods, verify tenant and get Jira grant
    const tenant = await db
      .selectFrom('tenants')
      .select('id')
      .where('id', '=', tenantId)
      .executeTakeFirst();

    if (!tenant) {
      return NextResponse.json({
        jsonrpc,
        id,
        error: { code: -32000, message: 'Tenant not found' },
      }, { status: 404 });
    }

    const grants = await db
      .selectFrom('atlassian_grants')
      .select(['account_id'])
      .where('tenant_id', '=', tenantId)
      .limit(1)
      .execute();

    if (grants.length === 0) {
      return NextResponse.json({
        jsonrpc,
        id,
        error: { code: -32000, message: 'No Jira grant configured' },
      }, { status: 400 });
    }

    const accountId = grants[0].account_id;
    const grant = await getJiraGrant(tenantId, accountId);
    if (!grant) {
      return NextResponse.json({
        jsonrpc,
        id,
        error: { code: -32000, message: 'Failed to retrieve Jira grant' },
      }, { status: 500 });
    }

    // Record session
    await recordSession({
      tenantId,
      accountId,
      userAgent,
      ipAddress,
    });

    let result: MCPToolResult | null = null;
    let toolError: string | undefined;

    // Execute tool with new system
    try {
      if (!method) {
        toolError = 'Method is required';
      } else {
        result = await executeTool(method, {
          tenantId,
          accountId,
          siteUrl: grant.siteUrl,
          accessToken: grant.accessToken,
          maxJqlResults: 100,
        }, toolParams || {});

        if (!result) {
          toolError = 'Failed to process request';
        }
      }
    } catch (toolErr) {
      toolError = toolErr instanceof Error ? toolErr.message : 'Unknown error';
    }

    // Log tool call with bored-logs
    const logger = createLogger();
    if (toolError) {
      logger.error('[mcp:{tenantId}] Tool error: {method}', {
        tenantId,
        method,
        accountId,
        userAgent,
        ipAddress,
        status: 'failure',
        error: toolError,
      });

      return NextResponse.json({
        jsonrpc,
        id,
        error: { code: -32000, message: toolError },
      }, { status: 400 });
    } else {
      logger.info('[mcp:{tenantId}] Tool call: {method}', {
        tenantId,
        method,
        accountId,
        userAgent,
        ipAddress,
        status: 'success',
      });
    }

    console.log(`[MCP ${tenantId}] Tool executed: ${method}`);

    return NextResponse.json({
      jsonrpc,
      id,
      result: {
        type: 'tool_result',
        isError: false,
        content: [result],
      },
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('MCP execution error:', error);

    // Try to log the error with bored-logs
    try {
      const bodyData = await request.json().catch(() => ({})) as any;
      const grants = await db
        .selectFrom('atlassian_grants')
        .select(['account_id'])
        .where('tenant_id', '=', tenantId)
        .limit(1)
        .execute();

      if (grants.length > 0) {
        const logger = createLogger();
        logger.error('[mcp:{tenantId}] Execution error: {method}', {
          tenantId,
          method: bodyData.method || 'unknown',
          accountId: grants[0].account_id,
          userAgent,
          ipAddress,
          status: 'failure',
          error: errorMsg,
        });
      }
    } catch {
      // Silently fail logging
    }

    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: body?.id,
        error: { code: -32603, message: `Internal error: ${errorMsg}` },
      },
      { status: 500 }
    );
  }
}

