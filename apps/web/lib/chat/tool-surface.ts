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
 *
 * The result is split in two rather than handed over whole. `tools` (the
 * CORE connectors plus the always-on set — and, in a code project's chat,
 * the pull-request and pipeline tools named in CODE_PROJECT_EAGER_TOOLS)
 * is small and offered up front on every turn. Everything else the person
 * turned on — a chat can have a dozen connectors enabled at once — becomes
 * `discoverable`: schemas the model never sees until it asks for them
 * (tool-discovery.ts's find_tools), because handing every enabled
 * connector's full tool list to the model on every turn both bloats the
 * prompt and, on providers with a hard cap on the tools array (OpenAI's
 * chat-completions dialect: 128), can overflow it outright once enough
 * connectors are on.
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

/**
 * The suffix a preview tool's name carries. Chat used to exclude every
 * `_preview` tool outright — offering one meant the model's card payload
 * rendered as a folded block of raw JSON, worse than the plain write tool
 * it previews. Now that the thread can render the MCP Apps widget a
 * preview tool binds to (widget-card.tsx), they are offered like any
 * other tool; `listChatConnectors`'s per-connector counts still leave them
 * out; that's a display count, not a gate.
 */
const PREVIEW_SUFFIX = '_preview';

/** A tool not offered up front — find_tools searches these by name. */
export interface DiscoverableTool {
  connector: string;
  def: LlmToolDef;
}

export interface PartitionedChatTools {
  /** Offered on every turn: the always-on set plus the core connectors. */
  eager: LlmToolDef[];
  /** Offered only once find_tools surfaces them for the rest of the turn. */
  discoverable: DiscoverableTool[];
}

/** What is offered up front beyond the core connectors: tools by name (a code chat's PR set). */
export interface EagerExtras {
  tools?: readonly string[];
}

export function partitionChatTools(
  catalog: ToolDescriptor[],
  mcpTools: McpToolInfo[],
  config: ChatToolConfig,
  eagerExtras: EagerExtras = {}
): PartitionedChatTools {
  const wanted = new Set(config.connectors);
  const core = new Set(CHAT_CORE_CONNECTORS);
  const eagerByName = new Set(eagerExtras.tools ?? []);
  const byName = new Map(mcpTools.map((tool) => [tool.name, tool]));
  const eager: LlmToolDef[] = [];
  const discoverable: DiscoverableTool[] = [];
  for (const descriptor of catalog) {
    if (descriptor.appOnly) continue;
    const always = CHAT_ALWAYS_TOOLS.includes(descriptor.name);
    if (!always && (!descriptor.connector || !wanted.has(descriptor.connector))) continue;
    const live = byName.get(descriptor.name);
    if (!live) continue;
    const def: LlmToolDef = {
      name: live.name,
      description: live.description || descriptor.description || descriptor.title || live.name,
      inputSchema: live.inputSchema,
    };
    if (
      always ||
      eagerByName.has(descriptor.name) ||
      (descriptor.connector !== null && core.has(descriptor.connector))
    ) {
      eager.push(def);
    } else if (descriptor.connector !== null) {
      // Reached only when !always, which the filter above already requires
      // a non-null connector for — this narrows the type, not the set.
      discoverable.push({ connector: descriptor.connector, def });
    }
  }
  // Stable order: the tool list is part of the cached prompt prefix.
  eager.sort((a, b) => a.name.localeCompare(b.name));
  discoverable.sort((a, b) => a.def.name.localeCompare(b.def.name));
  return { eager, discoverable };
}

/**
 * Which of the offered tools only read, by the catalog's word for it
 * (`kind`, from the tool's readOnlyHint) — plus every preview tool. The
 * runner runs those side by side within a round and never asks the person
 * before calling them (turn-runner.ts's `needsPermission`); anything not
 * named here runs alone, in order, and behind an ask. A preview tool's
 * `readOnlyHint` is false (its catalog `kind` is 'act', same as the write
 * it previews — org read-only mode must remove it right alongside), but
 * calling it writes nothing: it renders a card, and only that card's own
 * confirm button — an app-only tool the model can never reach — commits
 * anything. Asking permission to show a card would just be a second,
 * redundant confirmation in front of the card's own.
 */
export function readOnlyToolNames(catalog: ToolDescriptor[], tools: LlmToolDef[]): Set<string> {
  const reads = new Set(
    catalog
      .filter(
        (descriptor) => descriptor.kind === 'read' || descriptor.name.endsWith(PREVIEW_SUFFIX)
      )
      .map((descriptor) => descriptor.name)
  );
  return new Set(tools.map((tool) => tool.name).filter((name) => reads.has(name)));
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
    if (descriptor.appOnly || descriptor.name.endsWith(PREVIEW_SUFFIX)) continue;
    if (!descriptor.connector) continue;
    if (CHAT_ALWAYS_TOOLS.includes(descriptor.name)) continue;
    counts.set(descriptor.connector, (counts.get(descriptor.connector) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count, core: CHAT_CORE_CONNECTORS.includes(key) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export interface ChatToolSurface {
  /** Offered up front on every turn. */
  tools: LlmToolDef[];
  /** Not offered up front; find_tools (tool-discovery.ts) searches these. */
  discoverable: DiscoverableTool[];
  /** The subset of `tools` and `discoverable` that only read — see readOnlyToolNames. */
  readOnlyTools: ReadonlySet<string>;
  /**
   * The MCP Apps widget each tool's result renders as, by tool name —
   * from `tools/list`'s `_meta.ui.resourceUri` (widgets.ts's
   * `previewToolMeta`). The turn runner stamps this onto a matching
   * call's tool_result block so the thread can render the card instead of
   * the result's raw text.
   */
  widgetResourceUris: ReadonlyMap<string, string>;
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
    /**
     * Tool names the person blocked (permission-prefs.ts): neither offered
     * up front nor discoverable, so the model never sees a verb it may not
     * use. The runner still refuses a call to one made from memory.
     */
    excluded?: ReadonlySet<string>;
    /** Offered up front beyond the core connectors — see partitionChatTools. */
    eager?: EagerExtras;
  }
): Promise<ChatToolSurface> {
  const catalog = await listAvailableTools(input.tenantId, input.subject, { roles: input.roles });
  const excluded = input.excluded ?? new Set<string>();
  const candidates = catalog.filter(
    (descriptor) =>
      !descriptor.appOnly &&
      !excluded.has(descriptor.name) &&
      (CHAT_ALWAYS_TOOLS.includes(descriptor.name) ||
        (descriptor.connector !== null && input.config.connectors.includes(descriptor.connector)))
  );
  if (candidates.length === 0) {
    return {
      tools: [],
      discoverable: [],
      readOnlyTools: new Set(),
      widgetResourceUris: new Map(),
      mcp: null,
      release: async () => {},
    };
  }

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
    const { eager, discoverable } = partitionChatTools(
      candidates,
      live,
      input.config,
      input.eager ?? {}
    );
    const allOffered = [...eager, ...discoverable.map((entry) => entry.def)];
    const offeredNames = new Set(allOffered.map((tool) => tool.name));
    const widgetResourceUris = new Map(
      live.flatMap((tool) =>
        tool.uiResourceUri && offeredNames.has(tool.name)
          ? [[tool.name, tool.uiResourceUri] as const]
          : []
      )
    );
    return {
      tools: eager,
      discoverable,
      readOnlyTools: readOnlyToolNames(candidates, allOffered),
      widgetResourceUris,
      mcp,
      release,
    };
  } catch (error) {
    // The endpoint being unreachable is a deployment fault, not the
    // person's: the turn proceeds without tools and says so in the log.
    logger.warn('chat tool surface unavailable: {error}', {
      component: 'chat/tools',
      tenantId: input.tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    await release();
    return {
      tools: [],
      discoverable: [],
      readOnlyTools: new Set(),
      widgetResourceUris: new Map(),
      mcp: null,
      release: async () => {},
    };
  }
}
