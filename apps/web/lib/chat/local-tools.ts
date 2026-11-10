/**
 * Tools the chat executes in-process rather than over MCP: they act on
 * chat-owned state (attachments, project memory) that the MCP surface has
 * no reason to know about. Each is an ordinary tool definition the model
 * sees alongside the MCP ones, plus an executor the runner dispatches to
 * first — a local name shadows nothing, because none of them collide with
 * the connector prefixes.
 */

import type { LlmToolDef, LlmUsage, ResolvedLlm } from '@renkei/agent-llm';
import type { LlmCallModel } from '@renkei/agents/runs';
import type { McpToolResult } from '@renkei/mcp-client';
import type { ImageUsageReport } from '@/lib/image/usage';
import type { SubagentRecorder } from './subagent-runs';
import type { ContentCipher } from './content-crypto';
import type { WidgetDecisionState } from './views';
import type { ActorFields } from '@renkei/db';
import { logger } from '@/lib/logger';

export interface LocalToolContext {
  subject: string;
  /**
   * The person behind `subject` as a log line names them (docs/logging.md),
   * resolved by the server-side turn that builds this context. Resolved
   * HERE, not looked up here: this module is shared with the browser bundle
   * (a UI model imports its result helpers), so it may import nothing that
   * reaches the data store. Absent, lines name the subject.
   */
  actor?: ActorFields;
  /**
   * The roles of the session the turn runs as: what a chat suspended on its
   * tasks (tasks/wake.ts) is woken with. Absent, a woken turn has none.
   */
  roles?: string[];
  /**
   * Who is acting on the chat's task list (tasks/tools.ts): the chat's own
   * model, or a sub-agent it handed work to. Absent means the chat's model.
   */
  taskActor?: 'assistant' | 'subagent';
  /**
   * Keeps the turn's tool surface (its MCP token) alive past the turn's own
   * end, for work the turn started in the background (a background
   * sub-agent, chat-delegate.ts); call the returned function when that
   * work is done. Absent, nothing may outlive the turn.
   */
  holdTurn?: () => () => void;
  chatId: string;
  /** How this chat's rows are sealed and opened (access.cipher). */
  cipher: ContentCipher;
  projectId: string | null;
  /** A temporary chat (temporary.ts): no memory or recall tools. */
  temporary?: boolean;
  /**
   * The sandbox scratch space this chat stages in (sandbox-scope.ts), the
   * same one its token gives the sandbox_* tools; absent, the person's own.
   */
  sandboxScope?: string;
  /** The project's cipher (its memory and files), when the chat is in one. */
  projectCipher?: ContentCipher;
  /**
   * Where the person reaches the app, scheme and host with no trailing
   * slash (lib/get-origin.ts) — what a link handed to them starts with,
   * since the app stands behind a proxy and a path alone would not survive
   * being copied out of the thread. Absent, a tool resolves the
   * deployment's declared address itself.
   */
  origin?: string;
  /** The person's IANA zone, from their browser; absent or null, days are cut in UTC. */
  timeZone?: string | null;
  /** The person's email from the identity spine, when known — a commit author needs one. */
  userEmail?: string | null;
  /** Org read-only mode: local tools that write refuse under it. */
  readOnly: boolean;
  /**
   * The model answering this turn, for a tool that runs a bounded loop
   * of its own (a code project's sub-agent); absent, such tools refuse.
   */
  llm?: ResolvedLlm;
  /**
   * Where a nested loop's token usage is recorded — the turn's own sink.
   * `model` is what spent it when that is not the turn's own model (a
   * sub-agent on a model of its own); absent, the turn's model is stamped.
   */
  /**
   * The person's own message that opened this turn, word for word — what
   * the image tool sends to the image model as the prompt. Absent when
   * there is no such message; the tool then refuses.
   */
  userPrompt?: string;
  /** Where a picture drawn for the person is counted (lib/image/usage.ts), the turn's own sink. */
  recordImageUsage?: (report: ImageUsageReport) => Promise<void>;
  recordUsage?: (
    usage: LlmUsage,
    model?: LlmCallModel | null,
    /** Wall time of the model call the usage came from, for the ledger. */
    durationMs?: number
  ) => Promise<void>;
  /**
   * Where a tool that runs a long-ish operation of its own (chat_compact)
   * reports live progress — the turn's own channel, already open. Absent
   * for a context with no turn behind it (none today).
   */
  emitProgress?: (progress: { foldedSoFar: number; totalToFold: number }) => void;
  /**
   * Where a tool that settles a preview card on the model's behalf
   * (chat_widget_resolve, widget-state-tools.ts) announces the receipt —
   * the turn's own channel again, so the card open in the thread flips
   * to that receipt as the tool returns rather than on the next reload.
   * Absent for a context with no turn behind it.
   */
  emitWidgetDecision?: (decision: { stateKey: string; state: WidgetDecisionState }) => void;
  /**
   * Where a tool that changed the person's preferences
   * (renkei_set_preferences, platform-tools/preferences.ts) says which
   * documents moved — the turn's own channel again, so the page open on
   * the thread re-renders what depends on them (the theme, the line-number
   * gutter, the default toolset) as the tool returns rather than on the
   * next full load. Absent for a context with no turn behind it.
   */
  emitPreferencesChanged?: (change: { documents: string[] }) => void;
  /**
   * The id of the tool_use block being answered — the runner sets it per
   * call, so a tool that keeps a record of its own (a sub-agent's run)
   * can key that record to the call the thread shows.
   */
  toolUseId?: string;
  /** Where a code chat's sub-agents record their runs (subagent-runs.ts); absent, they do not. */
  subagents?: SubagentRecorder;
  /**
   * Fires when the turn is stopped — the person's Stop, or the process
   * shutting down — while this call is in flight. A tool that waits on
   * something long (a command on the sandbox, a sub-agent's loop) passes
   * it down so the work actually stops, rather than running on unseen
   * after the turn has ended; a tool that answers in a moment can ignore
   * it. Absent for a context with no turn behind it.
   */
  signal?: AbortSignal;
}

