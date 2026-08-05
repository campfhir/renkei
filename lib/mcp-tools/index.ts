/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * MCP Tools Registry
 *
 * Central registry for all available MCP tools.
 * Tools are organized by product/service for modularity.
 */

import type { MCPToolContext, MCPToolResult } from './common';
import { jiraTools } from './jira';
import { jiraServiceManagementTools } from './jira-service-management';

export type { MCPToolContext, MCPToolResult };
export { ok, okWithLink, toolError } from './common';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema?: Record<string, any>;
}

export interface ToolHandler {
  name: string;
  description: string;
  inputSchema?: Record<string, any>;
  handler: (context: MCPToolContext, params: any) => Promise<MCPToolResult>;
}

// All available tools from all product categories
export const allTools = [
  ...jiraTools,
  ...jiraServiceManagementTools,
];

/**
 * Get tool definition for MCP protocol response.
 */
export function getToolDefinition(name: string): ToolDefinition | undefined {
  const tool = allTools.find((t) => t.name === name);
  if (!tool) return undefined;

  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

/**
 * Get all tool definitions for MCP discovery.
 */
export function getAllToolDefinitions(): ToolDefinition[] {
  return allTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

/**
 * Execute a tool with the given context and parameters.
 */
export async function executeTool(
  name: string,
  context: MCPToolContext,
  params: any,
): Promise<MCPToolResult> {
  const tool = allTools.find((t) => t.name === name);

  if (!tool) {
    return {
      type: 'text',
      text: `Unknown tool: ${name}`,
    };
  }

  try {
    return await tool.handler(context, params);
  } catch (error) {
    return {
      type: 'text',
      text: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
