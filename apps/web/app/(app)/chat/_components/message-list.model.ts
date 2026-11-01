/**
 * How a chat thread's messages read, with no React and no DOM: which rows
 * make one turn, what each tool call's line and card say and in which
 * state, what a run of work folds into, what a sub-agent's or a
 * milestone's card shows, what Copy offers, what the permission card's
 * buttons say while an answer is on its way, and when the reader counts
 * as "at the bottom". message-list.tsx renders from these and keeps the
 * scroller, the clipboard and the timers. Tested in
 * message-list.model.test.ts.
 *
 * What a reply is cut into (text, folds, cards) is segment()'s
 * (lib/chat/segment.ts); what Copy puts on the clipboard is
 * lib/chat/copy-text.ts's. This module decides what the screen makes of
 * those.
 */

import { friendlyToolName } from '@/lib/tool-name';
import type { CompactionProgress, SubagentProgress } from '@/lib/chat/stream-events';
import type { Segment, ToolResult, WorkStep } from '@/lib/chat/segment';
import { contextCopyText, promptText, replyCalls, replyCopyText } from '@/lib/chat/copy-text';
import { IMAGE_TOOL } from '@/lib/chat/image-size';
import { imageArtifactFor } from '@/lib/chat/image-artifact';
import type {
  AttachmentView,
  ChatBlock,
  ChatMessageView,
  ToolPermissionDecision,
  TurnView,
} from '@/lib/chat/views';
import { formatDurationMs } from '@/lib/duration';
import { parseCommitResult } from '@/lib/code/chat-commits';
import {
  milestoneSentence,
  milestoneSummary,
  type MilestoneLink,
  type MilestoneState,
} from '@/lib/code/milestones';
import { codeToolLabel, gitGlyphFor } from '@/lib/code/tool-labels';
import { parseTaskCompletion, TASK_COMPLETE_TOOL } from '@/lib/chat/auto-mode';
import { CHAT_RENAME_TOOL } from '@/lib/chat/titles';
import { CHAT_DELEGATE_TOOL, isSubagentTool } from '@/lib/chat/subagent-tools';

export type Call = Extract<WorkStep, { kind: 'call' }>;
export type ToolUseBlock = Extract<ChatBlock, { type: 'tool_use' }>;

// ── The thread ──────────────────────────────────────────────────────────

export interface TurnGroup {
  key: string;
  prompts: ChatMessageView[];
  replies: ChatMessageView[];
}

/** Consecutive rows of one turn, prompts apart from the reply's rows. */
export function groupTurns(messages: ChatMessageView[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  for (const message of messages) {
    const key = message.turnId ?? message.id;
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      group = { key, prompts: [], replies: [] };
      groups.push(group);
    }
    if (message.kind === 'prompt') group.prompts.push(message);
    else group.replies.push(message);
  }
  return groups;
}

/** Every tool result in the thread, by the call it answers. */
export function resultsById(messages: ChatMessageView[]): Map<string, ToolResult> {
  const map = new Map<string, ToolResult>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool_result') map.set(block.toolUseId, block);
    }
  }
  return map;
}

/**
 * Which tool_results row answered each call: the file a call kept carries
 * that row's id, which is how its picture is found again (image-artifact.ts).
 */
export function resultRowsById(messages: ChatMessageView[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool_result') map.set(block.toolUseId, message.id);
    }
  }
  return map;
}

/** How close to the foot, in pixels, still counts as reading the latest. */
export const PIN_SLACK_PX = 48;

/**
 * Whether the reader is at the bottom of the thread — and so whether the
 * thread keeps following the stream for them, or offers "Jump to latest".
 */
export function isAtBottom(box: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight < PIN_SLACK_PX;
}

/** The line under the thread when a turn ended badly, if it says why. */
export function turnErrorLine(turn: TurnView | null): string | null {
  if (!turn || turn.status === 'running' || turn.status === 'completed') return null;
  return turn.error || null;
}

