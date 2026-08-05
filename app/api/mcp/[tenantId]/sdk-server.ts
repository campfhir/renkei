/**
 * MCP Server implementation using the official MCP SDK.
 *
 * This module sets up a standards-compliant MCP server for Jira tools.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { MCPToolContext } from '@/lib/mcp-tools/common';
import { getAllToolDefinitions, executeTool } from '@/lib/mcp-tools';

export interface MCPServerConfig {
  tenantId: string;
  accountId: string;
  siteUrl: string;
  accessToken: string;
  maxJqlResults: number;
}

/**
 * Create an MCP server for Jira tools.
 */
export function createMCPServer(config: MCPServerConfig): Server {
  const server = new Server(
    {
      name: 'Jira Renkei MCP',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  // Get tool definitions from our tool registry
  const toolDefinitions = getAllToolDefinitions();

  // Handle tool list requests
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: toolDefinitions.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema || {
          type: 'object',
          properties: {},
        },
      })) as Tool[],
    };
  });

  // Handle tool call requests
  server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    const toolName = request.params.name;
    const toolArgs = request.params.arguments || {};

    const context: MCPToolContext = {
      tenantId: config.tenantId,
      accountId: config.accountId,
      siteUrl: config.siteUrl,
      accessToken: config.accessToken,
      maxJqlResults: config.maxJqlResults,
    };

    const result = await executeTool(toolName, context, toolArgs);

    return {
      content: [
        {
          type: result.type === 'text' ? 'text' : 'resource',
          text: result.text,
          uri: result.url,
          mimeType: result.mimeType,
          data: result.data,
        },
      ],
      isError: false,
    };
  });

  return server;
}

/**
 * Create and start an MCP server on stdio transport.
 * Useful for standalone testing.
 */
export async function startMCPServer(config: MCPServerConfig): Promise<void> {
  const server = createMCPServer(config);
  const transport = new StdioServerTransport();

  await server.connect(transport);
  console.error(`[MCP Server] Started for tenant ${config.tenantId}`);
}
