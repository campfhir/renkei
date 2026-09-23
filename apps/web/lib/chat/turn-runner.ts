/**
 * One turn of the chat: the model answers, calls tools, answers again,
 * until it stops calling tools or a limit says enough.
 *
 * Everything the loop touches is behind an interface — the model (any
 * LlmProvider, via streamOrComplete), the tools (an McpClient and the
 * local set), the rows (TurnStore), the live channel — so the loop is
 * tested against fakes and the same code runs for real. The loop itself
 * is deliberately plain:
 *
 *   stream the reply into the current assistant row, mirroring every
 *   event to the channel and flushing the row on a timer;
 *   if the reply ended with tool calls, run them — reads side by side,
 *   anything that acts alone and in order, and only once the owner has
 *   allowed it (below) — store the results as a user-role `tool_results`
 *   row, open a fresh assistant row, and go again;
 *   if the reply said nothing at all — no text, no tool call, just a
 *   thought — quietly ask the model to try again rather than finish on
 *   it, up to MAX_SILENT_RETRIES times, whatever stopped it;
 *   otherwise finish.
 *
 * Permission. A call that changes something — anything the catalog does
 * not vouch for as read-only — is not run until the person says so. The
 * runner writes the ask to the turn row (store.requestToolPermission,
 * which also raises the notification), announces it on the stream, and
 * waits: for the channel (the decision route, same process), for the row
 * (any replica, polled), for Stop, or for the clock. "Always" is the
 * person's standing answer for that tool name, kept in their preferences
 * by the route and honoured here for the rest of the turn; "deny" and a
 * timeout feed the model a refusal in place of a result, so it can say
 * so rather than pretend. The wait does not count against the turn's
 * wall clock — a person away from their desk is not the model being
 * slow — but has a budget of its own, permissionWaitMs, shared by every
 * ask in the turn.
 *
 * Cancel is checked between chunks (the channel aborts the in-flight
 * request) and between tool calls (the heartbeat reads the row, so a
 * cancel clicked on another replica lands within a flush interval).
 * A crash leaves the rows `streaming`/`running` for the janitor.
 */

import {
  streamOrComplete,
  wireRequestCauseOf,
  type LlmContentBlock,
  type LlmErrorKind,
  type LlmMessage,
  type LlmStreamEvent,
  type LlmToolDef,
  type LlmUsage,
  type ResolvedLlm,
} from '@renkei/agent-llm';
import { randomUUID } from 'node:crypto';
import { secure } from '@/lib/logger';
import type { McpClient, McpToolResult } from '@renkei/mcp-client';
import type { LocalToolContext, LocalToolSet } from './local-tools';
import type { ChatStreamEvent } from './stream-events';
import type { TurnChannel } from './turn-events';
import type { AttachmentView, PendingToolPermission, ToolPermissionDecision } from './views';
import { toChatBlock } from './views';
import type { MessageStatus, TurnStatus } from './views';

export interface TurnStore {
  /** Appends a row at the chat's next seq; returns its id, seq and time. */
  appendMessage(input: {
    role: 'user' | 'assistant';
    kind: 'assistant' | 'tool_results' | 'nudge';
    status: MessageStatus;
    blocks: LlmContentBlock[];
  }): Promise<{ id: string; seq: number; createdAt: Date }>;
  flushAssistant(
    id: string,
    blocks: LlmContentBlock[],
    patch: {
      status?: MessageStatus;
      stopReason?: string | null;
      usage?: LlmUsage | null;
      error?: string | null;
    }
  ): Promise<void>;
  /**
   * Refreshes the turn's liveness; true when a cancel was requested.
   * `stage` is what the loop is doing right now ('model', 'tool:<name>'),
   * null between rounds — persisted so a turn that never comes back says
   * where it was stuck, not just that it stopped.
   */
  heartbeat(iterations: number, stage: string | null): Promise<boolean>;
  finishTurn(outcome: TurnOutcome): Promise<void>;
  recordUsage(usage: LlmUsage): Promise<void>;
  /**
   * Keeps the files a tool round handed back, hung off the results row;
   * returns what was kept (an unconfigured store keeps nothing).
   */
  storeArtifacts(messageId: string, files: ArtifactFile[]): Promise<AttachmentView[]>;
  /**
   * Parks the turn behind this call: the ask goes on the turn row (where
   * a reload, a reconnect or another replica finds it) and out as a
   * notification for a person who is not looking. `input` is for the
   * notification's wording only; the row keeps the ids.
   */
  requestToolPermission(ask: PendingToolPermission & { input: unknown }): Promise<void>;
  /** The answer on the row for this ask, or null while it is still open. */
  readToolPermission(toolUseId: string): Promise<ToolPermissionDecision | null>;
  /** Nothing pending any more — answered, timed out, or the turn is over. */
  clearToolPermission(): Promise<void>;
}

/** A file a tool produced, as it came back in `_meta.renkeiDocuments`. */
export interface ArtifactFile {
  filename: string;
  mediaType: string;
  dataBase64: string;
}

export interface TurnOutcome {
  status: Exclude<TurnStatus, 'running'>;
  error: string | null;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
}

export interface TurnLimits {
  wallClockMs: number;
  maxIterations: number;
  flushMs: number;
  toolTimeoutMs: number;
  /**
   * How many read-only tool calls of one round run at once. A reply that
   * searches three ways at once waits for the slowest search, not the sum;
   * calls that act never share a slot (see toolGroups).
   */
  toolConcurrency: number;
  /** Tool results longer than this are clipped before they reach the model. */
  toolResultMaxChars: number;
  attachmentMaxBlocks: number;
  attachmentMaxBase64Chars: number;
  /**
   * How long, in total across the turn, the runner waits for the person
   * to allow or deny the calls that need asking. Not part of wallClockMs
   * (the wait is theirs, not the model's); an ask still open when this
   * runs out is answered 'timeout' and the model told the call was not
   * made.
   */
  permissionWaitMs: number;
  /** How often the row is re-read for an answer from another replica. */
  permissionPollMs: number;
}

export const DEFAULT_TURN_LIMITS: TurnLimits = {
  wallClockMs: 10 * 60_000,
  maxIterations: 25,
  flushMs: 250,
  toolTimeoutMs: 120_000,
  toolConcurrency: 4,
  toolResultMaxChars: 60_000,
  attachmentMaxBlocks: 2,
  attachmentMaxBase64Chars: 6_000_000,
  permissionWaitMs: 60 * 60_000,
  permissionPollMs: 2_000,
};