/** What a compaction card says, and how far along its bar is (null: no count to show). */
export function compactionView(progress: CompactionProgress): {
  label: string;
  percent: number | null;
} {
  const { status, foldedSoFar, totalToFold } = progress;
  const percent = totalToFold > 0 ? Math.round((foldedSoFar / totalToFold) * 100) : null;
  const label =
    status === 'running'
      ? percent !== null
        ? `Compacting the conversation… ${foldedSoFar} of ${totalToFold}`
        : 'Compacting the conversation…'
      : status === 'failed'
        ? 'Compaction failed.'
        : totalToFold > 0
          ? `Compacted ${totalToFold} earlier message${totalToFold === 1 ? '' : 's'} into a summary.`
          : 'Nothing to compact — the conversation is already tight.';
  return { label, percent };
}

// ── A reply ─────────────────────────────────────────────────────────────

/**
 * The calls of the latest tool-calling row that have not been answered.
 * While the turn runs these are still in flight, whatever the stream
 * said: a snapshot (a reconnect, a phone coming back to the tab) clears
 * `pendingToolCalls`, and only the LAST segment counts as the tail — so
 * an earlier sub-agent card, still working beside a later one, would
 * otherwise read "failed". Calls of an earlier row always have their
 * results by the time the model went on, so only the latest row can hold
 * any that are open.
 */
export function openCallsOfLatestRow(
  messages: ChatMessageView[],
  results: ReadonlyMap<string, ToolResult>
): Set<string> {
  let open = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const uses = message.blocks.filter((block) => block.type === 'tool_use');
    if (uses.length === 0) continue;
    open = new Set(uses.filter((block) => !results.has(block.id)).map((block) => block.id));
  }
  return open;
}

/** The call a permission ask is about, for the card to show its input. */
export function askedCall(messages: ChatMessageView[], toolUseId: string): ToolUseBlock | null {
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool_use' && block.id === toolUseId) return block;
    }
  }
  return null;
}

/** What decides a call's state while a reply is on screen. */
export interface CallContext {
  /** The tool_use id the turn is parked behind, waiting for permission. */
  waitingOn: string | null;
  /** Calls the stream says are running right now. */
  pendingToolCalls: readonly string[];
  /** The step is at the live end of a streaming reply. */
  live: boolean;
}

/**
 * A call's state as a step inside a work fold: waiting on the person,
 * running, failed, or done. A call with no result that is neither waiting
 * nor running reads as done ("Called X"): in a fold, the run went on.
 */
export function foldCallState(step: Call, context: CallContext): MilestoneState {
  if (step.result) return step.result.isError ? 'failed' : 'done';
  if (context.waitingOn === step.block.id) return 'waiting';
  if (context.live || context.pendingToolCalls.includes(step.block.id)) return 'pending';
  return 'done';
}

/**
 * A card's state (a sub-agent, a milestone, an image): the same as a
 * fold's, except that a call still open in the latest row of a streaming
 * reply is running, and one left with no result at all failed — a card
 * stands for the call alone, and nothing came back.
 */
export function cardState(
  step: Call,
  context: CallContext & { streaming: boolean; inFlight: ReadonlySet<string> }
): MilestoneState {
  const state = foldCallState(step, {
    ...context,
    live: context.live || (context.streaming && context.inFlight.has(step.block.id)),
  });
  return state === 'done' && !step.result ? 'failed' : state;
}

/** The tool's name as shown: the code tools' own, else the generic one. */
export function toolLabel(name: string): string {
  return codeToolLabel(name)?.label ?? friendlyToolName(name, null);
}

/**
 * One tool call's line: "Calling X", "Called X", "Failed: X", "Waiting for
 * permission to call X" — or, for a step that reads as a sentence (the
 * clone), that sentence.
 */
export type CallLine =
  { kind: 'sentence'; text: string } | { kind: 'verb'; verb: string; label: string };

export function callLine(name: string, state: MilestoneState): CallLine {
  const own = codeToolLabel(name);
  const sentence =
    own &&
    state !== 'waiting' &&
    (state === 'pending' ? own.pending : state === 'done' ? own.done : own.failed);
  if (sentence) return { kind: 'sentence', text: sentence };
  const verb =
    state === 'pending'
      ? 'Calling '
      : state === 'failed'
        ? 'Failed: '
        : state === 'waiting'
          ? 'Waiting for permission to call '
          : 'Called ';
  return { kind: 'verb', verb, label: toolLabel(name) };
}

