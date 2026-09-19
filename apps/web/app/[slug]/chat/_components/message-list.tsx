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
 * anything said to Bitbucket (lib/code/milestones.ts) — is lifted out of
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
import type {
  ChatBlock,
  ChatMessageView,
  PendingToolPermission,
  ToolPermissionDecision,
  TurnView,
} from '@/lib/chat/views';
import { diffTotals, parseUnifiedDiff, splitDiffResult } from '@/lib/code/diff';
import { parseCommitResult } from '@/lib/code/chat-commits';
import {
  milestoneKindOf,
  milestoneSentence,
  milestoneSummary,
  type MilestoneState,
} from '@/lib/code/milestones';
import { codeToolLabel, gitGlyphFor } from '@/lib/code/tool-labels';
import { parseTaskCompletion, TASK_COMPLETE_TOOL } from '@/lib/chat/auto-mode';
import DiffView, { Counts } from '../../code/_components/diff-view';
import AttachmentChip from './attachment-chip';
import ListenButton from './listen-button';
import Markdown from './markdown';

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
  if (name === 'code_delegate') return ICONS.group;
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
  /** Open a sub-agent's run — progress, report, transcript — by its delegating call. */
  onShowSubagent: (toolUseId: string) => void;
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
}: {
  tenantId: string;
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
                messages={group.replies}
                results={results}
                pendingToolCalls={pendingToolCalls}
                streaming={running && group.key === lastTurnKey}
                speech={speech}
                speechKey={group.key}
                permission={running && group.key === lastTurnKey ? permission : null}
                code={code}
                subagents={subagents}
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

type ToolResult = Extract<ChatBlock, { type: 'tool_result' }>;

/** A reply, read across its rows: prose, and the work between the prose. */
type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'note'; text: string }
  | { kind: 'work'; steps: WorkStep[] }
  /** A commit, a push, a word to Bitbucket — a card of its own, never folded. */
  | { kind: 'milestone'; step: Extract<WorkStep, { kind: 'call' }> }
  /** A sub-agent at work, or its report: a card with its progress and a way into its transcript. */
  | { kind: 'subagent'; step: Extract<WorkStep, { kind: 'call' }> }
  /** Auto mode's runner-written "carry on", between two of the model's replies. */
  | { kind: 'nudge'; text: string };

export type WorkStep =
  | { kind: 'thinking'; text: string }
  | { kind: 'redacted' }
  | { kind: 'call'; block: Extract<ChatBlock, { type: 'tool_use' }>; result: ToolResult | null };

