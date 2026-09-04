/**
 * Tools the chat executes in-process rather than over MCP: they act on
 * chat-owned state (attachments, project memory) that the MCP surface has
 * no reason to know about. Each is an ordinary tool definition the model
 * sees alongside the MCP ones, plus an executor the runner dispatches to
 * first — a local name shadows nothing, because none of them collide with
 * the connector prefixes.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { LlmToolDef } from '@renkei/agent-llm';
import type { McpToolResult } from '@renkei/mcp-client';

export interface LocalToolContext {
  db: Kysely<DB>;
  tenantId: string;
  subject: string;
  chatId: string;
  projectId: string | null;
  /** Org read-only mode: local tools that write refuse under it. */
  readOnly: boolean;
}

export interface LocalTool {
  def: LlmToolDef;
  execute(input: Record<string, unknown>, context: LocalToolContext): Promise<McpToolResult>;
}

export interface LocalToolSet {
  has(name: string): boolean;
  defs(): LlmToolDef[];
  run(name: string, input: unknown, context: LocalToolContext): Promise<McpToolResult>;
}

export function textResult(text: string, meta: Record<string, unknown> = {}): McpToolResult {
  return { content: [{ type: 'text', text }], isError: false, meta };
}

export function errorResult(text: string): McpToolResult {
  return { content: [{ type: 'text', text }], isError: true, meta: {} };
}

export function createLocalToolSet(tools: LocalTool[]): LocalToolSet {
  const byName = new Map(tools.map((tool) => [tool.def.name, tool]));
  return {
    has: (name) => byName.has(name),
    defs: () => [...byName.values()].map((tool) => tool.def),
    async run(name, input, context) {
      const tool = byName.get(name);
      if (!tool) return errorResult(`Unknown tool ${name}.`);
      const args: Record<string, unknown> = {};
      if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
        for (const [key, value] of Object.entries(input)) args[key] = value;
      }
      try {
        return await tool.execute(args, context);
      } catch (error) {
        return errorResult(
          `${name} failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  };
}