/** The icon a tool call gets: a name in message-list.tsx's icon set. */
export type ToolIcon =
  | 'package'
  | 'check'
  | 'pencil'
  | 'memory'
  | 'gitClone'
  | 'gitCommit'
  | 'gitPush'
  | 'gitPull'
  | 'gitBranch'
  | 'gitCheckout'
  | 'gitMerge'
  | 'gitRebase'
  | 'gitStash'
  | 'gitPullRequest'
  | 'diff'
  | 'terminal'
  | 'group'
  | 'file'
  | 'history'
  | 'image'
  | 'tool';

const GIT_ICONS = {
  clone: 'gitClone',
  commit: 'gitCommit',
  push: 'gitPush',
  pull: 'gitPull',
  branch: 'gitBranch',
  checkout: 'gitCheckout',
  merge: 'gitMerge',
  rebase: 'gitRebase',
  stash: 'gitStash',
  pullRequest: 'gitPullRequest',
} as const;

/**
 * A tool call's icon, by name: memory tools get the bookmark, recalling
 * another chat gets the history glyph, everything else the plain wrench —
 * so the two verbs a person actually cares about (something was
 * remembered, an old chat was reached into) stand out from the general
 * run of tool calls at a glance.
 */
export function toolIconFor(name: string): ToolIcon {
  if (name === 'chat_compact') return 'package';
  if (name === TASK_COMPLETE_TOOL) return 'check';
  if (name === CHAT_RENAME_TOOL) return 'pencil';
  if (name.startsWith('project_memory_') || name.startsWith('chat_memory_')) return 'memory';
  const git = gitGlyphFor(name);
  if (git) return GIT_ICONS[git];
  if (name === 'code_write_file' || name === 'code_edit_file') return 'diff';
  if (name === 'code_run') return 'terminal';
  if (isSubagentTool(name)) return 'group';
  if (name.startsWith('code_')) return 'file';
  if (name === 'chat_recall_chats') return 'history';
  if (name === IMAGE_TOOL) return 'image';
  return 'tool';
}

/** A call's input as the fold shows it: the streaming JSON as it came, else the input pretty-printed. */
export function callInputText(block: ToolUseBlock): string {
  return block.partialJson ?? JSON.stringify(block.input, null, 2);
}

/** What a work fold's line says. */
export type FoldLabel =
  | { kind: 'waiting'; name: string; line: CallLine }
  | { kind: 'pending'; name: string; line: CallLine }
  | { kind: 'thinking' }
  | { kind: 'summary'; text: string };

export interface WorkFoldView {
  /** The steps listed inside: thinking with no text has nothing to show. */
  shown: WorkStep[];
  callCount: number;
  /** The most recently resolved call failed — the fold reads as an error. */
  failed: boolean;
  icon: 'brain' | 'tool';
  label: FoldLabel;
  /** There is something to unfold; otherwise the fold is a plain line. */
  foldable: boolean;
}

/**
 * One collapsed line for a run of thinking and tool calls. While the run
 * is live the line says what is happening right now; once it is over,
 * what the run was ("Thought · 3 tool calls · 2s model, 1s tools"). Only
 * the most recently resolved call decides the error styling — an early
 * failure a later call superseded doesn't paint the whole group red.
 */
export function workFoldView(
  steps: WorkStep[],
  context: CallContext & { modelMs: number }
): WorkFoldView {
  const shown = steps.filter((step) => step.kind !== 'thinking' || step.text.trim() !== '');
  const calls = shown.filter((step): step is Call => step.kind === 'call');
  const thought = shown.some((step) => step.kind !== 'call');
  const lastResolvedCall = [...calls].reverse().find((step) => step.result);
  const failed = lastResolvedCall?.result?.isError ?? false;
  const current = steps[steps.length - 1];

  let label: FoldLabel;
  if (context.live && current) {
    const state = current.kind === 'call' ? foldCallState(current, context) : null;
    label =
      current.kind === 'call' && state === 'waiting'
        ? {
            kind: 'waiting',
            name: current.block.name,
            line: callLine(current.block.name, 'waiting'),
          }
        : current.kind === 'call' && state === 'pending'
          ? {
              kind: 'pending',
              name: current.block.name,
              line: callLine(current.block.name, 'pending'),
            }
          : { kind: 'thinking' };
  } else {
    const parts: string[] = [];
    if (thought) parts.push('Thought');
    if (calls.length > 0) parts.push(`${calls.length} tool call${calls.length === 1 ? '' : 's'}`);
    // Where the time went, when the rows kept it: the model's own calls
    // apart from the tools they waited on, so a slow reply can be read as
    // "thinking" or "a slow tool" from the line itself.
    const toolMs = calls.reduce((sum, step) => sum + (step.result?.durationMs ?? 0), 0);
    const timing: string[] = [];
    if (context.modelMs > 0) timing.push(`${formatDurationMs(context.modelMs)} model`);
    if (toolMs > 0) timing.push(`${formatDurationMs(toolMs)} tools`);
    if (timing.length > 0) parts.push(timing.join(', '));
    label = { kind: 'summary', text: parts.length > 0 ? parts.join(' · ') : 'Thought' };
  }
  return {
    shown,
    callCount: calls.length,
    failed,
    icon: calls.length === 0 ? 'brain' : 'tool',
    label,
    foldable: shown.length > 0,
  };
}

