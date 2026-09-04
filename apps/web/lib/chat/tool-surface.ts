/**
 * What the model may call on a turn: the person's own MCP tool surface,
 * narrowed to the chat's toolset, plus the chat's local tools.
 *
 * Two sources are joined. The catalog (tool-catalog.ts, in-process) is
 * authoritative for which connector a tool belongs to and whether it is
 * app-only (a preview card's buttons — never for a model); the MCP
 * `tools/list` answered by the app's own endpoint, called with a token
 * minted for the person, is authoritative for the input schema and for
 * "exists right now, past every gate". A tool must appear in both.
 *
 * Nothing is minted when the toolset yields no MCP tools — a chat about
 * nothing in particular costs no token row.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { LlmToolDef } from '@renkei/agent-llm';
import { HttpMcpClient, mintRunToken, revokeRunToken, type McpClient } from '@renkei/mcp-client';
import type { McpToolInfo } from '@renkei/mcp-client';
import { listAvailableTools, type ToolDescriptor } from '@/lib/mcp-tools/tool-catalog';
import { logger } from '@/lib/logger';
import { internalMcpEndpoint } from './internal-origin';
import { CHAT_ALWAYS_TOOLS, CHAT_CORE_CONNECTORS, type ChatToolConfig } from './tool-config';

/** Tool names the chat never offers, whatever the toolset. */
const EXCLUDED_SUFFIX = '_preview';

export function selectChatTools(
  catalog: ToolDescriptor[],
  mcpTools: McpToolInfo[],
  config: ChatToolConfig
): LlmToolDef[] {
  const wanted = new Set(config.connectors);
  const byName = new Map(mcpTools.map((tool) => [tool.name, tool]));
  const selected: LlmToolDef[] = [];
  for (const descriptor of catalog) {
    if (descriptor.appOnly) continue;
    if (descriptor.name.endsWith(EXCLUDED_SUFFIX)) continue;
    const always = CHAT_ALWAYS_TOOLS.includes(descriptor.name);
    if (!always && (!descriptor.connector || !wanted.has(descriptor.connector))) continue;
    const live = byName.get(descriptor.name);
    if (!live) continue;
    selected.push({
      name: live.name,
      description: live.description || descriptor.description || descriptor.title || live.name,
      inputSchema: live.inputSchema,
    });
  }
  // Stable order: the tool list is part of the cached prompt prefix.
  return selected.sort((a, b) => a.name.localeCompare(b.name));
}

export interface ConnectorOption {
  key: string;
  count: number;
  core: boolean;
}

/** The picker's data: connectors the person can offer, with tool counts. */
export async function listChatConnectors(
  tenantId: string,
  subject: string
): Promise<ConnectorOption[]> {
  const catalog = await listAvailableTools(tenantId, subject);
  const counts = new Map<string, number>();
  for (const descriptor of catalog) {
    if (descriptor.appOnly || descriptor.name.endsWith(EXCLUDED_SUFFIX)) continue;
    if (!descriptor.connector) continue;
    if (CHAT_ALWAYS_TOOLS.includes(descriptor.name)) continue;
    counts.set(descriptor.connector, (counts.get(descriptor.connector) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count, core: CHAT_CORE_CONNECTORS.includes(key) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export interface ChatToolSurface {
  tools: LlmToolDef[];
  mcp: McpClient | null;
  /** Revokes the turn's token; safe to call more than once. */
  release(): Promise<void>;
}

export async function resolveChatToolSurface(
  db: Kysely<DB>,
  input: {
    tenantId: string;
    subject: string;
    roles: string[];
    config: ChatToolConfig;
    ttlSeconds: number;
  }
): Promise<ChatToolSurface> {
  const catalog = await listAvailableTools(input.tenantId, input.subject);
  const candidates = catalog.filter(
    (descriptor) =>
      !descriptor.appOnly &&
      !descriptor.name.endsWith(EXCLUDED_SUFFIX) &&
      (CHAT_ALWAYS_TOOLS.includes(descriptor.name) ||
        (descriptor.connector !== null && input.config.connectors.includes(descriptor.connector)))
  );
  if (candidates.length === 0) return { tools: [], mcp: null, release: async () => {} };

  const token = await mintRunToken(db, {
    tenantId: input.tenantId,
    subject: input.subject,
    agentId: null,
    ttlSeconds: input.ttlSeconds,
    roles: input.roles,
  });
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await revokeRunToken(db, token);
  };
  const mcp = new HttpMcpClient(internalMcpEndpoint(input.tenantId), token, {
    clientName: 'renkei-chat',
  });
  try {
    await mcp.initialize();
    const live = await mcp.listTools();
    return { tools: selectChatTools(candidates, live, input.config), mcp, release };
  } catch (error) {
    // The endpoint being unreachable is a deployment fault, not the
    // person's: the turn proceeds without tools and says so in the log.
    logger.warn('chat tool surface unavailable: {error}', {
      component: 'chat/tools',
      tenantId: input.tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    await release();
    return { tools: [], mcp: null, release: async () => {} };
  }
}
