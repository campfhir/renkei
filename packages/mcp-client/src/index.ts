/**
 * @renkei/mcp-client — the in-house MCP caller: an HTTP JSON-RPC client
 * for the app's own endpoint and the run-token minting that authenticates
 * it. Shared by the agents worker (runs) and the web app (chat turns) so
 * both go through every gate the endpoint applies.
 */

export {
  HttpMcpClient,
  parseSseBody,
  type HttpMcpClientOptions,
  type McpClient,
  type McpToolInfo,
  type McpToolResult,
} from './client';
export { ensureAgentRunnerClient, mintRunToken, revokeRunToken } from './token';
