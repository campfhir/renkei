/**
 * The MCP client moved to @renkei/mcp-client so the web app's chat can
 * share it; this module keeps the engine's import path and the
 * `AgentMcpClient` name it has always used.
 */

export {
  HttpMcpClient as AgentMcpClient,
  parseSseBody,
  type McpClient,
  type McpToolInfo,
  type McpToolResult,
} from '@renkei/mcp-client';
