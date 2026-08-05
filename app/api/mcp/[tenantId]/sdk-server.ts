/**
 * MCP Server implementation using the official MCP SDK.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
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

  const toolDefinitions = getAllToolDefinitions();

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
