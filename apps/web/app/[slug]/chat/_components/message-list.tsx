'use client';

/**
 * The messages, rendered as a person expects to read them: a prompt, then
 * the reply. A reply is read across every assistant row of its turn as
 * one sequence of blocks; text is Markdown, and every run of thinking and
 * tool calls between texts folds into ONE collapsed "worked" span, so a
 * reply that called ten tools reads as a line, not a wall. Inside the
 * span the steps are listed in order, each tool call folded again with
 * its result under it. The tool_results rows the runner stores are not
 * shown on their own; each result is looked up by id and shown under the
 * call that made it. A cursor marks the streaming end.
 *
 * Two kinds of call are NOT folded away. A milestone — a commit, a push,
 * anything said to the repository's git host (lib/code/milestones.ts) — is lifted out of
 * the run as a card of its own, in order, with the tool's own first line
 * and link, so the calls a person is waiting for never hide under "12
 * tool calls"; a commit's card opens its diff in the Changes panel. And
 * auto mode's `task_complete` reads as the task's end. Auto mode's nudge
 * rows (kind 'nudge', the runner telling the model to carry on) show as
 * a small note between replies, never as the person's bubble.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { friendlyToolName } from '@/lib/tool-name';
import { Icon, ICONS } from '@/components/icons';
import type { CompactionProgress, SubagentProgress } from '@/lib/chat/stream-events';
import { segment, type Segment, type ToolResult, type WorkStep } from '@/lib/chat/segment';
import type {
  ChatBlock,
  ChatMessageView,
  PendingToolPermission,
  ToolPermissionDecision,
  TurnView,
} from '@/lib/chat/views';
import type { WidgetModelContextOutcome } from '@/lib/chat/widget-tools';
import { diffTotals, parseUnifiedDiff, splitDiffResult } from '@/lib/code/diff';
import { formatDurationMs } from '@/lib/duration';
import { parseNote } from '@/lib/code/note-text';
import { parseCommitResult } from '@/lib/code/chat-commits';
import { milestoneSentence, milestoneSummary, type MilestoneState } from '@/lib/code/milestones';
import { codeToolLabel, gitGlyphFor } from '@/lib/code/tool-labels';
import { parseTaskCompletion, TASK_COMPLETE_TOOL } from '@/lib/chat/auto-mode';
import { CHAT_DELEGATE_TOOL, isSubagentTool } from '@/lib/chat/subagent-tools';
import DiffView, { Counts } from '../../code/_components/diff-view';
import AttachmentChip from './attachment-chip';
import CodePane from './code-pane';
import ListenButton from './listen-button';
import Markdown from './markdown';
import WidgetCard from './widget-card';
import { useCoachAnchor } from '@/components/coach-marks/anchor';

/**
 * A tool call's icon, by name: memory tools get the bookmark, recalling
 * another chat gets the history glyph, everything else the plain wrench —
 * so the two verbs a person actually cares about (something was
 * remembered, an old chat was reached into) stand out from the general
 * run of tool calls at a glance.
 */
const GIT_ICONS = {
  clone: ICONS.gitClone,
  commit: ICONS.gitCommit,
  push: ICONS.gitPush,
  pull: ICONS.gitPull,
  branch: ICONS.gitBranch,
  checkout: ICONS.gitCheckout,
  merge: ICONS.gitMerge,
  rebase: ICONS.gitRebase,
  stash: ICONS.gitStash,
  pullRequest: ICONS.gitPullRequest,
};

function toolIconFor(name: string): string {
  if (name === 'chat_compact') return ICONS.package;
  if (name === TASK_COMPLETE_TOOL) return ICONS.check;
  if (name.startsWith('project_memory_') || name.startsWith('chat_memory_')) return ICONS.memory;
  const git = gitGlyphFor(name);
  if (git) return GIT_ICONS[git];
  if (name === 'code_write_file' || name === 'code_edit_file') return ICONS.diff;
  if (name === 'code_run') return ICONS.terminal;
  if (isSubagentTool(name)) return ICONS.group;
  if (name.startsWith('code_')) return ICONS.file;
  if (name === 'chat_recall_chats') return ICONS.history;
  return ICONS.tool;
}

/** The tool's name as shown: the code tools' own, else the generic one. */
function toolLabel(name: string): string {
  return codeToolLabel(name)?.label ?? friendlyToolName(name, null);
}

/**
 * One tool call's line: "Calling X", "Called X", "Failed: X", "Waiting to
 * call X" — or, for a step that reads as a sentence (the clone), that
 * sentence.
 */
function callLine(name: string, state: 'pending' | 'done' | 'failed' | 'waiting'): ReactNode {
  const own = codeToolLabel(name);
  const sentence =
    own &&
    state !== 'waiting' &&
    (state === 'pending' ? own.pending : state === 'done' ? own.done : own.failed);
  if (sentence) return <span className="font-medium">{sentence}</span>;
  return (
    <>
      {state === 'pending'
        ? 'Calling '
        : state === 'failed'
          ? 'Failed: '
          : state === 'waiting'
            ? 'Waiting for permission to call '
            : 'Called '}
      <span className="font-medium" title={name}>
        {toolLabel(name)}
      </span>
    </>
  );
}

