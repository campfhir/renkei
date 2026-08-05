/**
 * MCP endpoint using mcp-handler for proper edge case handling.
 *
 * Uses the battle-tested mcp-handler package which handles:
 * - HTTP/SSE transport protocol
 * - Connection lifecycle management
 * - Error recovery
 * - Message framing and validation
 */

import { NextRequest, NextResponse } from 'next/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpHandler } from 'mcp-handler';
import { getDatabase } from '@/lib/db';
import { getConfig } from '@/lib/env';
import { getJiraGrant } from '@/lib/tenant-operations';
import { recordSession } from '@/lib/audit';
import { logger } from '@/lib/logger';
import { getAllToolDefinitions, executeTool } from '@/lib/mcp-tools';
import type { MCPToolContext } from '@/lib/mcp-tools/common';

const handler = async (
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; transport: string }> }
): Promise<Response> => {
  const { tenantId } = await params;
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;

  const configResult = getConfig();
  if (!configResult.ok) {
    return NextResponse.json({ error: 'Config error' }, { status: 500 });
  }
  const config = configResult.val;

  const userAgent = request.headers.get('user-agent') || undefined;
  const ipAddress =
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    request.headers.get('x-real-ip') ||
    undefined;

  try {
    // Verify tenant exists
    const tenant = await db
      .selectFrom('tenants')
      .select('id')
      .where('id', '=', tenantId)
      .executeTakeFirst();

    if (!tenant) {
      return new Response(JSON.stringify({ error: 'Tenant not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Get Jira grant
    const grants = await db
      .selectFrom('atlassian_grants')
      .select(['account_id'])
      .where('tenant_id', '=', tenantId)
      .limit(1)
      .execute();

    if (grants.length === 0) {
      return new Response(
        JSON.stringify({
          error: 'No Jira grant configured',
          message: 'Please connect your Jira instance first',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const accountId = grants[0].account_id;
    const grantResult = await getJiraGrant(tenantId, accountId);
    if (!grantResult.ok) {
      return new Response(JSON.stringify({ error: 'Failed to retrieve Jira grant' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const grant = grantResult.val;
    if (!grant) {
      return new Response(JSON.stringify({ error: 'Failed to retrieve Jira grant' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Use mcp-handler to manage HTTP/SSE protocol
    try {
      const mcpHandler = createMcpHandler(async () => {
        try {
          const server = new McpServer(
            { name: 'Jira Renkei MCP', version: '1.0.0' },
            { instructions: 'Jira work item management via MCP' }
          );

          logger.info('[MCP] Server created', { tenantId });

          const context: MCPToolContext = {
            tenantId,
            accountId,
            siteUrl: grant.siteUrl,
            accessToken: grant.accessToken,
            maxJqlResults: 100,
            db,
            config,
          };

          // Register all tools individually
          const toolDefinitions = getAllToolDefinitions();
          for (const toolDef of toolDefinitions) {
            server.registerTool(
              toolDef.name,
              {
                title: toolDef.name,
                description: toolDef.description,
              },
              async () => {
                try {
                  // Record session
                  const recordResult = await recordSession({
                    tenantId,
                    accountId,
                    userAgent,
                    ipAddress,
                  });

                  if (!recordResult.ok) {
                    logger.error('Failed to record session: {error}', {
                      error: recordResult,
                    });
                  }

                  // Execute tool
                  const result = await executeTool(toolDef.name, context, {});

                  // Log success
                  logger.info('[MCP] Tool call success: {toolName}', {
                    tenantId,
                    toolName: toolDef.name,
                    accountId,
                    userAgent,
                    ipAddress,
                  });

                  return {
                    content: [
                      {
                        type: 'text' as const,
                        text: result.text || '',
                      },
                    ],
                  };
                } catch (error) {
                  // Log error
                  logger.error('[MCP] Tool call error: {toolName}', {
                    tenantId,
                    toolName: toolDef.name,
                    accountId,
                    userAgent,
                    ipAddress,
                    error: error instanceof Error ? error.message : String(error),
                  });

                  return {
                    content: [
                      {
                        type: 'text' as const,
                        text: error instanceof Error ? error.message : String(error),
                      },
                    ],
                    isError: true,
                  };
                }
              }
            );
          }

          logger.info('[MCP] All tools registered', {
            tenantId,
            toolCount: toolDefinitions.length,
          });

          return server;
        } catch (serverError) {
          logger.error('[MCP Server Setup Error] {error}', {
            error: serverError instanceof Error ? serverError.message : String(serverError),
          });
          throw serverError;
        }
      });

      // mcp-handler handles HTTP/SSE protocol negotiation and connection lifecycle
      return mcpHandler(request);
    } catch (error) {
      logger.error('[MCP Handler Setup Error] {error}', {
        error: error instanceof Error ? error.message : String(error),
      });
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: `Internal server error: ${error instanceof Error ? error.message : String(error)}`,
          },
          id: null,
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  } catch (error) {
    logger.error('MCP handler error: {error}', {
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response(
      JSON.stringify({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

export { handler as GET, handler as POST, handler as DELETE };
