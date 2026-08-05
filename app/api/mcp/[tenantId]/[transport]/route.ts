/**
 * MCP HTTP endpoint using mcp-handler.
 *
 * Handles JSON-RPC 2.0 messages via HTTP POST.
 * Caches server per (tenantId, accountId) to avoid recreating and registering
 * 43+ tools on every request. Cache persists for the lifetime of the Next.js process.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createMcpHandler } from 'mcp-handler';
import { getDatabase } from '@/lib/db';
import { getConfig } from '@/lib/env';
import { getJiraGrant } from '@/lib/tenant-operations';
import { logger } from '@/lib/logger';
import { registerAllTools, cacheTokenMetadata } from '@/lib/mcp-tools';
import type { MCPToolContext } from '@/lib/mcp-tools/common';
import type { McpServer } from '@modelcontextprotocol/server';

// Cache MCP handlers per (tenantId, accountId)
const handlerCache = new Map<string, (request: Request) => Promise<Response>>();

function getCacheKey(tenantId: string, accountId: string): string {
  return `${tenantId}:${accountId}`;
}

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

    // Check cache
    const cacheKey = getCacheKey(tenantId, accountId);
    let mcpHandler = handlerCache.get(cacheKey);

    if (!mcpHandler) {
      logger.info('[MCP] Creating new handler (cache miss)', { tenantId, accountId });

      // Create MCP handler with tool registration
      mcpHandler = createMcpHandler(
        async (server: McpServer) => {
          try {
            logger.info('[MCP] Server created', { tenantId, accountId });

            // Cache token metadata for refresh lookups
            cacheTokenMetadata(grant.accessToken, tenantId, accountId);

            const context: MCPToolContext = {
              tenantId,
              accountId,
              siteUrl: grant.siteUrl,
              accessToken: grant.accessToken,
              maxJqlResults: 100,
              db,
              config,
            };

            // Register all tools
            await registerAllTools(server, context);

            logger.info('[MCP] All tools registered', {
              tenantId,
              accountId,
            });
          } catch (err) {
            logger.error('[MCP] Tool registration failed', {
              tenantId,
              accountId,
              error: err instanceof Error ? err.message : String(err),
              cause:
                err instanceof AggregateError
                  ? err.errors.map((e) => (e instanceof Error ? e.message : String(e)))
                  : undefined,
            });
            throw err;
          }
        },
        {
          serverInfo: {
            name: 'Jira Renkei MCP',
            version: '1.0.0',
          },
          instructions: 'Jira work item management via MCP',
          verboseLogs: false,
        }
      );

      // Store in cache
      handlerCache.set(cacheKey, mcpHandler);
    } else {
      logger.debug('[MCP] Using cached handler', { tenantId, accountId });
    }

    // Handle the request with cached handler
    return await mcpHandler(request);
  } catch (error) {
    logger.error('[MCP Handler Error] {error}', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
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
};

export { handler as GET, handler as POST, handler as DELETE };