/** How a reply's last row ended, when that is worth a line. */
export function replyEndNote(
  last: ChatMessageView
): { tone: 'error' | 'quiet'; text: string } | null {
  if (last.status === 'failed' && last.error) return { tone: 'error', text: last.error };
  if (last.status === 'canceled') return { tone: 'quiet', text: 'Stopped.' };
  if (last.status === 'interrupted') return { tone: 'quiet', text: 'Interrupted.' };
  return null;
}

/**
 * The files this reply's tool calls kept, shown under the reply with
 * their Download: each hangs off the tool_results row that carried it. A
 * picture already drawn in its image call's own card is not drawn twice.
 */
export function inlineArtifacts(
  messages: ChatMessageView[],
  segments: Segment[],
  artifacts: readonly AttachmentView[],
  resultRows: ReadonlyMap<string, string>
): AttachmentView[] {
  const rows = new Set(messages.map((message) => message.id));
  const produced = artifacts.filter(
    (artifact) => artifact.messageId && rows.has(artifact.messageId)
  );
  const drawn = new Set<string>();
  for (const part of segments) {
    if (part.kind !== 'image') continue;
    const image = imageArtifactFor(
      part.step.block.id,
      resultRows,
      artifacts,
      part.step.result?.content ?? ''
    );
    if (image) drawn.add(image.id);
  }
  return produced.filter((artifact) => !drawn.has(artifact.id));
}

// ── Copy ────────────────────────────────────────────────────────────────

export interface CopyChoice {
  label: string;
  text: string;
}

/**
 * A reply's Copy: the prose alone, which is what most people copy a reply
 * for, and behind the chevron the fuller copies (lib/chat/copy-text.ts) —
 * with each call between the prose only when there were calls, with the
 * prompt only when there is a prompt to copy with it.
 */
export function replyCopies(
  segments: Segment[],
  prompts: ChatMessageView[]
): { text: string; more: CopyChoice[] } {
  const more: CopyChoice[] = [];
  if (replyCalls(segments).length > 0) {
    more.push({
      label: 'Copy with tool calls',
      text: replyCopyText(segments, { toolCalls: true }),
    });
  }
  if (prompts.some((prompt) => promptText(prompt) !== '')) {
    more.push({ label: 'Copy with context', text: contextCopyText(prompts, segments) });
  }
  return { text: replyCopyText(segments), more };
}

/**
 * The reply's row of actions (Copy, Listen): shown once the reply has
 * prose to copy and has finished streaming.
 */
export function showsReplyActions(copyText: string, streaming: boolean): boolean {
  return copyText !== '' && !streaming;
}

/** The chevron's menu: the plain copy again first, then the fuller ones. */
export function copyMenu(text: string, more: CopyChoice[]): CopyChoice[] {
  return more.length > 0 ? [{ label: 'Copy text only', text }, ...more] : [];
}

/** The Copy button's own state: the brief "Copied", and whether its menu is open. */
export interface CopyState {
  copied: boolean;
  menuOpen: boolean;
}

export type CopyAction =
  | { type: 'toggle-menu' }
  | { type: 'close-menu' }
  /** A menu item was picked: the menu shuts while its copy is made. */
  | { type: 'picked' }
  /** The clipboard took the text. */
  | { type: 'copied' }
  /** The "Copied" confirmation has been up long enough. */
  | { type: 'copied-expired' };

export const COPIED_MS = 1500;