/**
 * The ask a running turn is parked behind, and what this reader may do
 * about it: the owner answers; anyone else watches.
 */
export interface PermissionPrompt {
  pending: PendingToolPermission;
  canDecide: boolean;
  onDecide: (toolUseId: string, decision: ToolPermissionDecision) => Promise<string | null>;
}

/** What the owner may do to a prompt of theirs while nothing is running. */
export interface PromptActions {
  onResend: (message: ChatMessageView) => void;
  onEdit: (message: ChatMessageView) => void;
}

/** What a code project's chat can do from a milestone card. */
export interface CodeActions {
  /** Open the Changes panel on this commit's diff. */
  onShowCommit: (sha: string) => void;
  /** Open a file in the code pane — the Open link on a tool result's diff. Absent when the pane is not there. */
  onOpenFile?: ((path: string) => void) | null;
}

/** Reading a reply aloud, when the org has a voice service. */
export interface ReplySpeech {
  /** The turn whose reply is playing right now, if any. */
  playingKey: string | null;
  /** That playback is held, to be resumed. */
  paused: boolean;
  onListen: (key: string, markdown: string) => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}

export default function MessageList({
  tenantId,
  chatId,
  messages,
  pendingToolCalls,
  running,
  turn,
  compaction,
  empty,
  promptActions,
  speech = null,
  permission = null,
  code = null,
  subagents = {},
  onShowSubagent = null,
  onWidgetDecision = null,
}: {
  tenantId: string;
  chatId: string;
  messages: ChatMessageView[];
  pendingToolCalls: string[];
  running: boolean;
  turn: TurnView | null;
  compaction: CompactionProgress | null;
  empty: ReactNode;
  promptActions: PromptActions | null;
  speech?: ReplySpeech | null;
  /** The tool call the running turn is waiting on, shown inline in that reply. */
  permission?: PermissionPrompt | null;
  /** In a code project's chat: what a milestone card can open. */
  code?: CodeActions | null;
  /** Sub-agents' live state by delegating call, from the stream (stream-events.ts). */
  subagents?: Record<string, SubagentProgress>;
  /** Open a sub-agent's run — progress, report, transcript — by its delegating call. */
  onShowSubagent?: ((toolUseId: string) => void) | null;
  /** A preview card's decision landed (widget-card.tsx): the note to show and the turn to stream. */
  onWidgetDecision?: ((outcome: WidgetModelContextOutcome) => void) | null;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  // Follow the stream while the reader is at the bottom; stop following
  // the moment they scroll up, and offer a way back.
  useEffect(() => {
    const element = scroller.current;
    if (!element || !pinned) return;
    element.scrollTop = element.scrollHeight;
  }, [messages, compaction, permission, pinned]);

  // The box itself shrinks when a phone's keyboard opens (chat-frame.tsx);
  // a reader at the bottom should still be at the bottom afterwards.
  useEffect(() => {
    const element = scroller.current;
    if (!element || !pinned || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [pinned]);

  const results = useMemo(() => {
    const map = new Map<string, Extract<ChatBlock, { type: 'tool_result' }>>();
    for (const message of messages) {
      for (const block of message.blocks) {
        if (block.type === 'tool_result') map.set(block.toolUseId, block);
      }
    }
    return map;
  }, [messages]);

  const turns = useMemo(() => groupTurns(messages), [messages]);
  const lastTurnKey = turns.length > 0 ? turns[turns.length - 1].key : null;

  return (
    <div
      ref={scroller}
      onScroll={(event) => {
        const element = event.currentTarget;
        setPinned(element.scrollHeight - element.scrollTop - element.clientHeight < 48);
      }}
      className="relative min-h-0 flex-1 overflow-y-auto px-4 py-4"
    >
      {turns.length === 0 ? empty : null}
      <div className="mx-auto flex max-w-3xl flex-col gap-5">
        {turns.map((group) => (
          <div key={group.key} className="flex flex-col gap-5">
            {group.prompts.map((message) => (
              <UserMessage
                key={message.id}
                tenantId={tenantId}
                message={message}
                actions={promptActions}
              />
            ))}
            {group.replies.length > 0 ? (
              <Reply
                tenantId={tenantId}
                chatId={chatId}
                messages={group.replies}
                results={results}
                pendingToolCalls={pendingToolCalls}
                streaming={running && group.key === lastTurnKey}
                speech={speech}
                speechKey={group.key}
                permission={running && group.key === lastTurnKey ? permission : null}
                code={code}
                subagents={subagents}
                onShowSubagent={onShowSubagent}
                onWidgetDecision={onWidgetDecision}
              />
            ) : null}
          </div>
        ))}
        {turn && turn.status !== 'running' && turn.status !== 'completed' && turn.error ? (
          <p className="text-xs text-gray-500">{turn.error}</p>
        ) : null}
        {compaction ? <CompactionCard progress={compaction} /> : null}
      </div>
      {!pinned ? (
        <button
          type="button"
          onClick={() => {
            setPinned(true);
            const element = scroller.current;
            if (element) element.scrollTop = element.scrollHeight;
          }}
          className="sticky bottom-2 left-1/2 -translate-x-1/2 rounded-full border border-gray-300 bg-white px-3 py-1 text-xs shadow dark:border-gray-700 dark:bg-gray-900"
        >
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}

interface TurnGroup {
  key: string;
  prompts: ChatMessageView[];
  replies: ChatMessageView[];
}

/** Consecutive rows of one turn, prompts apart from the reply's rows. */
function groupTurns(messages: ChatMessageView[]): TurnGroup[] {
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

export type { ToolResult, Segment, WorkStep };

/**
 * One inline card for whatever compaction is doing right now — a
 * dedicated compaction turn (/compact, or asked for in chat) or the
 * chat_compact tool running inside an ordinary reply. Left in place after
 * it finishes (status 'done'/'failed') as a small record, rather than
 * disappearing the moment the turn ends.
 */
function CompactionCard({ progress }: { progress: CompactionProgress }) {
  const { status, foldedSoFar, totalToFold } = progress;
  const pct = totalToFold > 0 ? Math.round((foldedSoFar / totalToFold) * 100) : null;
  const label =
    status === 'running'
      ? pct !== null
        ? `Compacting the conversation… ${foldedSoFar} of ${totalToFold}`
        : 'Compacting the conversation…'
      : status === 'failed'
        ? 'Compaction failed.'
        : totalToFold > 0
          ? `Compacted ${totalToFold} earlier message${totalToFold === 1 ? '' : 's'} into a summary.`
          : 'Nothing to compact — the conversation is already tight.';
  return (
    <div className="flex max-w-md items-start gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600 dark:border-gray-800 dark:bg-gray-900/60 dark:text-gray-400">
      <Icon
        path={ICONS.package}
        className={`mt-0.5 h-4 w-4 shrink-0 ${
          status === 'running'
            ? 'text-blue-500'
            : status === 'failed'
              ? 'text-red-500'
              : 'text-gray-400'
        }`}
      />
      <div className="min-w-0 flex-1">
        <p>{label}</p>
        {status === 'running' ? (
          <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800">
            <div
              className={`h-full rounded-full bg-blue-500 ${pct === null ? 'chat-compact-indeterminate w-1/3' : 'transition-[width]'}`}
              style={pct !== null ? { width: `${pct}%` } : undefined}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function UserMessage({
  tenantId,
  message,
  actions,
}: {
  tenantId: string;
  message: ChatMessageView;
  actions: PromptActions | null;
}) {
  const text = message.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    // The attachment excerpts ride inside the prompt for the model; the
    // person sees the chips instead.
    .replace(/<attachment [^>]*>[\s\S]*?<\/attachment>/g, '')
    .trim();
  return (
    <div className="group flex flex-col items-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-blue-600 px-4 py-2.5 text-sm whitespace-pre-wrap break-words text-white">
        {text}
        {message.attachments.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {message.attachments.map((attachment) => (
              <AttachmentChip key={attachment.id} tenantId={tenantId} attachment={attachment} />
            ))}
          </div>
        ) : null}
      </div>
      {actions ? (
        // Shown on hover where there is a pointer to hover with; always on
        // a touch screen, where there is not.
        <div className="mt-1 flex gap-1 text-xs text-gray-500 transition-opacity lg:opacity-0 lg:group-focus-within:opacity-100 lg:group-hover:opacity-100">
          <button
            type="button"
            onClick={() => actions.onEdit(message)}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-gray-900 dark:hover:text-gray-200"
          >
            <Icon path={ICONS.pencil} className="h-3.5 w-3.5" />
            Edit
          </button>
          <button
            type="button"
            onClick={() => actions.onResend(message)}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-gray-900 dark:hover:text-gray-200"
          >
            <Icon path={ICONS.loop} className="h-3.5 w-3.5" />
            Resend
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** A copy-to-clipboard button that shows its own brief "Copied" confirmation. */
function useCopyToClipboard(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  const copy = useCallback((text: string) => {
    if (!text) return;
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    });
  }, []);
  return [copied, copy];
}

function CopyButton({ text }: { text: string }) {
  const [copied, copy] = useCopyToClipboard();
  return (
    <button
      type="button"
      onClick={() => copy(text)}
      className="flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-gray-900 dark:hover:text-gray-200"
    >
      <Icon path={copied ? ICONS.check : ICONS.copy} className="h-3.5 w-3.5" />
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function Reply({
  tenantId,
  chatId,
  messages,
  results,
  pendingToolCalls,
  streaming,
  speech,
  speechKey,
  permission,
  code,
  subagents,
  onShowSubagent,
  onWidgetDecision,
}: {
  tenantId: string;
  chatId: string;
  messages: ChatMessageView[];
  results: Map<string, ToolResult>;
  pendingToolCalls: string[];
  streaming: boolean;
  speech: ReplySpeech | null;
  speechKey: string;
  permission: PermissionPrompt | null;
  code: CodeActions | null;
  subagents: Record<string, SubagentProgress>;
  onShowSubagent: ((toolUseId: string) => void) | null;
  onWidgetDecision: ((outcome: WidgetModelContextOutcome) => void) | null;
}) {
  // Milestone cards are a code project's: `code` is there exactly then.
  const codeProject = code !== null;
  const segments = useMemo(
    () => segment(messages, results, { codeProject }),
    [messages, results, codeProject]
  );
  // The call the ask is about, for the card to show its input.
  const askedCall = useMemo(() => {
    if (!permission) return null;
    for (const message of messages) {
      for (const block of message.blocks) {
        if (block.type === 'tool_use' && block.id === permission.pending.toolUseId) return block;
      }
    }
    return null;
  }, [messages, permission]);
  const copyText = useMemo(
    () =>
      segments
        .filter((part): part is Extract<Segment, { kind: 'text' }> => part.kind === 'text')
        .map((part) => part.text.trim())
        .join('\n\n'),
    [segments]
  );
  const last = messages[messages.length - 1];
  const lastIndex = segments.length - 1;
  return (
    <div className="group min-w-0 text-sm">
      {segments.map((part, index) => {
        const tail = streaming && index === lastIndex;
        switch (part.kind) {
          case 'text':
            return (
              <div key={index}>
                <Markdown text={part.text} />
                {tail ? <Cursor /> : null}
              </div>
            );
          case 'note':
            return (
              <p key={index} className="text-xs text-gray-400">
                {part.text}
              </p>
            );
          case 'nudge':
            return <NudgeNote key={index} text={part.text} />;
          case 'person':
            return (
              <PersonNote key={index} text={part.text} onOpenFile={code?.onOpenFile ?? null} />
            );
          case 'subagent': {
            const step = part.step;
            const waiting = !step.result && permission?.pending.toolUseId === step.block.id;
            const pending =
              !step.result && !waiting && (tail || pendingToolCalls.includes(step.block.id));
            return (
              <SubagentCard
                key={step.block.id}
                step={step}
                state={
                  waiting
                    ? 'waiting'
                    : pending
                      ? 'pending'
                      : step.result?.isError
                        ? 'failed'
                        : step.result
                          ? 'done'
                          : 'failed'
                }
                progress={subagents[step.block.id] ?? null}
                onShow={onShowSubagent}
              />
            );
          }
          case 'milestone': {
            const step = part.step;
            const waiting = !step.result && permission?.pending.toolUseId === step.block.id;
            const pending =
              !step.result && !waiting && (tail || pendingToolCalls.includes(step.block.id));
            return (
              <MilestoneCard
                key={step.block.id}
                step={step}
                state={
                  waiting
                    ? 'waiting'
                    : pending
                      ? 'pending'
                      : step.result?.isError
                        ? 'failed'
                        : step.result
                          ? 'done'
                          : 'failed'
                }
                code={code}
              />
            );
          }
          case 'widget': {
            // segment() only ever routes a call here once its result has
            // arrived with a uiResourceUri — never pending, so there is
            // always a resourceUri to hand the card.
            const result = part.step.result;
            const resourceUri = result?.uiResourceUri;
            return result && resourceUri ? (
              <WidgetCard
                key={part.step.block.id}
                tenantId={tenantId}
                chatId={chatId}
                resourceUri={resourceUri}
                toolInput={part.step.block.input}
                result={result}
                onModelContext={onWidgetDecision}
              />
            ) : null;
          }
          case 'work':
            return (
              <WorkFold
                key={index}
                steps={part.steps}
                modelMs={part.modelMs}
                pendingToolCalls={pendingToolCalls}
                live={tail}
                waitingOn={permission?.pending.toolUseId ?? null}
                onOpenFile={code?.onOpenFile ?? null}
              />
            );
        }
      })}
      {segments.length === 0 && streaming ? <Cursor /> : null}
      {permission ? <PermissionCard prompt={permission} call={askedCall} /> : null}
      {last.status === 'failed' && last.error ? (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">{last.error}</p>
      ) : null}
      {last.status === 'canceled' ? <p className="mt-1 text-xs text-gray-400">Stopped.</p> : null}
      {last.status === 'interrupted' ? (
        <p className="mt-1 text-xs text-gray-400">Interrupted.</p>
      ) : null}
      {copyText && !streaming ? (
        // Shown on hover where there is a pointer to hover with; always on
        // a touch screen, where there is not.
        <div
          className={`mt-1 flex gap-1 text-xs text-gray-500 transition-opacity lg:group-focus-within:opacity-100 lg:group-hover:opacity-100 ${
            speech?.playingKey === speechKey ? '' : 'lg:opacity-0'
          }`}
        >
          <CopyButton text={copyText} />
          {speech ? (
            <ListenButton
              state={
                speech.playingKey !== speechKey ? 'idle' : speech.paused ? 'paused' : 'playing'
              }
              onListen={() => speech.onListen(speechKey, copyText)}
              onPause={speech.onPause}
              onResume={speech.onResume}
              onStop={speech.onStop}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One collapsed line for a run of thinking and tool calls. Shut by
 * default — the reply is what the person came for — but while the run is
 * still live the line itself says what is happening right now. A thinking
 * block with no text (a provider that signals thinking but returns none of
 * it, or one that has only just started) has nothing to unfold, so a run
 * made of nothing else is a plain line rather than an empty fold.
 */
function WorkFold({
  steps,
  modelMs = 0,
  pendingToolCalls,
  live,
  waitingOn,
  onOpenFile = null,
}: {
  steps: WorkStep[];
  /** The model calls behind these steps, summed (segment.ts); 0 when unknown. */
  modelMs?: number;
  pendingToolCalls: string[];
  live: boolean;
  /** The tool_use id the turn is waiting on permission for, if any. */
  waitingOn: string | null;
  /** Open a changed file in the code pane, from a result's diff. */
  onOpenFile?: ((path: string) => void) | null;
}) {
  const shown = steps.filter((step) => step.kind !== 'thinking' || step.text.trim() !== '');
  const calls = shown.filter((step) => step.kind === 'call');
  const thought = shown.some((step) => step.kind !== 'call');
  // Only the most recently resolved call decides the fold's error styling —
  // an early failure that a later call in the same run superseded shouldn't
  // keep painting the whole group red.
  const lastResolvedCall = [...calls].reverse().find((step) => step.result);
  const failed = lastResolvedCall?.result?.isError ?? false;
  const isWaiting = (step: Extract<WorkStep, { kind: 'call' }>) =>
    !step.result && waitingOn === step.block.id;
  const isPending = (step: Extract<WorkStep, { kind: 'call' }>) =>
    !step.result && !isWaiting(step) && (live || pendingToolCalls.includes(step.block.id));
  const current = steps[steps.length - 1];

  let label: ReactNode;
  if (live && current) {
    label =
      current.kind === 'call' && isWaiting(current) ? (
        callLine(current.block.name, 'waiting')
      ) : current.kind === 'call' && isPending(current) ? (
        <>
          {callLine(current.block.name, 'pending')}
          <span className="chat-dots" aria-hidden="true" />
        </>
      ) : (
        <>
          Thinking
          <span className="chat-dots" aria-hidden="true" />
        </>
      );
  } else {
    const parts: string[] = [];
    if (thought) parts.push('Thought');
    if (calls.length > 0) parts.push(`${calls.length} tool call${calls.length === 1 ? '' : 's'}`);
    // Where the time went, when the rows kept it: the model's own calls
    // apart from the tools they waited on, so a slow reply can be read as
    // "thinking" or "a slow tool" from the line itself.
    const toolMs = calls.reduce((sum, step) => sum + (step.result?.durationMs ?? 0), 0);
    const timing: string[] = [];
    if (modelMs > 0) timing.push(`${formatDurationMs(modelMs)} model`);
    if (toolMs > 0) timing.push(`${formatDurationMs(toolMs)} tools`);
    if (timing.length > 0) parts.push(timing.join(', '));
    label = parts.length > 0 ? parts.join(' · ') : 'Thought';
  }

  const icon = (
    <Icon path={calls.length === 0 ? ICONS.brain : ICONS.tool} className="h-3.5 w-3.5" />
  );

  if (shown.length === 0) {
    return (
      <div className="chat-fold">
        <p className="chat-fold-static">
          {icon}
          {label}
        </p>
      </div>
    );
  }

  return (
    <details className={`chat-fold ${failed ? 'chat-fold-error' : ''}`}>
      <summary>
        {icon}
        {label}
        <Icon path={ICONS.chevron} className="chat-fold-chevron h-3.5 w-3.5 text-gray-400" />
      </summary>
      <StepList
        steps={shown}
        live={live}
        isPending={isPending}
        isWaiting={isWaiting}
        onOpenFile={onOpenFile}
      />
    </details>
  );
}

/**
 * The steps of a run in order — thinking as prose, each tool call folded
 * with its result (a diff rendered as one) — as the work fold lists
 * them, and as a sub-agent's transcript lists its own (subagent-modal.tsx).
 */
export function StepList({
  steps,
  live = false,
  isPending = () => false,
  isWaiting = () => false,
  onOpenFile = null,
}: {
  steps: WorkStep[];
  live?: boolean;
  isPending?: (step: Extract<WorkStep, { kind: 'call' }>) => boolean;
  isWaiting?: (step: Extract<WorkStep, { kind: 'call' }>) => boolean;
  /** Open a changed file in the code pane, from a result's diff. */
  onOpenFile?: ((path: string) => void) | null;
}) {
  const shown = steps;
  return (
    <ol className="space-y-2">
      {shown.map((step, index) => {
        switch (step.kind) {
          case 'thinking':
            return (
              <li
                key={index}
                className="whitespace-pre-wrap break-words text-gray-600 dark:text-gray-400"
              >
                {step.text}
                {live && index === shown.length - 1 ? <Cursor /> : null}
              </li>
            );
          case 'redacted':
            return (
              <li key={index} className="text-xs text-gray-400">
                (some reasoning was withheld by the model provider)
              </li>
            );
          case 'call': {
            const pending = isPending(step);
            const waiting = isWaiting(step);
            const args = step.block.partialJson ?? JSON.stringify(step.block.input, null, 2);
            // A code tool that changed a file carries the file's diff,
            // fenced; it is shown as a diff, and its counts on the line.
            const split =
              step.result && !step.result.isError && step.block.name.startsWith('code_')
                ? splitDiffResult(step.result.content)
                : null;
            const counts = split?.diff ? diffTotals(parseUnifiedDiff(split.diff)) : null;
            return (
              <li key={index}>
                <details className={`chat-fold ${step.result?.isError ? 'chat-fold-error' : ''}`}>
                  <summary>
                    <Icon path={toolIconFor(step.block.name)} className="h-3.5 w-3.5" />
                    {callLine(
                      step.block.name,
                      waiting
                        ? 'waiting'
                        : pending
                          ? 'pending'
                          : step.result?.isError
                            ? 'failed'
                            : 'done'
                    )}
                    {pending ? <span className="chat-dots" aria-hidden="true" /> : null}
                    {counts ? <Counts added={counts.added} deleted={counts.deleted} /> : null}
                    {step.result?.durationMs !== undefined ? (
                      <span className="text-xs text-gray-400" data-call-duration>
                        {formatDurationMs(step.result.durationMs)}
                      </span>
                    ) : null}
                    <Icon
                      path={ICONS.chevron}
                      className="chat-fold-chevron h-3.5 w-3.5 text-gray-400"
                    />
                  </summary>
                  <div className="space-y-2">
                    <div>
                      <p className="mb-1 text-[11px] font-semibold uppercase text-gray-400">
                        Input
                      </p>
                      <CodePane text={args} language="json" />
                    </div>
                    {step.result && split?.diff ? (
                      <>
                        <div>
                          <p className="mb-1 text-[11px] font-semibold uppercase text-gray-400">
                            Result
                          </p>
                          <CodePane text={split.text} />
                        </div>
                        <div>
                          <p className="mb-1 text-[11px] font-semibold uppercase text-gray-400">
                            Diff
                          </p>
                          <DiffView diff={split.diff} openAll onOpen={onOpenFile} />
                        </div>
                      </>
                    ) : step.result ? (
                      <div>
                        <p className="mb-1 text-[11px] font-semibold uppercase text-gray-400">
                          {step.result.isError ? 'Error' : 'Result'}
                        </p>
                        <CodePane text={step.result.content} />
                      </div>
                    ) : null}
                  </div>
                </details>
              </li>
            );
          }
        }
      })}
    </ol>
  );
}

/**
 * A sub-agent's card: the task it was given, how far it is while it
 * works (from the stream: model calls, tool calls, what it last reached
 * for), and its report once it is back — the one thing the chat's own
 * context ever holds of it. The transcript behind the report opens from
 * here (subagent-modal.tsx); it is kept, not thrown away, but never
 * fed back to the model.
 */
function SubagentCard({
  step,
  state,
  progress,
  onShow,
}: {
  step: Extract<WorkStep, { kind: 'call' }>;
  state: MilestoneState;
  progress: SubagentProgress | null;
  /** Open the run's transcript; absent where the thread cannot show one. */
  onShow: ((toolUseId: string) => void) | null;
}) {
  const input =
    typeof step.block.input === 'object' && step.block.input !== null ? step.block.input : {};
  const record: { task?: unknown; readOnly?: unknown; instructions?: unknown; model?: unknown } =
    input;
  const task = typeof record.task === 'string' ? record.task.trim() : '';
  const taskLine = task.split('\n').find((line) => line.trim()) ?? '';
  const instructions = typeof record.instructions === 'string' ? record.instructions.trim() : '';
  // An ordinary chat's sub-agent only ever reads (chat-delegate.ts); a
  // code project's says so per task.
  const readOnly = record.readOnly === true || step.block.name === CHAT_DELEGATE_TOOL;
  // The model the orchestrator picked for this task, when it picked one;
  // absent, the sub-agent ran on the chat's own (the transcript says which).
  const model = typeof record.model === 'string' ? record.model.trim() : '';
  const resultText = step.result?.content ?? '';
  const reportLine = step.result ? (resultText.split('\n').find((line) => line.trim()) ?? '') : '';
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
  const inline = live
    ? `${live.steps}/${live.maxSteps} calls · ${live.toolCalls} tool call${live.toolCalls === 1 ? '' : 's'}`
    : !running && reportLine
      ? reportLine
      : taskLine;
  return (
    <details className={`chat-fold ${state === 'failed' ? 'chat-fold-error' : ''}`} data-subagent>
      <summary>
        <Icon
          path={ICONS.group}
          className={`h-3.5 w-3.5 shrink-0 ${state === 'failed' ? 'text-red-500' : 'text-indigo-500 dark:text-indigo-400'}`}
        />
        <span className="shrink-0" title={step.block.name}>
          {sentence}
        </span>
        {state === 'pending' ? <span className="chat-dots shrink-0" aria-hidden="true" /> : null}
        {readOnly ? <span className="shrink-0 text-gray-400">read-only</span> : null}
        {model ? (
          <span className="shrink-0 text-gray-400" data-subagent-model>
            on {model}
          </span>
        ) : null}
        {inline ? <span className="min-w-0 flex-1 truncate text-gray-400">· {inline}</span> : null}
        <Icon path={ICONS.chevron} className="chat-fold-chevron h-3.5 w-3.5 text-gray-400" />
      </summary>
      <div className="space-y-2">
        {task ? (
          <div>
            <p className="mb-1 text-[11px] font-semibold uppercase text-gray-400">Task</p>
            <p className="break-words">{task}</p>
          </div>
        ) : null}
        {instructions ? (
          <div>
            <p className="mb-1 text-[11px] font-semibold uppercase text-gray-400">Instructions</p>
            <p className="break-words">{instructions}</p>
          </div>
        ) : null}
        {live ? (
          <p className="text-gray-600 dark:text-gray-400">
            {live.steps} of {live.maxSteps} model call{live.maxSteps === 1 ? '' : 's'} ·{' '}
            {live.toolCalls} tool call{live.toolCalls === 1 ? '' : 's'}
            {live.lastTool ? ` · ${milestoneSentence(live.lastTool, 'pending')}` : ''}
          </p>
        ) : null}
        {step.result ? (
          <div>
            <p className="mb-1 text-[11px] font-semibold uppercase text-gray-400">
              {step.result.isError ? 'Error' : 'Report'}
            </p>
            <CodePane text={step.result.content} />
          </div>
        ) : null}
        {onShow ? (
          <button
            type="button"
            onClick={() => onShow(step.block.id)}
            className="flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-0.5 text-xs hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-900 dark:hover:bg-gray-800"
          >
            <Icon path={ICONS.history} className="h-3.5 w-3.5" />
            {running ? 'Follow the sub-agent' : 'View transcript'}
          </button>
        ) : null}
      </div>
    </details>
  );
}

/**
 * Auto mode's word to carry on, between two replies: the runner wrote it
 * in the person's place, so it reads as a note in the margin, not as a
 * message of theirs.
 */
/**
 * What the person did to the checkout from the code pane — a save, a
 * commit, a push — read back from the note row's text (lib/code/notes.ts)
 * and shown as a small line, never as the person's bubble. A commit's
 * line opens the Changes panel on that commit; a saved file opens in
 * the pane.
 */
function PersonNote({
  text,
  onOpenFile,
}: {
  text: string;
  onOpenFile: ((path: string) => void) | null;
}) {
  const note = parseNote(text);
  const linkClass = 'font-mono text-gray-700 hover:underline dark:text-gray-300';
  return (
    <p
      className="my-2 flex items-start gap-1.5 text-xs text-gray-500 dark:text-gray-400"
      title={text}
    >
      <Icon
        path={
          note?.type === 'commit'
            ? ICONS.gitCommit
            : note?.type === 'push'
              ? ICONS.gitPush
              : ICONS.pencil
        }
        className="mt-0.5 h-3.5 w-3.5 shrink-0"
      />
      <span>
        {note?.type === 'edit' ? (
          <>
            You edited{' '}
            {note.paths.map((path, index) => (
              <span key={path}>
                {index > 0 ? ', ' : ''}
                {onOpenFile ? (
                  <button type="button" onClick={() => onOpenFile(path)} className={linkClass}>
                    {path}
                  </button>
                ) : (
                  <span className="font-mono">{path}</span>
                )}
              </span>
            ))}{' '}
            and saved to the checkout, not committed.
          </>
        ) : note?.type === 'commit' ? (
          <>
            You committed <span className="font-mono">{note.sha}</span> on{' '}
            <span className="font-mono">{note.branch}</span>
            {note.subject ? <>: {note.subject}</> : null}
          </>
        ) : note?.type === 'push' ? (
          <>
            You pushed <span className="font-mono">{note.branch}</span> to{' '}
            <span className="font-mono">origin/{note.remoteBranch}</span>
          </>
        ) : (
          text
        )}
      </span>
    </p>
  );
}

function NudgeNote({ text }: { text: string }) {
  return (
    <p
      className="my-2 flex items-start gap-1.5 text-xs text-violet-700 dark:text-violet-300"
      title={text}
    >
      <Icon path={ICONS.loop} className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        Auto mode: the task was not marked complete, so the assistant was told to carry on.
      </span>
    </p>
  );
}

/**
 * A milestone, lifted out of the fold: a commit, a push, a pull request
 * opened or merged, a pipeline or workflow started — or any other word to the git host,
 * more quietly. The sentence is the card's own (lib/code/milestones.ts),
 * the headline is the tool's first line, the link the tool's own; the
 * input and the full result fold under it. A commit's card opens its
 * diff in the Changes panel; auto mode's task_complete reads as the end
 * of the task, with the model's summary as its headline.
 */
function MilestoneCard({
  step,
  state,
  code,
}: {
  step: Extract<WorkStep, { kind: 'call' }>;
  state: MilestoneState;
  code: CodeActions | null;
}) {
  const name = step.block.name;
  const isTaskEnd = name === TASK_COMPLETE_TOOL;
  const completion = isTaskEnd ? parseTaskCompletion(step.block.input) : null;
  const resultText = step.result?.content ?? '';
  const summary = step.result && !step.result.isError ? milestoneSummary(resultText) : null;
  const commit =
    name === 'code_git_commit' && step.result && !step.result.isError
      ? parseCommitResult(resultText)
      : null;
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
  const args = step.block.partialJson ?? JSON.stringify(step.block.input, null, 2);
  const iconTone =
    state === 'failed'
      ? 'text-red-500'
      : state === 'pending' || state === 'waiting'
        ? 'text-blue-500'
        : isTaskEnd
          ? completion?.outcome === 'needs_input'
            ? 'text-amber-600 dark:text-amber-400'
            : 'text-green-600 dark:text-green-400'
          : 'text-blue-600 dark:text-blue-400';
  const failLine = step.result?.isError
    ? (resultText.split('\n').find((line) => line.trim()) ?? 'The call failed.')
    : null;
  const inline = failLine ?? headline;
  const hasActions = (summary?.link || (commit && code)) && state === 'done';
  return (
    <details
      className={`chat-fold ${state === 'failed' ? 'chat-fold-error' : ''}`}
      data-milestone={name}
    >
      <summary>
        <Icon path={toolIconFor(name)} className={`h-3.5 w-3.5 shrink-0 ${iconTone}`} />
        <span className="shrink-0" title={name}>
          {sentence}
        </span>
        {state === 'pending' ? <span className="chat-dots shrink-0" aria-hidden="true" /> : null}
        {commit ? <span className="shrink-0 text-gray-400">on {commit.branch}</span> : null}
        {inline ? (
          <span
            className={`min-w-0 flex-1 truncate ${failLine ? 'text-red-600 dark:text-red-400' : 'text-gray-400'} ${commit && !failLine ? 'font-mono' : ''}`}
          >
            · {inline}
          </span>
        ) : null}
        <Icon path={ICONS.chevron} className="chat-fold-chevron h-3.5 w-3.5 text-gray-400" />
      </summary>
      <div className="space-y-2">
        {hasActions ? (
          <div className="flex flex-wrap items-center gap-2">
            {commit && code ? (
              <button
                type="button"
                onClick={() => code.onShowCommit(commit.sha)}
                className="flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-0.5 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-900 dark:hover:bg-gray-800"
              >
                <Icon path={ICONS.diff} className="h-3.5 w-3.5" />
                View diff
              </button>
            ) : null}
            {summary?.link ? (
              <a
                href={summary.link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-0.5 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-900 dark:hover:bg-gray-800"
              >
                <Icon path={ICONS.externalLink} className="h-3.5 w-3.5" />
                {summary.link.label}
              </a>
            ) : null}
          </div>
        ) : null}
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase text-gray-400">Input</p>
          <CodePane text={args} language="json" />
        </div>
        {step.result ? (
          <div>
            <p className="mb-1 text-[11px] font-semibold uppercase text-gray-400">
              {step.result.isError ? 'Error' : 'Result'}
            </p>
            <CodePane text={step.result.content} />
          </div>
        ) : null}
      </div>
    </details>
  );
}

/**
 * The ask, inline where the reply stopped: what the assistant wants to
 * call, with what, and the three answers. Allow once is the plain yes;
 * Always allow is the same yes plus "stop asking me about this tool" —
 * kept on the preferences page, where it can be taken back; Deny hands
 * the model a refusal so it can say what it was going to do instead. A
 * viewer of a shared chat sees the ask but not the buttons: only the
 * owner can let the chat act.
 */
function PermissionCard({
  prompt,
  call,
}: {
  prompt: PermissionPrompt;
  call: Extract<ChatBlock, { type: 'tool_use' }> | null;
}) {
  const [busy, setBusy] = useState<ToolPermissionDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const name = prompt.pending.name;
  const args = call ? JSON.stringify(call.input, null, 2) : null;
  const decide = async (decision: ToolPermissionDecision) => {
    setBusy(decision);
    setError(null);
    const failure = await prompt.onDecide(prompt.pending.toolUseId, decision);
    if (failure) {
      setError(failure);
      setBusy(null);
    }
    // On success the stream's tool_permission_decided event takes the
    // card away; nothing to reset here.
  };
  const buttonClass =
    'rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50 disabled:cursor-default';
  const cardAnchor = useCoachAnchor('chat-permission-card');
  return (
    <div
      role="group"
      aria-label="Permission needed"
      {...cardAnchor}
      className="my-2 max-w-xl rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40"
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400">
          <Icon path={ICONS.approval} className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium text-gray-900 dark:text-gray-100">
            {prompt.canDecide ? 'Allow this?' : 'Waiting for the owner'} The assistant wants to{' '}
            <span title={name}>{toolLabel(name).toLowerCase()}</span>.
          </p>
          <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">
            This changes something outside the conversation, so it waits for a yes. Tool:{' '}
            <code className="font-mono">{name}</code>
          </p>
          {args ? (
            <details className="chat-fold mt-1">
              <summary>
                What it will send
                <Icon
                  path={ICONS.chevron}
                  className="chat-fold-chevron h-3.5 w-3.5 text-gray-400"
                />
              </summary>
              <CodePane text={args} language="json" />
            </details>
          ) : null}
          {prompt.canDecide ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void decide('once')}
                className={`${buttonClass} bg-blue-600 text-white hover:bg-blue-700`}
              >
                {busy === 'once' ? 'Allowing…' : 'Allow once'}
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void decide('always')}
                title="Runs this tool without asking from now on. Change your mind under Preferences."
                className={`${buttonClass} border border-gray-300 bg-white text-gray-800 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800`}
              >
                {busy === 'always' ? 'Allowing…' : 'Always allow'}
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void decide('deny')}
                className={`${buttonClass} text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/40`}
              >
                {busy === 'deny' ? 'Denying…' : 'Deny'}
              </button>
            </div>
          ) : (
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              Only the chat&rsquo;s owner can allow or deny it.
            </p>
          )}
          {error ? (
            <p className="mt-1 text-xs text-red-600 dark:text-red-400" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Cursor() {
  return <span className="chat-cursor" aria-hidden="true" />;
}
