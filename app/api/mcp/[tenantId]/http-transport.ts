/**
 * HTTP Transport adapter for MCP SDK.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { JSONRPCRequest, JSONRPCResponse } from '@modelcontextprotocol/sdk/types.js';

export async function handleMCPRequest(
  server: Server,
  request: JSONRPCRequest,
): Promise<JSONRPCResponse> {
  try {
    const handler = (server as any).requestHandlers?.get(request.method);

    if (!handler) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32601,
          message: `Method not found: ${request.method}`,
        },
      };
    }

    const result = await handler(request.params);

    return {
      jsonrpc: '2.0',
      id: request.id,
      result,
    };
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : 'Internal server error',
      },
    };
  }
}

export function parseJSONRPCMessage(input: unknown): JSONRPCRequest | null {
  if (typeof input !== 'object' || input === null) {
    return null;
  }

  const msg = input as Record<string, unknown>;

  if (typeof msg.jsonrpc !== 'string' || msg.jsonrpc !== '2.0') {
    return null;
  }

  if (typeof msg.method !== 'string') {
    return null;
  }

  return {
    jsonrpc: '2.0',
    id: typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : undefined,
    method: msg.method,
    params: msg.params,
  } as JSONRPCRequest;
}