/**
 * How many times a reply that said nothing — thought, and then just
 * stopped, whatever the stop reason — is quietly asked to try again
 * before the turn gives up and ends on it. See `silentRetries` in
 * runChatTurn.
 */
export const MAX_SILENT_RETRIES = 2;

/** What the runner tells the model in its own place when this happens. */
export const SILENT_REPLY_NUDGE =
  'Your last reply stopped without saying anything to the person or calling a tool — it only got as far as thinking. Answer them directly now.';

/**
 * How many times a model call that failed before it produced a single byte
 * — no block_start ever reached the channel — is retried on a fresh
 * connection before the turn gives up on it. This is aimed squarely at the
 * gap a tool permission ask leaves behind: the wait can run anywhere from
 * a couple of seconds to the whole permissionWaitMs budget with no traffic
 * to the model provider at all, and a pooled HTTP connection idle that
 * long is exactly the kind a gateway or load balancer between us and the
 * provider has often already dropped. The next request reusing it then
 * fails immediately — not because the model or the request was bad, but
 * because the wire underneath it was stale. Retrying is safe here
 * specifically because nothing was shown to the person yet to contradict;
 * bounded so a genuinely unreachable provider still fails the turn rather
 * than retrying forever.
 */
const MAX_MODEL_CALL_RETRIES = 1;

/** Error kinds worth that retry: a transport-level hiccup, not the provider
 *  actually answering "no". */
const RETRYABLE_MODEL_ERROR_KINDS = new Set<LlmErrorKind>(['network', 'provider_error']);

/**
 * The turn's permission policy. Absent, nothing asks — the runner then
 * runs every call as it always did, which is what a test against fakes
 * and a caller with its own gate want. Present, every call the runner
 * cannot vouch for as read-only (readOnlyTools) asks unless its name is
 * in `alwaysAllowed`, which grows with every 'always' the person answers.
 */
export interface TurnPermissions {
  alwaysAllowed: ReadonlySet<string>;
  /**
   * Auto mode (auto-mode.ts): nothing asks. Every call runs as if the
   * person had said "always" for it — except the tools in `denied`,
   * which stay refused. The person chose this for the chat.
   */
  allowAll?: boolean;
  /**
   * Tools the person blocked outright (permission-prefs.ts). The surface
   * never offers these, so a call can only come from the model's memory
   * of an earlier turn — refused without asking, and said so.
   */
  denied?: ReadonlySet<string>;
}

/** What the model is told in place of a result for a call that was not made. */
export const PERMISSION_DENIED_RESULT =
  'The person declined this tool call, so it was not made. Do not retry it or work around it; tell them what you were going to do and ask how they would like to proceed.';
export const PERMISSION_TIMEOUT_RESULT =
  'Nobody allowed this tool call in time, so it was not made. Tell the person what you were going to do; they can ask again when they are ready.';
export const PERMISSION_BLOCKED_RESULT =
  'The person has blocked this tool in their preferences, so it cannot be used in this chat. Do not retry it or work around it; tell them what you were going to do and let them decide.';
/**
 * What the model is told in place of a result for a tool call whose
 * arguments were cut off mid-stream (the reply hit its output-token
 * ceiling while still emitting this call's JSON) — see `truncatedToolIds`
 * in runChatTurn. The call is never made: the arguments the accumulator
 * would parse from a cut-off buffer collapse to `{}` (stream-accumulator.ts),
 * which for a write tool with required fields either fails validation in
 * a way that hides the real cause, or — worse — silently "succeeds" with
 * missing data. Telling the model plainly, so it shrinks the call instead
 * of quietly resending the same oversized one.
 */
export const TOOL_CALL_TRUNCATED_RESULT =
  "This call's arguments were cut off before they finished — the reply ran out of room mid-call, so it was not made. Retry with a smaller or more focused call (e.g. fewer steps at once, or a narrower patch tool instead of one call for everything).";

/**
 * Auto mode's other half (auto-mode.ts): a turn that hands work to a
 * sub-agent (`subagentTool`) does not end when the model stops talking
 * without a successful call to `doneTool` — that is answered by the
 * runner itself with `nudge` as a user-role row of kind 'nudge', and the
 * loop goes again — in the same turn, so Stop, the wall clock and the
 * iteration cap still bound it. After `maxContinues` nudges the turn
 * completes as it is. A turn that never called `subagentTool` is never
 * nudged: nothing was handed off to come back and check on.
 */
export interface AutoContinue {
  doneTool: string;
  nudge: string;
  maxContinues: number;
  /** The tool that delegates work to a sub-agent — see the type doc. */
  subagentTool: string;
}

export interface TurnRunnerDeps {
  llm: ResolvedLlm;
  tools: LlmToolDef[];
  mcp: McpClient | null;
  localTools: LocalToolSet;
  localContext: LocalToolContext;
  /**
   * Tool names that only read (the catalog's `kind`, a local tool's
   * `readOnly`). Only these may run beside each other; a name absent here
   * is taken to act, and runs alone. Omitted means every call runs alone.
   */
  readOnlyTools?: ReadonlySet<string>;
  /**
   * The MCP Apps widget each tool's result renders as, by tool name
   * (tool-surface.ts's `ChatToolSurface.widgetResourceUris`). A call whose
   * name is a key here has its outcome's `structuredContent` and this
   * resourceUri stamped onto its tool_result block, so the thread renders
   * the card instead of the result's raw text. Omitted means no tool has
   * one — every result renders as plain text.
   */
  widgetResourceUris?: ReadonlyMap<string, string>;
  /**
   * Tools the chat has enabled but does not offer up front (tool-surface.ts's
   * `discoverable`). A call the model makes to one of these by name — from
   * memory of an earlier turn, its schema absent from this request — puts the
   * tool in the active set, so the reply that follows has its schema.
   */
  discoverableTools?: LlmToolDef[];
  /** See TurnPermissions; omitted means no call ever asks. */
  permissions?: TurnPermissions;
  /** See AutoContinue; omitted means a reply without tool calls ends the turn. */
  autoContinue?: AutoContinue;
  channel: TurnChannel;
  store: TurnStore;
  now?: () => number;
  limits?: Partial<TurnLimits>;
  /**
   * `level` defaults to 'warn' (every existing call site, and the no-op
   * default below, only ever meant that). 'debug' is for the tool-call
   * attempt/outcome trace below — routine, not a warning, but real
   * evidence of what the chat actually did, kept for whoever turns the
   * log level down to answer "did it even try?" after the fact.
   */
  log?: (
    message: string,
    fields: Record<string, unknown>,
    level?: 'debug' | 'warn' | 'error'
  ) => void;
}

