/**
 * Which connectors a chat offers the model — the per-chat/per-project
 * toolset. Stored as jsonb on the chat and the project; the chat's own
 * setting wins, the project's applies to chats without one, the person's
 * own saved default (tool-prefs.ts) applies when neither does, and no
 * preference at all means the core set.
 *
 * Pure: the tool catalog and the MCP list are joined in tool-surface.ts.
 * The person's saved default is resolved by the caller (it needs the
 * database) and passed in, same as chat and project here.
 */

/**
 * On by default: the renkei platform tools (agents, cards, knowledge) plus
 * the agent scratch space. `logs` is deliberately left out — it's not
 * something a chat should reach for without the person opting in.
 */
export const CHAT_CORE_CONNECTORS: readonly string[] = ['agents', 'cards', 'knowledge', 'sandbox'];

/** Always offered whatever the toolset, because they carry no connector risk. */
export const CHAT_ALWAYS_TOOLS: readonly string[] = ['whoami'];

/**
 * On in every chat of a code project, whatever the toolset says: the
 * project's repository lives on Bitbucket, and the code_* tools stop at
 * the push — opening the pull request, reading its comments, watching
 * the pipeline are the connector's own tools. A code chat without them
 * would be told by its own prompt to call bitbucket_create_pull_request
 * and have nowhere to find it. The picker shows these checked and locked.
 */
export const CODE_PROJECT_CONNECTORS: readonly string[] = ['atlassian-bitbucket'];

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
  project: ChatToolConfig | null,
  userDefault: ChatToolConfig | null = null
): ChatToolConfig {
  return chat ?? project ?? userDefault ?? defaultToolConfig();
}

/**
 * The toolset with `required` on as well — a fresh config, sorted like a
 * parsed one, so a chat's own choice never turns a required connector off.
 */
export function withRequiredConnectors(
  config: ChatToolConfig,
  required: readonly string[]
): ChatToolConfig {
  return { connectors: [...new Set([...config.connectors, ...required])].sort() };
}

/** What a chat in this project gets: its toolset, plus what the project's kind requires. */
export function projectToolConfig(
  config: ChatToolConfig,
  projectKind: 'chat' | 'code' | null | undefined
): ChatToolConfig {
  return projectKind === 'code' ? withRequiredConnectors(config, CODE_PROJECT_CONNECTORS) : config;
}

/** The jsonb form — a fresh literal, since the pg driver serializes objects itself. */
export function toolConfigJson(config: ChatToolConfig): { connectors: string[] } {
  return { connectors: [...config.connectors] };
}