export interface LocalTool {
  def: LlmToolDef;
  /**
   * The tool changes nothing — the runner may run it beside other reads
   * of the same round instead of waiting its turn. Absent means it acts.
   */
  readOnly?: boolean;
  /**
   * The tool acts, but several calls of it in one round do not depend on
   * each other, so the runner runs them side by side rather than one
   * after another (a code project's sub-agents: each is a loop of its
   * own that can run for an hour). Each call is still asked for where
   * acting calls are.
   */
  concurrent?: boolean;
  /**
   * Overrides the turn's own `toolTimeoutMs` for this call. Almost every
   * local tool finishes in seconds and is well served by the turn's
   * default; a tool that runs a bounded loop of its own (a code project's
   * sub-agent) can legitimately take far longer, and racing it against
   * the ordinary default would abandon it mid-work — orphaning it to keep
   * running unseen while the caller is told it failed. Absent, the turn's
   * own limit applies.
   */
  timeoutMs?: number;
  /**
   * Not offered up front: the tool's schema reaches the model only once
   * find_tools (tool-discovery.ts) surfaces it, the way an enabled
   * connector's tools beyond the core set do. For tools every chat has
   * but few turns need (platform-tools/), so their schemas do not ride on
   * every request. Absent, the tool is offered on every turn.
   */
  deferred?: boolean;
  execute(input: Record<string, unknown>, context: LocalToolContext): Promise<McpToolResult>;
}

export interface LocalToolSet {
  has(name: string): boolean;
  /** The tools offered up front — a `deferred` tool is in the set but not here. */
  defs(): LlmToolDef[];
  /** The names of the tools declared read-only. */
  readOnlyNames(): string[];
  /** The names of the acting tools whose calls may run beside each other. */
  concurrentNames(): string[];
  /** This tool's own timeout override, or null when the turn's own limit applies. */
  timeoutMsFor(name: string): number | null;
  run(name: string, input: unknown, context: LocalToolContext): Promise<McpToolResult>;
}

/**
 * A result's meta key asking the runner to end the turn once this round's
 * results are written, as a reply with no calls would (chat_task_wait:
 * the chat suspends until its tasks finish, tasks/wake.ts).
 */
export const END_TURN_META = 'endTurn';

/** Whether a call's result asked the turn to end after its round. */
export function endsTurn(result: McpToolResult): boolean {
  return !result.isError && result.meta?.[END_TURN_META] === true;
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
    defs: () =>
      [...byName.values()].filter((tool) => tool.deferred !== true).map((tool) => tool.def),
    readOnlyNames: () =>
      [...byName.values()].filter((tool) => tool.readOnly === true).map((tool) => tool.def.name),
    concurrentNames: () =>
      [...byName.values()]
        .filter((tool) => tool.concurrent === true && tool.readOnly !== true)
        .map((tool) => tool.def.name),
    timeoutMsFor: (name) => byName.get(name)?.timeoutMs ?? null,
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
        logger.error(
          "the tool {tool} threw in {actor}'s chat; the model was told it failed: {error}",
          {
            component: 'chat/tools',
            ...(context.actor ?? {
              subject: context.subject,
              user: context.subject,
              email: null,
              actor: context.subject,
            }),
            chatId: context.chatId,
            tool: name,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          }
        );
        return errorResult(
          `${name} failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  };
}