export const initialCopyState: CopyState = { copied: false, menuOpen: false };

export function copyReducer(state: CopyState, action: CopyAction): CopyState {
  switch (action.type) {
    case 'toggle-menu':
      return { ...state, menuOpen: !state.menuOpen };
    case 'close-menu':
    case 'picked':
      return state.menuOpen ? { ...state, menuOpen: false } : state;
    case 'copied':
      return { ...state, copied: true };
    case 'copied-expired':
      return state.copied ? { ...state, copied: false } : state;
  }
}

// ── Speech ──────────────────────────────────────────────────────────────

/** The Listen button's state for one reply, given what is playing. */
export function listenState(
  playingKey: string | null,
  paused: boolean,
  key: string
): 'idle' | 'paused' | 'playing' {
  if (playingKey !== key) return 'idle';
  return paused ? 'paused' : 'playing';
}

// ── Cards ───────────────────────────────────────────────────────────────

/** The first line of a text that says something. */
function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim()) ?? '';
}

export interface SubagentCardView {
  task: string;
  instructions: string;
  /** An ordinary chat's sub-agent only ever reads; a code project's says so per task. */
  readOnly: boolean;
  /** The model the orchestrator picked, when it picked one. */
  model: string;
  sentence: string;
  running: boolean;
  /** The progress the stream gives while it works. */
  live: SubagentProgress | null;
  /** The folded line after the sentence: progress, the report's first line, or the task's. */
  inline: string;
  /** "2 of 8 model calls · 1 tool call", while it works. */
  liveCounts: string | null;
  /** What it last reached for, while it works. */
  lastTool: string | null;
  transcriptLabel: 'Follow the sub-agent' | 'View transcript';
}

/**
 * A sub-agent's card: the task it was given, how far it is while it
 * works, and its report once it is back. `elapsed` is how long it has been
 * (or was) at work, already formatted, or null when unknown.
 */
export function subagentCardView(
  step: Call,
  state: MilestoneState,
  progress: SubagentProgress | null,
  elapsed: string | null
): SubagentCardView {
  const input =
    typeof step.block.input === 'object' && step.block.input !== null ? step.block.input : {};
  const record: { task?: unknown; readOnly?: unknown; instructions?: unknown; model?: unknown } =
    input;
  const task = typeof record.task === 'string' ? record.task.trim() : '';
  const instructions = typeof record.instructions === 'string' ? record.instructions.trim() : '';
  const readOnly = record.readOnly === true || step.block.name === CHAT_DELEGATE_TOOL;
  const model = typeof record.model === 'string' ? record.model.trim() : '';
  const reportLine = step.result ? firstLine(step.result.content) : '';
  const running = state === 'pending' || state === 'waiting';
  const sentence =
    state === 'waiting'
      ? 'Waiting for permission to start a sub-agent'
      : state === 'pending'
        ? readOnly
          ? 'Sub-agent investigating'
          : 'Sub-agent working'
        : state === 'failed'
          ? 'The sub-agent failed'
          : 'Sub-agent reported';
  const live = progress && progress.status === 'running' ? progress : null;
  const plural = (n: number) => (n === 1 ? '' : 's');
  const inline = live
    ? `${live.steps}/${live.maxSteps} calls · ${live.toolCalls} tool call${plural(live.toolCalls)}${elapsed ? ` · ${elapsed}` : ''}`
    : !running && reportLine
      ? reportLine
      : firstLine(task);
  return {
    task,
    instructions,
    readOnly,
    model,
    sentence,
    running,
    live,
    inline,
    liveCounts: live
      ? `${live.steps} of ${live.maxSteps} model call${plural(live.maxSteps)} · ${live.toolCalls} tool call${plural(live.toolCalls)}`
      : null,
    lastTool: live?.lastTool ? milestoneSentence(live.lastTool, 'pending') : null,
    transcriptLabel: running ? 'Follow the sub-agent' : 'View transcript',
  };
}

export interface MilestoneCardView {
  sentence: string;
  /** The tool's first line, a commit's sha and subject, or the task's summary. */
  headline: string | null;
  commit: { sha: string; branch: string; subject: string } | null;
  /** A failed call's first line. */
  failLine: string | null;
  /** The folded line after the sentence: the failure, else the headline. */
  inline: string | null;
  tone: 'failed' | 'busy' | 'needs-input' | 'complete' | 'done';
  link: MilestoneLink | null;
  /** View diff, when the chat can open a commit. */
  canShowCommit: boolean;
}

