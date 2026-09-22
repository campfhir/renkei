/**
 * Which connectors a chat offers the model — the per-chat/per-project
 * toolset. Stored as jsonb on the chat and the project; the chat's own
 * setting wins, the project's applies to chats without one, and what
 * applies when neither says depends on where the chat is: an ordinary
 * chat starts from the person's own saved chat default (tool-prefs.ts),
 * else the core set; a code project's chat starts from the person's own
 * saved code-project default, else the code default — the connectors a
 * developer's work reaches for. The two personal defaults are separate
 * preferences: one saved with mail and tickets in mind never leaks into
 * the other. A new code project is given its owner's code default at
 * creation, so most code chats find a toolset on their project.
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
export const CHAT_ALWAYS_TOOLS: readonly string[] = ['whoami', 'resolve_date'];

/**
 * On in every chat of a code project, whatever the toolset says: the
 * project's repository lives on Bitbucket or GitHub, and the code_*
 * tools stop at the push — opening the pull request, reading its
 * comments, watching the pipeline/workflow are the connector's own
 * tools. A code chat without them would be told by its own prompt to
 * call bitbucket_create_pull_request or github_create_pull_request and
 * have nowhere to find it. Both ride along on every code project
 * regardless of which one actually backs it — locking a connector
 * nobody connected is harmless (it simply registers no tools, same as
 * any other unconnected entry in a chosen toolset), and it spares every
 * caller here from having to know the project's repo provider just to
 * build its default toolset. The picker shows these checked and locked.
 */
export const CODE_PROJECT_CONNECTORS: readonly string[] = ['atlassian-bitbucket', 'github'];

/**
 * Where a code project's chat starts when neither it nor its project has
 * chosen a toolset: the repository's host, the tracker and the wiki the
 * work is described in, the organization's knowledge, and the sandbox's
 * browser and fetch for anything at a URL. Not the platform's own agents
 * and cards, which an ordinary chat starts with and a developer's chat
 * has no call for. What a person's own code-project default starts from
 * (tool-prefs.ts) and falls back to. Sorted, like a parsed config.
 */
export const CODE_PROJECT_DEFAULT_CONNECTORS: readonly string[] = [
  'atlassian-bitbucket',
  'atlassian-confluence',
  'github',
  'jira',
  'knowledge',
  'sandbox',
];

/**
 * What a code project's chat is offered UP FRONT, on every request, rather
 * than behind find_tools (tool-surface.ts): the core connectors' tools as
 * in any chat, plus the pull-request and pipeline tools of Bitbucket by
 * name — the calls the code brief names outright, so the model never has
 * to search for how to open the pull request it was told to open. The
 * rest of Bitbucket (repositories, permissions, source browsing) and all
 * of Jira and Confluence stay discoverable: one call away, never in the
 * prompt's prefix on every turn.
 */
export const CODE_PROJECT_EAGER_TOOLS: readonly string[] = [
  'bitbucket_create_pull_request',
  'bitbucket_get_pull_request',
  'bitbucket_list_pull_requests',
  'bitbucket_update_pull_request',
  'bitbucket_get_pull_request_diff',
  'bitbucket_list_pr_comments',
  'bitbucket_add_pr_comment',
  'bitbucket_merge_pull_request',
  'bitbucket_list_pipelines',
  'bitbucket_get_pipeline',
  'bitbucket_get_pipeline_step_log',
  // The GitHub equivalents — named here too so a GitHub-backed project
  // gets the same eager treatment; naming a tool that never registers
  // (the project's repository is on the other host) costs nothing, the
  // same reasoning as CODE_PROJECT_CONNECTORS carrying both.
  'github_create_pull_request',
  'github_get_pull_request',
  'github_list_pull_requests',
  'github_update_pull_request',
  'github_get_pull_request_diff',
  'github_list_pr_comments',
  'github_add_pr_comment',
  'github_merge_pull_request',
  'github_list_workflow_runs',
  'github_get_workflow_run',
  'github_get_workflow_job_log',
];

/** Which default a chat falls back to: an ordinary chat's, or a code project's. */
export type ToolDefaultsKind = 'chat' | 'code';

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

export function defaultToolConfig(kind: ToolDefaultsKind = 'chat'): ChatToolConfig {
  return {
    connectors: [...(kind === 'code' ? CODE_PROJECT_DEFAULT_CONNECTORS : CHAT_CORE_CONNECTORS)],
  };
}

/**
 * The toolset a chat runs with: its own, else its project's, else the
 * person's saved default OF THIS KIND (the caller reads the right one —
 * tool-prefs.ts keeps two), else the built-in default for the kind.
 */
export function effectiveToolConfig(
  chat: ChatToolConfig | null,
  project: ChatToolConfig | null,
  userDefault: ChatToolConfig | null = null,
  kind: ToolDefaultsKind = 'chat'
): ChatToolConfig {
  return chat ?? project ?? userDefault ?? defaultToolConfig(kind);
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
