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
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { friendlyToolName } from '@/lib/tool-name';
import { Icon, ICONS } from '@/components/icons';
import type { ChatBlock, ChatMessageView, TurnView } from '@/lib/chat/views';
import AttachmentChip from './attachment-chip';
import Markdown from './markdown';

/** What the owner may do to a prompt of theirs while nothing is running. */
export interface PromptActions {
  onResend: (message: ChatMessageView) => void;
  onEdit: (message: ChatMessageView) => void;
}

export default function MessageList({
  tenantId,
  messages,
  pendingToolCalls,
  running,
  turn,
  empty,
  promptActions,
}: {
  tenantId: string;
  messages: ChatMessageView[];
  pendingToolCalls: string[];
  running: boolean;
  turn: TurnView | null;
  empty: ReactNode;
  promptActions: PromptActions | null;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  // Follow the stream while the reader is at the bottom; stop following
  // the moment they scroll up, and offer a way back.
  useEffect(() => {
    const element = scroller.current;
    if (!element || !pinned) return;
    element.scrollTop = element.scrollHeight;
  }, [messages, pinned]);

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
              />
            ) : null}
          </div>
        ))}
        {turn && turn.status !== 'running' && turn.status !== 'completed' && turn.error ? (
          <p className="text-xs text-gray-500">{turn.error}</p>
        ) : null}
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
  | { kind: 'work'; steps: WorkStep[] };

type WorkStep =
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
    if (message.role !== 'assistant') continue;
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
        case 'tool_use':
          work().steps.push({ kind: 'call', block, result: results.get(block.id) ?? null });
          break;
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
      <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-blue-600 px-4 py-2.5 text-sm whitespace-pre-wrap text-white">
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

function Reply({
  messages,
  results,
  pendingToolCalls,
  streaming,
}: {
  messages: ChatMessageView[];
  results: Map<string, ToolResult>;
  pendingToolCalls: string[];
  streaming: boolean;
}) {
  const segments = useMemo(() => segment(messages, results), [messages, results]);
  const last = messages[messages.length - 1];
  const lastIndex = segments.length - 1;
  return (
    <div className="min-w-0 text-sm">
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
          case 'work':
            return (
              <WorkFold
                key={index}
                steps={part.steps}
                pendingToolCalls={pendingToolCalls}
                live={tail}
              />
            );
        }
      })}
      {segments.length === 0 && streaming ? <Cursor /> : null}
      {last.status === 'failed' && last.error ? (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">{last.error}</p>
      ) : null}
      {last.status === 'canceled' ? <p className="mt-1 text-xs text-gray-400">Stopped.</p> : null}
      {last.status === 'interrupted' ? (
        <p className="mt-1 text-xs text-gray-400">Interrupted.</p>
      ) : null}
    </div>
  );
}

/**
 * One collapsed line for a run of thinking and tool calls. Shut by
 * default — the reply is what the person came for — but while the run is
 * still live the line itself says what is happening right now.
 */
function WorkFold({
  steps,
  pendingToolCalls,
  live,
}: {
  steps: WorkStep[];
  pendingToolCalls: string[];
  live: boolean;
}) {
  const calls = steps.filter((step) => step.kind === 'call');
  const thought = steps.some((step) => step.kind !== 'call');
  const failed = calls.some((step) => step.result?.isError);
  const isPending = (step: Extract<WorkStep, { kind: 'call' }>) =>
    !step.result && (live || pendingToolCalls.includes(step.block.id));
  const current = steps[steps.length - 1];

  let label: ReactNode;
  if (live && current) {
    label =
      current.kind === 'call' && isPending(current) ? (
        <>
          Calling{' '}
          <span className="font-medium" title={current.block.name}>
            {friendlyToolName(current.block.name, null)}
          </span>
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
    label = parts.join(' · ');
  }

  return (
    <details className={`chat-fold ${failed ? 'chat-fold-error' : ''}`}>
      <summary>
        <Icon
          path={thought && calls.length === 0 ? ICONS.brain : ICONS.tool}
          className="h-3.5 w-3.5"
        />
        {label}
      </summary>
      <ol className="space-y-2">
        {steps.map((step, index) => {
          switch (step.kind) {
            case 'thinking':
              return (
                <li key={index} className="whitespace-pre-wrap text-gray-600 dark:text-gray-400">
                  {step.text}
                  {live && index === steps.length - 1 ? <Cursor /> : null}
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
              const args = step.block.partialJson ?? JSON.stringify(step.block.input, null, 2);
              return (
                <li key={index}>
                  <details className={`chat-fold ${step.result?.isError ? 'chat-fold-error' : ''}`}>
                    <summary>
                      <Icon path={ICONS.tool} className="h-3.5 w-3.5" />
                      {pending ? 'Calling ' : step.result?.isError ? 'Failed: ' : 'Called '}
                      <span className="font-medium" title={step.block.name}>
                        {friendlyToolName(step.block.name, null)}
                      </span>
                      {pending ? <span className="chat-dots" aria-hidden="true" /> : null}
                    </summary>
                    <div className="space-y-2">
                      <div>
                        <p className="mb-1 text-[11px] font-semibold uppercase text-gray-400">
                          Input
                        </p>
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
                </li>
              );
            }
          }
        })}
      </ol>
    </details>
  );
}

function Cursor() {
  return <span className="chat-cursor" aria-hidden="true" />;
}