/**
 * A milestone, lifted out of the fold: a commit, a push, a pull request,
 * or auto mode's task_complete, which reads as the end of the task with
 * the model's summary as its headline. Its actions (the host's link, a
 * commit's View diff) show only once it is done.
 */
export function milestoneCardView(
  step: Call,
  state: MilestoneState,
  canOpenCommits: boolean
): MilestoneCardView {
  const name = step.block.name;
  const isTaskEnd = name === TASK_COMPLETE_TOOL;
  const completion = isTaskEnd ? parseTaskCompletion(step.block.input) : null;
  const resultText = step.result?.content ?? '';
  const ok = step.result !== null && !step.result.isError;
  const summary = ok ? milestoneSummary(resultText) : null;
  const commit = name === 'code_git_commit' && ok ? parseCommitResult(resultText) : null;
  const sentence = isTaskEnd
    ? state === 'done'
      ? completion?.outcome === 'needs_input'
        ? 'Needs your input'
        : 'Task complete'
      : state === 'failed'
        ? 'The task could not be marked complete'
        : 'Marking the task complete'
    : milestoneSentence(name, state);
  const headline = isTaskEnd
    ? completion?.summary || null
    : commit
      ? `${commit.sha} ${commit.subject}`.trim()
      : (summary?.headline ?? null);
  const tone =
    state === 'failed'
      ? 'failed'
      : state === 'pending' || state === 'waiting'
        ? 'busy'
        : isTaskEnd
          ? completion?.outcome === 'needs_input'
            ? 'needs-input'
            : 'complete'
          : 'done';
  const failLine = step.result?.isError ? firstLine(resultText) || 'The call failed.' : null;
  const done = state === 'done';
  return {
    sentence,
    headline,
    commit: commit ? { sha: commit.sha, branch: commit.branch, subject: commit.subject } : null,
    failLine,
    inline: failLine ?? headline,
    tone,
    link: done ? (summary?.link ?? null) : null,
    canShowCommit: done && commit !== null && canOpenCommits,
  };
}

// ── The permission card ─────────────────────────────────────────────────

/**
 * The ask, inline where the reply stopped. Allow once is the plain yes;
 * Always allow is the same yes plus "stop asking me about this tool";
 * Deny hands the model a refusal. While an answer is on its way every
 * button is off and the one pressed says so; a refused answer puts the
 * buttons back and says why. On success the stream takes the card away.
 */
export interface PermissionCardState {
  busy: ToolPermissionDecision | null;
  error: string | null;
}

export type PermissionCardAction =
  { type: 'decide'; decision: ToolPermissionDecision } | { type: 'refused'; error: string };

export const initialPermissionCardState: PermissionCardState = { busy: null, error: null };

export function permissionCardReducer(
  state: PermissionCardState,
  action: PermissionCardAction
): PermissionCardState {
  switch (action.type) {
    case 'decide':
      // One answer at a time: a second press while one is in flight is nothing.
      return state.busy ? state : { busy: action.decision, error: null };
    case 'refused':
      return { busy: null, error: action.error };
  }
}

const DECISION_LABELS: Record<ToolPermissionDecision, [idle: string, busy: string]> = {
  once: ['Allow once', 'Allowing…'],
  always: ['Always allow', 'Allowing…'],
  deny: ['Deny', 'Denying…'],
};

/** The answers, in order, each with what its button says right now. */
export function permissionButtons(
  state: PermissionCardState
): { decision: ToolPermissionDecision; label: string; disabled: boolean }[] {
  return (['once', 'always', 'deny'] as const).map((decision) => ({
    decision,
    label: DECISION_LABELS[decision][state.busy === decision ? 1 : 0],
    disabled: state.busy !== null,
  }));
}

/** The card's words: the owner is asked; anyone else is told who decides. */
export function permissionCardText(
  name: string,
  canDecide: boolean,
  call: ToolUseBlock | null
): { lead: string; action: string; input: string | null } {
  return {
    lead: canDecide ? 'Allow this?' : 'Waiting for the owner',
    action: toolLabel(name).toLowerCase(),
    input: call ? JSON.stringify(call.input, null, 2) : null,
  };
}
