/**
 * The tools of a remote MCP server, registered as this caller's own.
 *
 * What a server lists is data, not code: its tools come from the person's
 * cached `tools/list` (mcp-servers/remote.ts keeps it fresh), so
 * registration performs no I/O, exactly like every other tool module. Each
 * tool is named `<slug>__<tool>` after the server, registered under the
 * capability key `mcp-<slug>` — so the org's off switch, a restricted
 * audience and the person's own hide choices all apply per server — and its
 * handler forwards the call to the server through the delegate as that
 * person. The server's own authorization is the only authorization: Renkei
 * adds none and removes none.
 *
 * Arguments are not validated here. The server's published JSON Schema is
 * advertised as given and the server validates the call; a schema Renkei
 * could not compile would otherwise hide a tool that works.
 *
 * A tool is an act unless the server marked it `readOnlyHint: true` — the
 * same conservative reading every connector gets — so a read-only org
 * removes the rest, and a chat asks before running one.
 */

import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { McpAuthRequired, namespacedToolName, type McpListedTool } from '@renkei/connector-mcp';
import { getServer } from '@renkei/connector-mcp';
import type { MCPToolContext } from '../common';
import { callRemoteTool, refreshInBackground } from '@/lib/mcp-servers/remote';
import { logger } from '@/lib/logger';
import { isRecord } from '@renkei/guards';

/** What registration needs to know about a connected server. */
export interface McpServerRegistration {
  id: string;
  slug: string;
  name: string;
  url: string;
  transport: 'streamable_http' | 'sse';
  tools: McpListedTool[];
}

/** Longest text a single result block may carry back to a model. */
const MAX_TEXT_CHARS = 100_000;

type Args = Record<string, unknown>;

/** Accepts any object; the remote server validates. Advertises the server's own schema. */
export function passthroughSchema(
  jsonSchema: Record<string, unknown>
): StandardSchemaWithJSON<Args> {
  const schema = jsonSchema.type === 'object' ? jsonSchema : { type: 'object' };
  return {
    '~standard': {
      version: 1,
      vendor: 'renkei-remote-mcp',
      validate: (value: unknown) =>
        isRecord(value) ? { value } : { issues: [{ message: 'Arguments must be a JSON object.' }] },
      jsonSchema: { input: () => schema, output: () => schema },
    },
  };
}

function clip(text: string): string {
  return text.length > MAX_TEXT_CHARS
    ? `${text.slice(0, MAX_TEXT_CHARS)}\n… (truncated by Renkei at ${MAX_TEXT_CHARS} characters)`
    : text;
}

/** Unique registered names for a server's tools, in listing order. */
export function registeredNames(slug: string, tools: McpListedTool[]): Map<string, McpListedTool> {
  const names = new Map<string, McpListedTool>();
  for (const tool of tools) {
    let name = namespacedToolName(slug, tool.name);
    for (let n = 2; names.has(name); n += 1) {
      const suffix = `_${n}`;
      name = `${namespacedToolName(slug, tool.name).slice(0, 64 - suffix.length)}${suffix}`;
    }
    names.set(name, tool);
  }
  return names;
}

export function registerMcpServerTools(
  server: McpServer,
  context: MCPToolContext,
  entry: McpServerRegistration
): void {
  for (const [name, tool] of registeredNames(entry.slug, entry.tools)) {
    const kind = tool.readOnly ? 'Read' : 'Act';
    server.registerTool(
      name,
      {
        title: `${entry.name} · ${kind} — ${tool.name}`,
        description: `[${entry.name}] ${tool.description || tool.name}`,
        annotations: { readOnlyHint: tool.readOnly },
        inputSchema: passthroughSchema(tool.inputSchema),
      },
      async (args: Args) => {
        const subject = context.subject;
        if (!subject) {
          return {
            content: [{ type: 'text' as const, text: `${entry.name} is not available here.` }],
            isError: true as const,
          };
        }
        try {
          const result = await callRemoteTool(entry, subject, tool.name, args);
          const content = result.content.map((block) =>
            block.type === 'text' && typeof block.text === 'string'
              ? { type: 'text' as const, text: clip(block.text) }
              : block.type === 'image' || block.type === 'audio'
                ? block
                : {
                    type: 'text' as const,
                    text: clip(JSON.stringify(block)),
                  }
          );
          return {
            // The server's blocks are relayed; the cast is to the SDK's content union.
            // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
            content: content as { type: 'text'; text: string }[],
            ...(result.isError ? { isError: true as const } : {}),
          };
        } catch (error) {
          if (error instanceof McpAuthRequired) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Your connection to ${entry.name} has expired or was removed. Reconnect it on the Connectors page in Renkei, then try again.`,
                },
              ],
              isError: true as const,
            };
          }
          // A tool the server no longer lists is the usual reason a call
          // fails outright; refresh so the next turn sees the real list.
          const read = await getServer(entry.id);
          if (read.ok && read.val) refreshInBackground(read.val, subject);
          logger.warn('MCP tool call failed: {error}', {
            component: 'mcp-servers',
            subject,
            server: entry.slug,
            tool: tool.name,
            error: error instanceof Error ? error.message : String(error),
          });
          return {
            content: [
              {
                type: 'text' as const,
                text: `${entry.name} could not run ${tool.name}: ${
                  error instanceof Error ? error.message : 'unknown error'
                }`,
              },
            ],
            isError: true as const,
          };
        }
      }
    );
  }
}