/**
 * A step the turn takes before the model speaks — a code project's
 * clone — shown and kept exactly like a tool call the model made: a
 * tool_use block the runner writes, the pending state while it runs,
 * its result row, and a fresh assistant row for the reply after it.
 * The model sees the pair in its history like any other round.
 */
export interface PreludeStep {
  name: string;
  input: Record<string, unknown>;
  run: () => Promise<McpToolResult>;
}

export interface TurnInput {
  turnId: string;
  assistantMessage: { id: string; seq: number; createdAt: Date };
  system: string;
  history: LlmMessage[];
  thinkingBudget: number | null;
  prelude?: PreludeStep[];
}

const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const EXTENSION_BY_MEDIA_TYPE: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'text/tab-separated-values': '.tsv',
  'text/markdown': '.md',
  'text/html': '.html',
  'application/json': '.json',
  'application/xml': '.xml',
  'application/yaml': '.yaml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
};

/**
 * Every file a tool handed back in `_meta.renkeiDocuments`, for keeping —
 * unlike `attachmentBlocksOfMeta`, which picks what the model gets to see
 * under the turn's budget. A file without a title is named after the tool.
 */
export function artifactsOfMeta(
  meta: Record<string, unknown>,
  toolName: string,
  ordinal: number
): ArtifactFile[] {
  const raw = meta.renkeiDocuments;
  if (!Array.isArray(raw)) return [];
  const out: ArtifactFile[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record: { mediaType?: unknown; dataBase64?: unknown; title?: unknown } = entry;
    if (typeof record.mediaType !== 'string' || typeof record.dataBase64 !== 'string') continue;
    if (!record.dataBase64) continue;
    const title = typeof record.title === 'string' && record.title.trim() ? record.title : null;
    const extension = EXTENSION_BY_MEDIA_TYPE[record.mediaType] ?? '';
    out.push({
      filename: title ?? `${toolName}-${ordinal}-${out.length + 1}${extension}`,
      mediaType: record.mediaType,
      dataBase64: record.dataBase64,
    });
  }
  return out;
}

/**
 * Tool schemas a discovery tool (tool-discovery.ts's find_tools) handed
 * back via `_meta.discoveredTools` — new tools the model may call for the
 * rest of this turn, folded into the active tool set below rather than
 * offered on every turn from the start.
 */
export function discoveredToolsOfMeta(meta: Record<string, unknown>): LlmToolDef[] {
  const raw = meta.discoveredTools;
  if (!Array.isArray(raw)) return [];
  const out: LlmToolDef[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record: { name?: unknown; description?: unknown; inputSchema?: unknown } = entry;
    if (typeof record.name !== 'string' || typeof record.description !== 'string') continue;
    if (typeof record.inputSchema !== 'object' || record.inputSchema === null) continue;
    if (Array.isArray(record.inputSchema)) continue;
    const inputSchema: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record.inputSchema)) inputSchema[key] = value;
    out.push({ name: record.name, description: record.description, inputSchema });
  }
  return out;
}

/**
 * Document/image blocks a tool handed back in `_meta.renkeiDocuments` —
 * the agents engine's rule, under the chat's smaller budget. A tool that
 * sets `renkeiDocumentsShown: false` keeps its files (artifactsOfMeta
 * still sees them) without the model reading them back: the file the
 * model itself just wrote is the case, and re-reading it on every later
 * turn would be tokens for nothing.
 */
export function attachmentBlocksOfMeta(
  meta: Record<string, unknown>,
  budget: { blocks: number; base64Chars: number },
  limits: TurnLimits
): LlmContentBlock[] {
  const raw = meta.renkeiDocuments;
  if (!Array.isArray(raw)) return [];
  if (meta.renkeiDocumentsShown === false) return [];
  const out: LlmContentBlock[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record: { mediaType?: unknown; dataBase64?: unknown; title?: unknown } = entry;
    if (typeof record.mediaType !== 'string' || typeof record.dataBase64 !== 'string') continue;
    if (!record.dataBase64) continue;
    if (budget.blocks >= limits.attachmentMaxBlocks) break;
    if (budget.base64Chars + record.dataBase64.length > limits.attachmentMaxBase64Chars) continue;
    const title = typeof record.title === 'string' && record.title ? record.title : undefined;
    if (record.mediaType === 'application/pdf') {
      out.push({
        type: 'document',
        mediaType: record.mediaType,
        dataBase64: record.dataBase64,
        ...(title ? { title } : {}),
      });
    } else if (IMAGE_MEDIA_TYPES.has(record.mediaType)) {
      out.push({ type: 'image', mediaType: record.mediaType, dataBase64: record.dataBase64 });
    } else {
      continue;
    }
    budget.blocks += 1;
    budget.base64Chars += record.dataBase64.length;
  }
  return out;
}

/**
 * The order a round's tool calls run in: each inner array runs at once,
 * the arrays one after another. Consecutive read-only calls share an
 * array, cut at `width`; every other call — anything that acts, or that
 * the caller could not vouch for — gets an array of its own, so its
 * effect is complete before the next call that might read it. The
 * model's order is kept within and across arrays, so results can be
 * assembled in the order the calls were made whatever order they finish.
 */
export function toolGroups<T>(
  uses: readonly T[],
  isReadOnly: (use: T) => boolean,
  width: number
): T[][] {
  const groups: T[][] = [];
  let run: T[] = [];
  for (const use of uses) {
    if (width > 1 && isReadOnly(use)) {
      if (run.length >= width) {
        groups.push(run);
        run = [];
      }
      run.push(use);
      continue;
    }
    if (run.length > 0) {
      groups.push(run);
      run = [];
    }
    groups.push([use]);
  }
  if (run.length > 0) groups.push(run);
  return groups;
}

export function textOfResult(result: McpToolResult): string {
  return result.content
    .flatMap((block) => (typeof block.text === 'string' ? [block.text] : []))
    .join('\n');
}

export function friendlyLlmError(kind: LlmErrorKind): string {
  switch (kind) {
    case 'auth':
      return "The organization's model key was rejected. An administrator can check it under Agent models.";
    case 'rate_limit':
      return 'The model provider is rate-limiting requests. Try again in a moment.';
    case 'overloaded':
      return 'The model provider is overloaded right now. Try again in a moment.';
    case 'invalid_request':
      return 'The model rejected the request. If this keeps happening with one model, try another.';
    case 'timeout':
      return 'The model took too long to answer.';
    case 'network':
      return 'The model provider could not be reached.';
    case 'aborted':
      return 'Stopped.';
    default:
      return 'The model provider returned an error.';
  }
}

