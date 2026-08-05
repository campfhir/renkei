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
// Using Server for advanced tool registration pattern
// (programmatically registering 41 tools with custom handlers via setRequestHandler)
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createMcpHandler } from 'mcp-handler';
import { getDatabase } from '@/lib/db';
import { getJiraGrant } from '@/lib/tenant-operations';
import { recordSession } from '@/lib/audit';
import { createLogger } from '@campfhir/bored-logs';
import { getAllToolDefinitions, executeTool } from '@/lib/mcp-tools';
import type { MCPToolContext } from '@/lib/mcp-tools/common';

const handler = async (
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; transport: string }> },
) => {
  const { tenantId } = await params;
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
  const db = dbResult.val;
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
      return new Response(
        JSON.stringify({ error: 'Tenant not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      );
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
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const accountId = grants[0].account_id;
    const grantResult = await getJiraGrant(tenantId, accountId);
    if (!grantResult.ok) {
      return new Response(
        JSON.stringify({ error: 'Failed to retrieve Jira grant' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    }
    const grant = grantResult.val;
    if (!grant) {
      return new Response(
        JSON.stringify({ error: 'Failed to retrieve Jira grant' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // Use mcp-handler to manage HTTP/SSE protocol
    const mcpHandler = createMcpHandler(async () => {
      const server = new Server({
        name: 'Jira Renkei MCP',
        version: '1.0.0',
      });

      // Register all tools with request handler
      server.setRequestHandler(ListToolsRequestSchema, async () => {
        const toolDefinitions = getAllToolDefinitions();
        return {
          tools: toolDefinitions.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema || {
              type: 'object' as const,
              properties: {},
            },
          })),
        };
      });

      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const toolName = request.params.name;
        const toolArgs = request.params.arguments || {};

        if (!toolName) {
          return {
            content: [
              {
                type: 'text',
                text: 'Tool name is required',
              },
            ],
            isError: true,
          };
        }

        const context: MCPToolContext = {
          tenantId,
          accountId,
          siteUrl: grant.siteUrl,
          accessToken: grant.accessToken,
          maxJqlResults: 100,
        };

        try {
          // Record session
          const recordResult = await recordSession({
            tenantId,
            accountId,
            userAgent,
            ipAddress,
          });

          if (!recordResult.ok) {
            console.error('Failed to record session:', recordResult);
          }

          // Execute tool
          const result = await executeTool(toolName, context, toolArgs);

          // Log success
          const logger = createLogger();
          logger.info('[mcp:{tenantId}] Tool call: {method}', {
            tenantId,
            method: toolName,
            accountId,
            userAgent,
            ipAddress,
            status: 'success',
          });

          return {
            content: [
              {
                type: result.type || 'text',
                text: result.text || '',
                uri: result.url,
                mimeType: result.mimeType,
                data: result.data,
              },
            ],
          };
        } catch (error) {
          // Log error
          const logger = createLogger();
          logger.error('[mcp:{tenantId}] Tool error: {method}', {
            tenantId,
            method: toolName,
            accountId,
            userAgent,
            ipAddress,
            status: 'failure',
            error: error instanceof Error ? error.message : String(error),
          });

          return {
            content: [
              {
                type: 'text',
                text: error instanceof Error ? error.message : String(error),
              },
            ],
            isError: true,
          };
        }
      });

      return server;
    });

    // mcp-handler handles HTTP/SSE protocol negotiation and connection lifecycle
    return mcpHandler(request);
  } catch (error) {
    console.error('MCP handler error:', error);
    return new Response(
      JSON.stringify({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};

export { handler as GET, handler as POST, handler as DELETE };