function segment(messages: ChatMessageView[], results: Map<string, ToolResult>): Segment[] {
  const out: Segment[] = [];
  const work = (): Extract<Segment, { kind: 'work' }> => {
    const last = out[out.length - 1];
    if (last && last.kind === 'work') return last;
    const created: Extract<Segment, { kind: 'work' }> = { kind: 'work', steps: [] };
    out.push(created);
    return created;
  };
  for (const message of messages) {
    if (message.role !== 'assistant') {
      if (message.kind === 'nudge') {
        const text = message.blocks
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join('\n');
        out.push({ kind: 'nudge', text });
      }
      continue;
    }
    for (const block of message.blocks) {
      switch (block.type) {
        case 'text':
          if (block.text.trim()) out.push({ kind: 'text', text: block.text });
          break;
        case 'thinking':
          work().steps.push({ kind: 'thinking', text: block.thinking });
          break;
        case 'redacted_thinking':
          work().steps.push({ kind: 'redacted' });
          break;
        case 'tool_use': {
          const step = { kind: 'call' as const, block, result: results.get(block.id) ?? null };
          if (block.name === 'code_delegate') {
            out.push({ kind: 'subagent', step });
          } else if (milestoneKindOf(block.name) !== null || block.name === TASK_COMPLETE_TOOL) {
            out.push({ kind: 'milestone', step });
          } else {
            work().steps.push(step);
          }
          break;
        }
        case 'tool_result':
          break;
        case 'document':
        case 'image':
          out.push({
            kind: 'note',
            text: `${block.type === 'document' ? (block.title ?? 'Document') : 'Image'} attached`,
          });
          break;
      }
    }
  }
  return out;
}

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
  messages,
  results,
  pendingToolCalls,
  streaming,
  speech,
  speechKey,
  permission,
  code,
  subagents,
}: {
  messages: ChatMessageView[];
  results: Map<string, ToolResult>;
  pendingToolCalls: string[];
  streaming: boolean;
  speech: ReplySpeech | null;
  speechKey: string;
  permission: PermissionPrompt | null;
  code: CodeActions | null;
  subagents: Record<string, SubagentProgress>;
}) {
  const segments = useMemo(() => segment(messages, results), [messages, results]);
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
          case 'subagent': {
            const step = part.step;
            const waiting = !step.result && permission?.pending.toolUseId === step.block.id;
            const pending =
              !step.result && !waiting && (tail || pendingToolCalls.includes(step.block.id));
            return (
              <SubagentCard
                key={index}
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
                code={code}
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
                key={index}
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
          case 'work':
            return (
              <WorkFold
                key={index}
                steps={part.steps}
                pendingToolCalls={pendingToolCalls}
                live={tail}
                waitingOn={permission?.pending.toolUseId ?? null}
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
  pendingToolCalls,
  live,
  waitingOn,
}: {
  steps: WorkStep[];
  pendingToolCalls: string[];
  live: boolean;
  /** The tool_use id the turn is waiting on permission for, if any. */
  waitingOn: string | null;
}) {
  const shown = steps.filter((step) => step.kind !== 'thinking' || step.text.trim() !== '');
  const calls = shown.filter((step) => step.kind === 'call');
  const thought = shown.some((step) => step.kind !== 'call');
  const failed = calls.some((step) => step.result?.isError);
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
      <StepList steps={shown} live={live} isPending={isPending} isWaiting={isWaiting} />
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
}: {
  steps: WorkStep[];
  live?: boolean;
  isPending?: (step: Extract<WorkStep, { kind: 'call' }>) => boolean;
  isWaiting?: (step: Extract<WorkStep, { kind: 'call' }>) => boolean;
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
                      <pre className="chat-pre">{args}</pre>
                    </div>
                    {step.result && split?.diff ? (
                      <>
                        <div>
                          <p className="mb-1 text-[11px] font-semibold uppercase text-gray-400">
                            Result
                          </p>
                          <pre className="chat-pre">{split.text}</pre>
                        </div>
                        <div>
                          <p className="mb-1 text-[11px] font-semibold uppercase text-gray-400">
                            Diff
                          </p>
                          <DiffView diff={split.diff} openAll />
                        </div>
                      </>
                    ) : step.result ? (
                      <div>
                        <p className="mb-1 text-[11px] font-semibold uppercase text-gray-400">
                          {step.result.isError ? 'Error' : 'Result'}
                        </p>
                        <pre className="chat-pre">{step.result.content}</pre>
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
  code,
}: {
  step: Extract<WorkStep, { kind: 'call' }>;
  state: MilestoneState;
  progress: SubagentProgress | null;
  code: CodeActions | null;
}) {
  const input =
    typeof step.block.input === 'object' && step.block.input !== null ? step.block.input : {};
  const record: { task?: unknown; readOnly?: unknown; instructions?: unknown } = input;
  const task = typeof record.task === 'string' ? record.task.trim() : '';
  const taskLine = task.split('\n').find((line) => line.trim()) ?? '';
  const readOnly = record.readOnly === true;
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
  const tone =
    state === 'failed'
      ? 'border-red-200 bg-red-50/60 dark:border-red-900/60 dark:bg-red-950/30'
      : 'border-indigo-200 bg-indigo-50/60 dark:border-indigo-900/60 dark:bg-indigo-950/30';
  return (
    <div className={`my-2 max-w-xl rounded-lg border px-3 py-2 text-sm ${tone}`} data-subagent>
      <div className="flex items-start gap-2">
        <span
          className={`mt-0.5 shrink-0 ${state === 'failed' ? 'text-red-500' : running ? 'text-indigo-500' : 'text-indigo-600 dark:text-indigo-400'}`}
        >
          <Icon path={ICONS.group} className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium text-gray-900 dark:text-gray-100">
            <span title={step.block.name}>{sentence}</span>
            {state === 'pending' ? <span className="chat-dots" aria-hidden="true" /> : null}
            {readOnly ? (
              <span className="ml-1.5 text-xs font-normal text-gray-500">read-only</span>
            ) : null}
          </p>
          {taskLine ? (
            <p className="mt-0.5 break-words text-xs text-gray-700 dark:text-gray-300" title={task}>
              {taskLine}
            </p>
          ) : null}
          {live ? (
            <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
              {live.steps} of {live.maxSteps} model call{live.maxSteps === 1 ? '' : 's'} ·{' '}
              {live.toolCalls} tool call{live.toolCalls === 1 ? '' : 's'}
              {live.lastTool ? ` · ${milestoneSentence(live.lastTool, 'pending')}` : ''}
            </p>
          ) : null}
          {!running && reportLine ? (
            <p
              className={`mt-1 break-words text-xs ${state === 'failed' ? 'text-red-700 dark:text-red-300' : 'text-gray-600 dark:text-gray-400'}`}
            >
              {reportLine}
            </p>
          ) : null}
          {code ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
              <button
                type="button"
                onClick={() => code.onShowSubagent(step.block.id)}
                className="flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-0.5 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-900 dark:hover:bg-gray-800"
              >
                <Icon path={ICONS.history} className="h-3.5 w-3.5" />
                {running ? 'Follow the sub-agent' : 'View transcript'}
              </button>
            </div>
          ) : null}
          <details className="chat-fold mt-1">
            <summary>
              {step.result ? 'Task and report' : 'Task'}
              <Icon path={ICONS.chevron} className="chat-fold-chevron h-3.5 w-3.5 text-gray-400" />
            </summary>
            <div className="space-y-2">
              <div>
                <p className="mb-1 text-[11px] font-semibold uppercase text-gray-400">Task</p>
                <pre className="chat-pre">
                  {step.block.partialJson ?? JSON.stringify(step.block.input, null, 2)}
                </pre>
              </div>
              {step.result ? (
                <div>
                  <p className="mb-1 text-[11px] font-semibold uppercase text-gray-400">
                    {step.result.isError ? 'Error' : 'Report'}
                  </p>
                  <pre className="chat-pre">{step.result.content}</pre>
                </div>
              ) : null}
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}

/**
 * Auto mode's word to carry on, between two replies: the runner wrote it
 * in the person's place, so it reads as a note in the margin, not as a
 * message of theirs.
 */
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
 * opened or merged, a pipeline started — or any other word to Bitbucket,
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
  const kind = isTaskEnd ? 'act' : (milestoneKindOf(name) ?? 'read');
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
  const tone =
    state === 'failed'
      ? 'border-red-200 bg-red-50/60 dark:border-red-900/60 dark:bg-red-950/30'
      : state === 'waiting'
        ? 'border-amber-200 bg-amber-50/60 dark:border-amber-900/60 dark:bg-amber-950/30'
        : isTaskEnd && completion?.outcome === 'needs_input'
          ? 'border-amber-200 bg-amber-50/60 dark:border-amber-900/60 dark:bg-amber-950/30'
          : kind === 'act'
            ? 'border-blue-200 bg-blue-50/60 dark:border-blue-900/60 dark:bg-blue-950/30'
            : 'border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/60';
  const iconTone =
    state === 'failed'
      ? 'text-red-500'
      : state === 'pending' || state === 'waiting'
        ? 'text-blue-500'
        : isTaskEnd
          ? completion?.outcome === 'needs_input'
            ? 'text-amber-600 dark:text-amber-400'
            : 'text-green-600 dark:text-green-400'
          : kind === 'act'
            ? 'text-blue-600 dark:text-blue-400'
            : 'text-gray-400';
  return (
    <div
      className={`my-2 max-w-xl rounded-lg border px-3 py-2 text-sm ${tone}`}
      data-milestone={name}
    >
      <div className="flex items-start gap-2">
        <span className={`mt-0.5 shrink-0 ${iconTone}`}>
          <Icon path={toolIconFor(name)} className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className={`${kind === 'act' ? 'font-medium' : ''} text-gray-900 dark:text-gray-100`}>
            <span title={name}>{sentence}</span>
            {state === 'pending' ? <span className="chat-dots" aria-hidden="true" /> : null}
            {commit ? (
              <span className="ml-1.5 text-xs font-normal text-gray-500">on {commit.branch}</span>
            ) : null}
          </p>
          {headline ? (
            <p
              className={`mt-0.5 break-words text-xs text-gray-700 dark:text-gray-300 ${commit ? 'font-mono' : ''}`}
            >
              {headline}
            </p>
          ) : null}
          {step.result?.isError ? (
            <p className="mt-0.5 break-words text-xs text-red-700 dark:text-red-300">
              {resultText.split('\n').find((line) => line.trim()) ?? 'The call failed.'}
            </p>
          ) : null}
          {(summary?.link || (commit && code)) && state === 'done' ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
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
          <details className="chat-fold mt-1">
            <summary>
              Details
              <Icon path={ICONS.chevron} className="chat-fold-chevron h-3.5 w-3.5 text-gray-400" />
            </summary>
            <div className="space-y-2">
              <div>
                <p className="mb-1 text-[11px] font-semibold uppercase text-gray-400">Input</p>
                <pre className="chat-pre">{args}</pre>
              </div>
              {step.result ? (
                <div>
                  <p className="mb-1 text-[11px] font-semibold uppercase text-gray-400">
                    {step.result.isError ? 'Error' : 'Result'}
                  </p>
                  <pre className="chat-pre">{step.result.content}</pre>
                </div>
              ) : null}
            </div>
          </details>
        </div>
      </div>
    </div>
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
  return (
    <div
      role="group"
      aria-label="Permission needed"
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
              <pre className="chat-pre">{args}</pre>
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