/**
 * Bounds a promise that has no cancellation of its own (a local tool's
 * `execute`, unlike an MCP call, carries no AbortSignal). The loser keeps
 * running orphaned in the background — nothing here can stop it — but the
 * turn is no longer held hostage to it, and the rejection is a real error
 * the caller's own catch logs, not a heartbeat that quietly outlives it.
 */
function raceTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function clip(text: string, max: number): string {
  return text.length > max
    ? `${text.slice(0, max)}\n…[${text.length - max} more characters clipped]`
    : text;
}

/**
 * How much of a tool call's arguments or result rides on a debug log line —
 * matches the connectors' own request/response logging (mcp-tools/common.ts):
 * a secure()-marked value past ~2KB of ciphertext falls into blob storage,
 * which the log viewer does not decrypt on read, so this keeps it inline.
 */
const LOG_BODY_MAX_CHARS = 1300;

/**
 * How much of the actual model request rides on an error log line — the
 * agents engine's own PROMPT_DETAIL_CHARS scale, not the tight
 * LOG_BODY_MAX_CHARS above: a tool call's arguments are a few hundred
 * bytes, but a rejected request is the whole point of the log line, and
 * clipping it to 1300 chars would cut off the very tool definitions or
 * settings most likely to be the actual cause. This is exactly the class
 * of guess this exists to end — see wireRequestCauseOf's doc.
 */
const REQUEST_LOG_MAX_CHARS = 40_000;

/**
 * Whether a tool_use block's raw streamed JSON never finished — non-empty
 * text that does not parse. The accumulator (stream-accumulator.ts)
 * already resolves this the lenient way, to `{}`, for a call that
 * genuinely completed with no arguments and for one whose stream was cut
 * alike; this is the one place that tells the two apart, from the raw
 * text `mirror` kept as input_json_delta events arrived (see its
 * `partialJson` doc below).
 */
function isTruncatedToolInput(raw: string | undefined): boolean {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return false;
  try {
    JSON.parse(trimmed);
    return false;
  } catch {
    return true;
  }
}

/** A mirrored block's raw streamed args, if it is a tool_use block at all. */
function mirroredPartialJson(block: LlmContentBlock | undefined): string | undefined {
  return block?.type === 'tool_use' ? block.partialJson : undefined;
}

function argsOf(input: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    for (const [key, value] of Object.entries(input)) out[key] = value;
  }
  return out;
}

