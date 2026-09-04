/**
 * Which connectors a chat offers the model — the per-chat/per-project
 * toolset. Stored as jsonb on the chat and the project; the chat's own
 * setting wins, the project's applies to chats without one, and neither
 * means the core set.
 *
 * Pure: the tool catalog and the MCP list are joined in tool-surface.ts.
 */

/** On by default: the org's knowledge, the agent scratch space. */
export const CHAT_CORE_CONNECTORS: readonly string[] = ['knowledge', 'sandbox'];

/** Always offered whatever the toolset, because they carry no connector risk. */
export const CHAT_ALWAYS_TOOLS: readonly string[] = ['whoami'];

export interface ChatToolConfig {
  connectors: string[];
}

const CONNECTOR_KEY = /^[a-z][a-z0-9-]{0,63}$/;

export function parseToolConfig(value: unknown): ChatToolConfig | null {
  let parsed: unknown = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record: { connectors?: unknown } = parsed;
  if (!Array.isArray(record.connectors)) return null;
  const connectors = [...new Set(record.connectors)]
    .filter((entry): entry is string => typeof entry === 'string' && CONNECTOR_KEY.test(entry))
    .sort();
  return { connectors };
}

export function defaultToolConfig(): ChatToolConfig {
  return { connectors: [...CHAT_CORE_CONNECTORS] };
}

export function effectiveToolConfig(
  chat: ChatToolConfig | null,
  project: ChatToolConfig | null
): ChatToolConfig {
  return chat ?? project ?? defaultToolConfig();
}

/** The jsonb form — a fresh literal, since the pg driver serializes objects itself. */
export function toolConfigJson(config: ChatToolConfig): { connectors: string[] } {
  return { connectors: [...config.connectors] };
}
