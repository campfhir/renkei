'use client';

/**
 * The messages, rendered as a person expects to read them: a prompt, then
 * the reply's blocks in order — thinking folded, a tool call folded with
 * its result inside it, text as Markdown — with a cursor while streaming.
 * The tool_results rows the runner stores are not shown on their own;
 * each result is looked up by id and shown under the call that made it.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { friendlyToolName } from '@/lib/tool-name';
import { Icon, ICONS } from '@/components/icons';
import type { ChatBlock, ChatMessageView, TurnView } from '@/lib/chat/views';
import AttachmentChip from './attachment-chip';
import Markdown from './markdown';

export default function MessageList({
  tenantId,
  messages,
  pendingToolCalls,
  running,
  turn,
  empty,
}: {
  tenantId: string;
  messages: ChatMessageView[];
  pendingToolCalls: string[];
  running: boolean;
  turn: TurnView | null;
  empty: ReactNode;
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

  const visible = messages.filter((message) => message.kind !== 'tool_results');
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');

  return (
    <div
      ref={scroller}
      onScroll={(event) => {
        const element = event.currentTarget;
        setPinned(element.scrollHeight - element.scrollTop - element.clientHeight < 48);
      }}
      className="relative min-h-0 flex-1 overflow-y-auto px-4 py-4"
    >
      {visible.length === 0 ? empty : null}
      <div className="mx-auto flex max-w-3xl flex-col gap-5">
        {visible.map((message) =>
          message.role === 'user' ? (
            <UserMessage key={message.id} tenantId={tenantId} message={message} />
          ) : (
            <AssistantMessage
              key={message.id}
              message={message}
              results={results}
              pendingToolCalls={pendingToolCalls}
              streaming={running && message.id === lastAssistant?.id}
            />
          )
        )}
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

function UserMessage({ tenantId, message }: { tenantId: string; message: ChatMessageView }) {
  const text = message.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    // The attachment excerpts ride inside the prompt for the model; the
    // person sees the chips instead.
    .replace(/<attachment [^>]*>[\s\S]*?<\/attachment>/g, '')
    .trim();
  return (
    <div className="flex justify-end">
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
    </div>
  );
}

function AssistantMessage({
  message,
  results,
  pendingToolCalls,
  streaming,
}: {
  message: ChatMessageView;
  results: Map<string, Extract<ChatBlock, { type: 'tool_result' }>>;
  pendingToolCalls: string[];
  streaming: boolean;
}) {
  const blocks = message.blocks;
  const lastIndex = blocks.length - 1;
  return (
    <div className="min-w-0 text-sm">
      {blocks.map((block, index) => {
        const last = index === lastIndex;
        switch (block.type) {
          case 'text':
            return (
              <div key={index}>
                <Markdown text={block.text} />
                {streaming && last ? <Cursor /> : null}
              </div>
            );
          case 'thinking':
            return (
              <details key={index} open={streaming && last} className="chat-fold">
                <summary>
                  <Icon path={ICONS.sparkle} className="h-3.5 w-3.5" />
                  {streaming && last ? 'Thinking…' : 'Thought process'}
                </summary>
                <div className="whitespace-pre-wrap text-gray-600 dark:text-gray-400">
                  {block.thinking}
                  {streaming && last ? <Cursor /> : null}
                </div>
              </details>
            );
          case 'redacted_thinking':
            return (
              <p key={index} className="text-xs text-gray-400">
                (some reasoning was withheld by the model provider)
              </p>
            );
          case 'tool_use': {
            const result = results.get(block.id);
            const pending = pendingToolCalls.includes(block.id) || (!result && streaming);
            const args = block.partialJson ?? JSON.stringify(block.input, null, 2);
            return (
              <details
                key={index}
                className={`chat-fold ${result?.isError ? 'chat-fold-error' : ''}`}
              >
                <summary>
                  <Icon path={ICONS.tool} className="h-3.5 w-3.5" />
                  {pending ? 'Calling ' : result?.isError ? 'Failed: ' : 'Called '}
                  <span className="font-medium" title={block.name}>
                    {friendlyToolName(block.name, null)}
                  </span>
                  {pending ? <span className="chat-dots" aria-hidden="true" /> : null}
                </summary>
                <div className="space-y-2">
                  <div>
                    <p className="mb-1 text-[11px] font-semibold uppercase text-gray-400">Input</p>
                    <pre className="chat-pre">{args}</pre>
                  </div>
                  {result ? (
                    <div>
                      <p className="mb-1 text-[11px] font-semibold uppercase text-gray-400">
                        {result.isError ? 'Error' : 'Result'}
                      </p>
                      <pre className="chat-pre">{result.content}</pre>
                    </div>
                  ) : null}
                </div>
              </details>
            );
          }
          case 'tool_result':
            return null;
          case 'document':
          case 'image':
            return (
              <p key={index} className="text-xs text-gray-400">
                {block.type === 'document' ? (block.title ?? 'Document') : 'Image'} attached
              </p>
            );
        }
      })}
      {blocks.length === 0 && streaming ? <Cursor /> : null}
      {message.status === 'failed' && message.error ? (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">{message.error}</p>
      ) : null}
      {message.status === 'canceled' ? (
        <p className="mt-1 text-xs text-gray-400">Stopped.</p>
      ) : null}
      {message.status === 'interrupted' ? (
        <p className="mt-1 text-xs text-gray-400">Interrupted.</p>
      ) : null}
    </div>
  );
}

function Cursor() {
  return <span className="chat-cursor" aria-hidden="true" />;
}