export async function runChatTurn(deps: TurnRunnerDeps, input: TurnInput): Promise<TurnOutcome> {
  const limits: TurnLimits = { ...DEFAULT_TURN_LIMITS, ...deps.limits };
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  // `let`: every permission wait pushes it out by exactly the time waited.
  let deadline = now() + limits.wallClockMs;
  const { channel, store, llm } = deps;
  const readOnlyTools = deps.readOnlyTools ?? new Set<string>();
  const widgetResourceUris = deps.widgetResourceUris ?? new Map<string, string>();
  const alwaysAllowed = new Set(deps.permissions?.alwaysAllowed ?? []);
  const denied = deps.permissions?.denied ?? new Set<string>();
  const needsPermission = (name: string) =>
    deps.permissions !== undefined &&
    deps.permissions.allowAll !== true &&
    !denied.has(name) &&
    !readOnlyTools.has(name) &&
    !alwaysAllowed.has(name);
  let permissionWaited = 0;
  // Auto mode: whether the model has marked the task finished this turn,
  // how many times it has been told to carry on, and whether it has
  // handed any work to a sub-agent yet. Only a sub-agent leaves work that
  // can legitimately be mid-flight when the model stops talking; a reply
  // that only answered directly (a question, an edit it made itself) is
  // finished the moment it ends, so it is never nudged into inventing a
  // task_complete call for nothing.
  let taskDone = false;
  let continues = 0;
  let spawnedSubagent = false;
  // A reply that stopped without any text or tool call — a thought and
  // nothing else, whether it ran out of room mid-thinking or the model
  // simply stopped there — has left the person with nothing to read.
  // That is never actually "done", auto mode or not, so the runner
  // quietly asks the model to try again rather than ending the turn on
  // it and making the person type "continue" themselves, turn after
  // turn. Bounded so a chat that never manages an answer does not loop
  // forever.
  let silentRetries = 0;

  const messages: LlmMessage[] = [...input.history];
  let assistant = input.assistantMessage;
  let blocks: LlmContentBlock[] = [];
  let dirty = false;
  let iterations = 0;
  // Grows as find_tools (tool-discovery.ts) surfaces more of the chat's
  // enabled connectors; every discovery is callable from the very next
  // model reply onward. Earlier turns' discoveries arrive already in
  // deps.tools (start-turn.ts recalls them from the history).
  const activeTools: LlmToolDef[] = [...deps.tools];
  const activeToolNames = new Set(activeTools.map((tool) => tool.name));
  const discoverableByName = new Map(
    (deps.discoverableTools ?? []).map((tool) => [tool.name, tool] as const)
  );
  const activate = (tool: LlmToolDef) => {
    if (activeToolNames.has(tool.name)) return;
    activeToolNames.add(tool.name);
    activeTools.push(tool);
  };
  const totals = { inputTokens: 0, outputTokens: 0 };
  const attachmentBudget = { blocks: 0, base64Chars: 0 };
  let cancelRequested = false;
  // What the loop is doing right now, for the heartbeat to persist — see
  // TurnStore.heartbeat. Read fresh on every tick, so it always reflects
  // the stage in flight when the tick fires, not the stage when the timer
  // was set up.
  let stage: string | null = null;

  const emit = (event: ChatStreamEvent) => channel.emit(event);

  const flush = async (patch: Parameters<TurnStore['flushAssistant']>[2] = {}) => {
    dirty = false;
    await store.flushAssistant(assistant.id, blocks, patch);
  };

  // The heartbeat doubles as the flush timer: liveness and durability on
  // the same cadence, and a cancel from another replica read on the way.
  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    if (dirty) void flush();
    if (tick % 8 === 0) {
      void store.heartbeat(iterations, stage).then((requested) => {
        if (requested) {
          cancelRequested = true;
          channel.requestCancel();
        }
      });
    }
  }, limits.flushMs);
  channel.onCancel(() => {
    cancelRequested = true;
  });

  const finalize = async (
    status: TurnOutcome['status'],
    error: string | null,
    assistantStatus: MessageStatus
  ): Promise<TurnOutcome> => {
    clearInterval(timer);
    await flush({ status: assistantStatus, error });
    emit({
      type: 'message_end',
      messageId: assistant.id,
      status: assistantStatus,
      stopReason: null,
      usage: null,
      error,
    });
    const outcome: TurnOutcome = { status, error, iterations, ...totals };
    await store.finishTurn(outcome);
    emit({ type: 'turn_end', turnId: input.turnId, status, error });
    channel.close();
    return outcome;
  };

  const announceAssistant = () =>
    emit({
      type: 'message_start',
      messageId: assistant.id,
      turnId: input.turnId,
      seq: assistant.seq,
      role: 'assistant',
      kind: 'assistant',
      llmModelId: llm.modelConfigId,
      provider: llm.providerName,
      model: llm.model,
      createdAt: assistant.createdAt.toISOString(),
    });

  /**
   * The tool_results row after a round: stored, streamed, pushed into the
   * conversation, and the files it carried kept.
   */
  const appendResultsRow = async (resultBlocks: LlmContentBlock[], produced: ArtifactFile[]) => {
    const resultsRow = await store.appendMessage({
      role: 'user',
      kind: 'tool_results',
      status: 'complete',
      blocks: resultBlocks,
    });
    emit({
      type: 'message_start',
      messageId: resultsRow.id,
      turnId: input.turnId,
      seq: resultsRow.seq,
      role: 'user',
      kind: 'tool_results',
      llmModelId: null,
      provider: null,
      model: null,
      createdAt: resultsRow.createdAt.toISOString(),
    });
    resultBlocks.forEach((block, index) => {
      emit({ type: 'block_start', messageId: resultsRow.id, index, block: toChatBlock(block) });
      emit({ type: 'block_stop', messageId: resultsRow.id, index });
    });
    emit({
      type: 'message_end',
      messageId: resultsRow.id,
      status: 'complete',
      stopReason: null,
      usage: null,
      error: null,
    });
    messages.push({ role: 'user', content: resultBlocks });
    if (produced.length > 0) {
      try {
        for (const artifact of await store.storeArtifacts(resultsRow.id, produced)) {
          emit({ type: 'artifact', messageId: resultsRow.id, attachment: artifact });
        }
      } catch (error) {
        // A file that could not be kept is not a reason to stop answering.
        log('chat artifact not stored: {message}', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  /**
   * Auto mode's word to carry on: a user-role row the runner writes in
   * the person's place, stored, streamed and pushed into the conversation
   * like a prompt — but of kind 'nudge', so the thread shows it as a
   * note rather than as something the person typed.
   */
  const appendNudgeRow = async (text: string) => {
    const block: LlmContentBlock = { type: 'text', text };
    const row = await store.appendMessage({
      role: 'user',
      kind: 'nudge',
      status: 'complete',
      blocks: [block],
    });
    emit({
      type: 'message_start',
      messageId: row.id,
      turnId: input.turnId,
      seq: row.seq,
      role: 'user',
      kind: 'nudge',
      llmModelId: null,
      provider: null,
      model: null,
      createdAt: row.createdAt.toISOString(),
    });
    emit({ type: 'block_start', messageId: row.id, index: 0, block: toChatBlock(block) });
    emit({ type: 'block_stop', messageId: row.id, index: 0 });
    emit({
      type: 'message_end',
      messageId: row.id,
      status: 'complete',
      stopReason: null,
      usage: null,
      error: null,
    });
    messages.push({ role: 'user', content: [block] });
  };

  /** A fresh assistant row for the next reply, announced. */
  const startNextAssistant = async () => {
    const nextRow = await store.appendMessage({
      role: 'assistant',
      kind: 'assistant',
      status: 'streaming',
      blocks: [],
    });
    assistant = nextRow;
    blocks = [];
    dirty = false;
    announceAssistant();
  };

  /**
   * Park the turn behind one call and wait for the answer. Resolves with
   * the person's decision, 'timeout' when the turn's wait budget runs out
   * first, or 'canceled' when Stop arrives meanwhile (the caller then
   * ends the turn the way any cancel between calls does). The wall clock
   * is paused for exactly the time waited.
   */
  const askPermission = async (
    use: Extract<LlmContentBlock, { type: 'tool_use' }>
  ): Promise<ToolPermissionDecision | 'timeout' | 'canceled'> => {
    const ask: PendingToolPermission = {
      toolUseId: use.id,
      messageId: assistant.id,
      name: use.name,
      requestedAt: new Date().toISOString(),
    };
    stage = `permission:${use.name}`;
    await store.requestToolPermission({ ...ask, input: use.input });
    emit({ type: 'tool_permission_request', turnId: input.turnId, permission: ask });
    const startedAt = now();
    const budget = Math.max(0, limits.permissionWaitMs - permissionWaited);
    const answer = await new Promise<ToolPermissionDecision | 'timeout' | 'canceled'>((resolve) => {
      let settled = false;
      let cleanup = () => {};
      const finish = (decision: ToolPermissionDecision | 'timeout' | 'canceled') => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(decision);
      };
      const unsubscribe = channel.onToolPermission((answered) => {
        if (answered.toolUseId === use.id) finish(answered.decision);
      });
      const timer = setTimeout(() => finish('timeout'), budget);
      const poll = setInterval(() => {
        void store
          .readToolPermission(use.id)
          .then((decision) => {
            if (decision) finish(decision);
          })
          .catch(() => {
            // A failed read is retried on the next tick; the channel
            // and the clock still end the wait.
          });
      }, limits.permissionPollMs);
      cleanup = () => {
        unsubscribe();
        clearTimeout(timer);
        clearInterval(poll);
      };
      // Registered last: a cancel already requested fires this at once.
      channel.onCancel(() => finish('canceled'));
    });
    const waited = now() - startedAt;
    permissionWaited += waited;
    deadline += waited;
    stage = null;
    try {
      await store.clearToolPermission();
    } catch (error) {
      log('chat tool permission not cleared: {message}', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (answer !== 'canceled') {
      emit({
        type: 'tool_permission_decided',
        turnId: input.turnId,
        toolUseId: use.id,
        decision: answer,
      });
    }
    if (answer === 'always') alwaysAllowed.add(use.name);
    return answer;
  };

  announceAssistant();

  try {
    for (const step of input.prelude ?? []) {
      if (cancelRequested || channel.cancelRequested)
        return await finalize('canceled', null, 'canceled');
      const use: LlmContentBlock = {
        type: 'tool_use',
        id: `prelude_${randomUUID()}`,
        name: step.name,
        input: step.input,
      };
      blocks = [use];
      emit({ type: 'block_start', messageId: assistant.id, index: 0, block: toChatBlock(use) });
      emit({ type: 'block_stop', messageId: assistant.id, index: 0, block: toChatBlock(use) });
      await flush({ status: 'complete', stopReason: 'tool_use', usage: null, error: null });
      emit({
        type: 'message_end',
        messageId: assistant.id,
        status: 'complete',
        stopReason: 'tool_use',
        usage: null,
        error: null,
      });
      messages.push({ role: 'assistant', content: [use] });
      emit({ type: 'tool_call_start', messageId: assistant.id, toolUseId: use.id, name: use.name });
      let outcome: McpToolResult;
      try {
        outcome = await step.run();
      } catch (error) {
        outcome = {
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          isError: true,
          meta: {},
        };
      }
      const text = textOfResult(outcome);
      await appendResultsRow(
        [
          {
            type: 'tool_result',
            toolUseId: use.id,
            content: clip(
              text || (outcome.isError ? 'The step failed.' : '(no output)'),
              limits.toolResultMaxChars
            ),
            ...(outcome.isError ? { isError: true } : {}),
          },
        ],
        []
      );
      await startNextAssistant();
    }

    for (;;) {
      if (cancelRequested || channel.cancelRequested)
        return await finalize('canceled', null, 'canceled');
      if (now() > deadline) {
        return await finalize(
          'interrupted',
          'The reply exceeded its time budget and was stopped.',
          'interrupted'
        );
      }
      if (iterations >= limits.maxIterations) {
        return await finalize(
          'failed',
          'The reply made too many tool calls in one turn.',
          'failed'
        );
      }
      iterations += 1;

      // A block's final form (tool input parsed) is what the accumulator
      // holds; mirror it to the view on block_stop.
      const mirror = (event: LlmStreamEvent) => {
        switch (event.type) {
          case 'block_start':
            blocks[event.index] = { ...event.block };
            emit({
              type: 'block_start',
              messageId: assistant.id,
              index: event.index,
              block: toChatBlock(event.block),
            });
            break;
          case 'text_delta': {
            const block = blocks[event.index];
            if (block?.type === 'text')
              blocks[event.index] = { type: 'text', text: block.text + event.text };
            emit({
              type: 'text_delta',
              messageId: assistant.id,
              index: event.index,
              text: event.text,
            });
            break;
          }
          case 'thinking_delta': {
            const block = blocks[event.index];
            if (block?.type === 'thinking') {
              blocks[event.index] = { ...block, thinking: block.thinking + event.thinking };
            }
            emit({
              type: 'thinking_delta',
              messageId: assistant.id,
              index: event.index,
              thinking: event.thinking,
            });
            break;
          }
          case 'signature_delta': {
            const block = blocks[event.index];
            if (block?.type === 'thinking') {
              blocks[event.index] = {
                ...block,
                signature: (block.signature ?? '') + event.signature,
              };
            }
            break;
          }
          case 'input_json_delta': {
            // Kept on the block itself, not just mirrored to the channel:
            // if the request ends (timeout, error, cancel) before this
            // block's own block_stop, `blocks` below is what gets
            // persisted, and it would otherwise still be the `{}`
            // placeholder block_start opened with — see LlmContentBlock's
            // `partialJson` doc. A normal finish replaces the whole block
            // from the assembled reply (below), which never carries this,
            // so it never lingers on a call that actually completed.
            const block = blocks[event.index];
            if (block?.type === 'tool_use') {
              blocks[event.index] = {
                ...block,
                partialJson: (block.partialJson ?? '') + event.partialJson,
              };
            }
            emit({
              type: 'input_json_delta',
              messageId: assistant.id,
              index: event.index,
              partialJson: event.partialJson,
            });
            break;
          }
          case 'block_stop':
            // The parsed input arrives with the assembled response below;
            // the view learns it there.
            break;
          default:
            break;
        }
        dirty = true;
      };

      stage = 'model';
      // Assigned unconditionally on every loop entry below, before any
      // break — never read until after that first assignment has run.
      let result!: Awaited<ReturnType<typeof streamOrComplete>>;
      for (let attempt = 0; ; attempt += 1) {
        const controller = new AbortController();
        channel.onCancel(() => controller.abort());
        result = await streamOrComplete(
          llm.provider,
          {
            system: input.system,
            messages,
            tools: activeTools,
            ...(activeTools.length > 0 ? { toolChoice: 'auto' as const } : {}),
            maxTokens: llm.maxOutputTokens,
            ...(llm.temperature !== undefined ? { temperature: llm.temperature } : {}),
            ...(input.thinkingBudget ? { thinking: { budgetTokens: input.thinkingBudget } } : {}),
            promptCache: true,
            timeoutMs: 300_000,
          },
          { onEvent: mirror, signal: controller.signal }
        );
        if (result.ok) break;
        if (result.err.type === 'aborted' || cancelRequested) break;
        // Nothing reached the channel for this attempt (blocks is still
        // whatever startNextAssistant left it as — see MAX_MODEL_CALL_RETRIES),
        // the failure is the transport's own kind, and there is budget left:
        // one more try on a fresh connection before this counts as a real
        // failure.
        if (
          blocks.length > 0 ||
          !RETRYABLE_MODEL_ERROR_KINDS.has(result.err.type) ||
          attempt >= MAX_MODEL_CALL_RETRIES
        ) {
          break;
        }
        log(
          'chat turn model call failed before any output; retrying ({attempt} of {max}): {kind}',
          {
            attempt: attempt + 1,
            max: MAX_MODEL_CALL_RETRIES,
            kind: result.err.type,
            message: result.err.message ?? '',
          }
        );
      }
      stage = null;

      if (!result.ok) {
        if (result.err.type === 'aborted' || cancelRequested) {
          return await finalize('canceled', null, 'canceled');
        }
        {
          const cause = wireRequestCauseOf(result.err.cause);
          log(
            'chat turn model error: {kind} {message}',
            {
              kind: result.err.type,
              message: result.err.message ?? '',
              ...(cause
                ? {
                    request: secure(
                      clip(JSON.stringify(cause.request), REQUEST_LOG_MAX_CHARS)
                    ),
                  }
                : {}),
            },
            'error'
          );
        }
        return await finalize('failed', friendlyLlmError(result.err.type), 'failed');
      }

      const reply = result.val;
      totals.inputTokens += reply.usage.inputTokens;
      totals.outputTokens += reply.usage.outputTokens;
      await store.recordUsage(reply.usage);
      // The mirror's own blocks, one last time before they are replaced
      // below — its `partialJson` is the raw text `mirror` saw stream in
      // for each tool_use block, which is how a call cut off mid-argument
      // (ran out of output room) is told apart from one that legitimately
      // took no arguments: both parse to the assembled reply's `{}`, but
      // only the cut-off one fails to parse here. See `truncatedToolIds`.
      const streamedBlocks = blocks;
      // The assembled response is canonical: tool input parsed, nothing
      // the mirror might have missed.
      blocks = reply.content;
      const truncatedToolIds = new Set(
        reply.content
          .filter(
            (block, index): block is Extract<LlmContentBlock, { type: 'tool_use' }> =>
              block.type === 'tool_use' &&
              isTruncatedToolInput(mirroredPartialJson(streamedBlocks[index]))
          )
          .map((block) => block.id)
      );
      reply.content.forEach((block, index) => {
        if (block.type === 'tool_use') {
          emit({ type: 'block_stop', messageId: assistant.id, index, block: toChatBlock(block) });
        } else {
          emit({ type: 'block_stop', messageId: assistant.id, index });
        }
      });
      await flush({
        status: 'complete',
        stopReason: reply.stopReason,
        usage: reply.usage,
        error: null,
      });
      emit({
        type: 'message_end',
        messageId: assistant.id,
        status: 'complete',
        stopReason: reply.stopReason,
        usage: reply.usage,
        error: null,
      });
      messages.push({ role: 'assistant', content: reply.content });

      const toolUses = reply.content.filter(
        (block): block is Extract<LlmContentBlock, { type: 'tool_use' }> =>
          block.type === 'tool_use'
      );
      const subagentTool = deps.autoContinue?.subagentTool;
      if (subagentTool && toolUses.some((use) => use.name === subagentTool)) {
        spawnedSubagent = true;
      }
      // A thought and nothing else leaves nothing for the person to
      // read — that is not a finished reply in any chat, auto mode or
      // not, whatever stop reason came back with it. Try again a
      // bounded number of times before falling back to ending the turn
      // as it stands.
      const hasAnswer = reply.content.some(
        (block) => (block.type === 'text' && block.text.trim() !== '') || block.type === 'tool_use'
      );
      if (!hasAnswer && silentRetries < MAX_SILENT_RETRIES) {
        silentRetries += 1;
        log('chat turn said nothing; retrying ({count} of {max})', {
          count: silentRetries,
          max: MAX_SILENT_RETRIES,
        });
        await appendNudgeRow(SILENT_REPLY_NUDGE);
        await startNextAssistant();
        continue;
      }
      // Whether to run a tool round turns on toolUses itself, not
      // stopReason: the two agree for every normal reply (both providers
      // map "tool call(s) present, stream finished cleanly" to
      // stopReason 'tool_use' — openai.ts/anthropic.ts stopReasonOf), but
      // they diverge exactly when a call's own arguments were cut off by
      // running out of output room mid-stream — stopReason comes back
      // 'max_tokens' even though the truncated block is still sitting in
      // toolUses. Skipping the tool round there, as `stopReason !==
      // 'tool_use'` used to, silently ended the turn without ever
      // running or refusing that call — no error, no retry, nothing for
      // the person to see. It still gets refused below (truncatedToolIds
      // / refused), just no longer skipped outright.
      if (toolUses.length === 0) {
        // Auto mode: the model stopped, but the task is not marked done —
        // tell it to carry on and go again, within this same turn. Only
        // once a sub-agent has actually been spawned: see spawnedSubagent
        // above for why anything else needs no completion ceremony.
        const auto = deps.autoContinue;
        if (auto && !taskDone && spawnedSubagent && continues < auto.maxContinues) {
          continues += 1;
          log('chat auto mode: nudging the model on ({count} of {max})', {
            count: continues,
            max: auto.maxContinues,
          });
          await appendNudgeRow(auto.nudge);
          await startNextAssistant();
          continue;
        }
        clearInterval(timer);
        const outcome: TurnOutcome = { status: 'completed', error: null, iterations, ...totals };
        await store.finishTurn(outcome);
        emit({ type: 'turn_end', turnId: input.turnId, status: 'completed', error: null });
        channel.close();
        return outcome;
      }

      // A call to a tool the chat has enabled but did not offer this turn
      // is the model remembering it from a turn before, schema and all —
      // it gets the real schema from the next request on, so a retry after
      // a type mismatch is made against it rather than from memory again.
      for (const use of toolUses) {
        const discoverable = discoverableByName.get(use.name);
        if (discoverable) activate(discoverable);
      }

      // Tool round. Calls that only read run side by side: a reply that
      // searches knowledge three ways is the common case, and each search
      // is an embedding call, a query and a live access check that none
      // of the others waits on. Anything that acts runs alone and in
      // order, like the engine — its effect may be what the next call
      // reads. Results are assembled in the model's order whatever order
      // the calls finish in, and the attachment budget is spent in that
      // order too, so the transcript reads the same as when they ran one
      // by one.
      const results: LlmContentBlock[] = [];
      const attachments: LlmContentBlock[] = [];
      const produced: ArtifactFile[] = [];
      // Calls the person did not allow, or whose own arguments never
      // finished streaming: answered with a refusal, never run.
      const refused = new Map<string, 'deny' | 'timeout' | 'blocked' | 'truncated'>();
      for (const use of toolUses) {
        if (denied.has(use.name)) refused.set(use.id, 'blocked');
        else if (truncatedToolIds.has(use.id)) refused.set(use.id, 'truncated');
      }
      const runTool = async (use: (typeof toolUses)[number]): Promise<McpToolResult> => {
        const refusal = refused.get(use.id);
        if (refusal) {
          log(
            'chat tool call refused: {tool} {reason}',
            {
              tool: use.name,
              toolUseId: use.id,
              reason: refusal,
            },
            'debug'
          );
          return {
            content: [
              {
                type: 'text',
                text:
                  refusal === 'deny'
                    ? PERMISSION_DENIED_RESULT
                    : refusal === 'blocked'
                      ? PERMISSION_BLOCKED_RESULT
                      : refusal === 'truncated'
                        ? TOOL_CALL_TRUNCATED_RESULT
                        : PERMISSION_TIMEOUT_RESULT,
              },
            ],
            isError: true,
            meta: {},
          };
        }
        // A record that the call actually happened, whatever comes of it —
        // the transcript alone cannot answer "did it even try?" once a
        // reply is interrupted or its stored blocks lose the arguments
        // (see the LlmContentBlock.partialJson doc); this always can, at
        // the cost of turning the chat's own log level down to see it.
        log(
          'chat tool call: {tool}',
          {
            tool: use.name,
            toolUseId: use.id,
            local: deps.localTools.has(use.name),
            input: secure(clip(JSON.stringify(use.input ?? {}), LOG_BODY_MAX_CHARS)),
          },
          'debug'
        );
        const logOutcome = (outcome: McpToolResult) => {
          log(
            'chat tool call outcome: {tool} {isError}',
            {
              tool: use.name,
              toolUseId: use.id,
              isError: outcome.isError === true,
              result: secure(clip(textOfResult(outcome), LOG_BODY_MAX_CHARS)),
            },
            'debug'
          );
          return outcome;
        };
        try {
          if (deps.localTools.has(use.name)) {
            // Unlike an MCP call, a local tool has no AbortSignal of its own —
            // it is an in-process await with nothing to cancel it. Race it
            // against a budget so a local tool that never settles can't hold
            // the turn (and its heartbeat) open forever; the orphaned call
            // keeps running, but the loop moves on. Most tools share the
            // turn's own default; one that runs a bounded loop of its own
            // (a sub-agent) declares a longer budget so this race does not
            // fire — and orphan it — while it is still legitimately working.
            return logOutcome(
              await raceTimeout(
                deps.localTools.run(use.name, use.input, {
                  ...deps.localContext,
                  toolUseId: use.id,
                  // A sub-agent (code_delegate) spends its own model calls
                  // through this sink rather than the loop above, so its
                  // usage never reaches `totals` on its own — fold it in
                  // here, once, so the turn's outcome (and chat_turns) count
                  // what delegation actually cost.
                  recordUsage: deps.localContext.recordUsage
                    ? async (usage: LlmUsage) => {
                        totals.inputTokens += usage.inputTokens;
                        totals.outputTokens += usage.outputTokens;
                        await deps.localContext.recordUsage!(usage);
                      }
                    : undefined,
                }),
                deps.localTools.timeoutMsFor(use.name) ?? limits.toolTimeoutMs,
                `local tool ${use.name} timed out`
              )
            );
          }
          if (deps.mcp) {
            return logOutcome(
              await deps.mcp.callTool(use.name, argsOf(use.input), limits.toolTimeoutMs)
            );
          }
          return logOutcome({
            content: [
              { type: 'text', text: `The tool ${use.name} is not available in this chat.` },
            ],
            isError: true,
            meta: {},
          });
        } catch (error) {
          log('chat tool call failed: {tool} {message}', {
            tool: use.name,
            message: error instanceof Error ? error.message : String(error),
          });
          return {
            content: [{ type: 'text', text: 'The tool could not be reached.' }],
            isError: true,
            meta: {},
          };
        }
      };
      const groups = toolGroups(
        toolUses,
        (use) => readOnlyTools.has(use.name),
        limits.toolConcurrency
      );
      for (const group of groups) {
        if (cancelRequested || channel.cancelRequested) break;
        // A call that acts is alone in its group (toolGroups), so at most
        // one ask per group — asked before the group's calls are
        // announced as running, since a refused one never runs.
        let canceledWhileAsking = false;
        for (const use of group) {
          if (refused.has(use.id) || !needsPermission(use.name)) continue;
          const answer = await askPermission(use);
          if (answer === 'canceled') {
            canceledWhileAsking = true;
            break;
          }
          if (answer === 'deny' || answer === 'timeout') refused.set(use.id, answer);
        }
        if (canceledWhileAsking || cancelRequested || channel.cancelRequested) break;
        for (const use of group) {
          if (refused.has(use.id)) continue;
          emit({
            type: 'tool_call_start',
            messageId: assistant.id,
            toolUseId: use.id,
            name: use.name,
          });
        }
        stage = `tool:${group.map((use) => use.name).join(',')}`;
        const outcomes = await Promise.all(group.map(runTool));
        stage = null;
        for (const [index, use] of group.entries()) {
          const outcome = outcomes[index];
          if (deps.autoContinue && use.name === deps.autoContinue.doneTool && !outcome.isError) {
            taskDone = true;
          }
          const text = textOfResult(outcome);
          // A call whose tool declared a widget (tools/list's
          // _meta.ui.resourceUri, carried here as widgetResourceUris) gets
          // that binding stamped on its result whether or not the call
          // itself errored — the card template renders its own error
          // state from `structuredContent`/`isError` (issue-preview.ts and
          // friends), same as an external MCP Apps host would route it.
          const resourceUri = widgetResourceUris.get(use.name);
          results.push({
            type: 'tool_result',
            toolUseId: use.id,
            content: clip(
              text || (outcome.isError ? 'The tool failed.' : '(no output)'),
              limits.toolResultMaxChars
            ),
            ...(outcome.isError ? { isError: true } : {}),
            ...(resourceUri ? { uiResourceUri: resourceUri } : {}),
            ...(resourceUri && 'structuredContent' in outcome
              ? { structuredContent: outcome.structuredContent }
              : {}),
          });
          attachments.push(...attachmentBlocksOfMeta(outcome.meta, attachmentBudget, limits));
          produced.push(...artifactsOfMeta(outcome.meta, use.name, iterations));
          for (const discovered of discoveredToolsOfMeta(outcome.meta)) activate(discovered);
        }
      }
      if (cancelRequested || channel.cancelRequested) {
        // Whatever ran, ran; the transcript keeps the calls without answers
        // and the history builder drops the dangling tool_use next time.
        clearInterval(timer);
        const outcome: TurnOutcome = { status: 'canceled', error: null, iterations, ...totals };
        await store.finishTurn(outcome);
        emit({ type: 'turn_end', turnId: input.turnId, status: 'canceled', error: null });
        channel.close();
        return outcome;
      }
      // Every tool_use must be answered; a break above cannot leave one
      // unanswered because we returned.
      await appendResultsRow([...results, ...attachments], produced);
      await startNextAssistant();
    }
  } catch (error) {
    log('chat turn crashed: {message}', {
      message: error instanceof Error ? error.message : String(error),
    });
    try {
      return await finalize('failed', 'Something went wrong while answering.', 'failed');
    } catch {
      clearInterval(timer);
      channel.close();
      return {
        status: 'failed',
        error: 'Something went wrong while answering.',
        iterations,
        ...totals,
      };
    }
  }
}
