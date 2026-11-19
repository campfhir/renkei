'use client';

/**
 * The pipeline builder's assistant: a chat beside the pipeline that reads
 * the repository and tailors the blocks to its source. Each answer can
 * carry a proposal — the pipeline as it would be, with blocks of the
 * project's own — that the person applies to the builder; nothing is
 * saved until they save or open the pull request. For an operator, an
 * answer can also carry a building block for every project, saved here
 * as a draft in the organization's catalogue to review and publish.
 *
 * The conversation's state and its reducer are held by the builder
 * (pipeline-builder.tsx), so a button on one of the project's blocks can
 * ask a question; what the panel decides is pipeline-assistant.model.ts.
 */

import { useEffect, useRef, type Dispatch } from 'react';
import Link from 'next/link';
import type { PipelineSpec } from '@renkei/ci-blocks';
import {
  MAX_QUESTION_CHARS,
  canAsk,
  proposalCard,
  type AssistantAction,
  type AssistantMessage,
  type AssistantState,
} from './pipeline-assistant.model';
import {
  cardClass,
  inputClass,
  linkButtonClass,
  primaryButtonClass,
  secondaryButtonClass,
} from './pipeline-parts';

export default function PipelineAssistant({
  state,
  dispatch,
  spec,
  blockName,
  operator,
  onAsk,
  onApply,
  onSaveBlock,
}: {
  state: AssistantState;
  dispatch: Dispatch<AssistantAction>;
  /** The pipeline on screen, to compare each proposal against. */
  spec: PipelineSpec | null;
  blockName: (key: string) => string;
  operator: boolean;
  onAsk: (text: string) => void;
  onApply: (message: AssistantMessage) => void;
  onSaveBlock: (message: AssistantMessage) => void;
}) {
  const thread = useRef<HTMLOListElement>(null);
  const count = state.messages.length;
  useEffect(() => {
    // The newest answer in view, inside the panel's own scroll.
    const list = thread.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [count, state.busy]);

  return (
    <section aria-label="Pipeline assistant" className={`${cardClass} space-y-3`}>
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold">Tailor it with the assistant</h2>
        {count > 0 ? (
          <button
            type="button"
            disabled={state.busy}
            onClick={() => dispatch({ type: 'reset' })}
            className={`ml-auto ${linkButtonClass}`}
          >
            New conversation
          </button>
        ) : null}
      </div>
      {count === 0 ? (
        <p className="text-xs text-gray-500">
          It reads this repository’s source and fits the blocks to it, writing blocks of this
          project’s own where the organization’s don’t fit.
          {operator
            ? ' As an operator, you can also have it turn one into a building block every project can use.'
            : ''}{' '}
          You review what it proposes before it reaches the builder.
        </p>
      ) : null}

      {count > 0 || state.busy ? (
        <ol
          ref={thread}
          aria-label="Conversation"
          className="max-h-[28rem] space-y-3 overflow-y-auto pr-1"
        >
          {state.messages.map((message) => (
            <li key={message.id}>
              {message.role === 'user' ? (
                <p className="ml-6 rounded-lg bg-blue-50 px-3 py-2 text-sm break-words whitespace-pre-wrap text-blue-950 dark:bg-blue-950 dark:text-blue-100">
                  {message.text}
                </p>
              ) : (
                <Answer
                  state={state}
                  message={message}
                  spec={spec}
                  blockName={blockName}
                  onApply={onApply}
                  onSaveBlock={onSaveBlock}
                />
              )}
            </li>
          ))}
          {state.busy ? (
            <li role="status" className="text-xs text-gray-500">
              Reading the repository and working it out…
            </li>
          ) : null}
        </ol>
      ) : null}

      {state.error ? (
        <p role="alert" className="text-xs text-red-700 dark:text-red-400">
          {state.error}
        </p>
      ) : null}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canAsk(state)) onAsk(state.draft);
        }}
        className="space-y-2"
      >
        <label className="sr-only" htmlFor="pipeline-assistant-question">
          Ask the assistant
        </label>
        <textarea
          id="pipeline-assistant-question"
          rows={3}
          value={state.draft}
          maxLength={MAX_QUESTION_CHARS}
          placeholder="e.g. Build and test it the way the repository does, and deploy to our servers"
          onChange={(e) => dispatch({ type: 'draft', text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canAsk(state)) {
              e.preventDefault();
              onAsk(state.draft);
            }
          }}
          className={`${inputClass} w-full resize-y`}
        />
        <button type="submit" disabled={!canAsk(state)} className={`${primaryButtonClass} w-full`}>
          {state.busy ? 'Working…' : 'Ask'}
        </button>
      </form>
    </section>
  );
}

function Answer({
  state,
  message,
  spec,
  blockName,
  onApply,
  onSaveBlock,
}: {
  state: AssistantState;
  message: AssistantMessage;
  spec: PipelineSpec | null;
  blockName: (key: string) => string;
  onApply: (message: AssistantMessage) => void;
  onSaveBlock: (message: AssistantMessage) => void;
}) {
  const card = proposalCard(state, message, spec, blockName);
  const block = message.buildingBlock;
  const savedId = state.saved[message.id];
  const blockError = state.blockErrors[message.id];
  return (
    <div className="space-y-2">
      <p className="text-sm break-words whitespace-pre-wrap">{message.text}</p>
      {message.read && message.read.length > 0 ? (
        <details className="text-xs text-gray-500">
          <summary className="cursor-pointer">
            Read {message.read.length} {message.read.length === 1 ? 'path' : 'paths'}
          </summary>
          <ul className="mt-1 space-y-0.5 font-mono break-all">
            {message.read.map((path, i) => (
              <li key={`${path}-${i}`}>{path}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {card ? (
        <div
          role="group"
          aria-label="Proposed pipeline"
          className="space-y-2 rounded-md border border-blue-200 bg-blue-50/50 p-3 dark:border-blue-900 dark:bg-blue-950/40"
        >
          <p className="text-xs font-semibold">Proposed pipeline</p>
          <p className="text-xs">{card.summary}</p>
          <ul className="space-y-0.5 text-xs break-words text-gray-700 dark:text-gray-300">
            {card.rows.map((row) => (
              <li key={row}>{row}</li>
            ))}
          </ul>
          {card.ownBlocks.length > 0 ? (
            <div className="space-y-1">
              <p className="text-xs font-semibold">Blocks of this project’s own</p>
              <ul className="space-y-1 text-xs">
                {card.ownBlocks.map((b) => (
                  <li key={b.key}>
                    <span className="font-medium">{b.name}</span>{' '}
                    <span className="text-gray-500">({b.isNew ? 'new' : 'changed'})</span>
                    {b.description ? (
                      <span className="block text-gray-500">{b.description}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {card.unfinished.length > 0 ? (
            <div className="text-xs text-amber-800 dark:text-amber-300">
              <p>Still to do once applied:</p>
              <ul className="list-disc pl-4">
                {card.unfinished.map((u) => (
                  <li key={u}>{u}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <button
            type="button"
            disabled={card.applied}
            onClick={() => onApply(message)}
            className={`${secondaryButtonClass} w-full disabled:opacity-60`}
          >
            {card.applied ? 'Applied to the builder' : 'Apply to the builder'}
          </button>
        </div>
      ) : null}

      {block ? (
        <div
          role="group"
          aria-label="Proposed building block"
          className="space-y-2 rounded-md border border-violet-200 bg-violet-50/50 p-3 dark:border-violet-900 dark:bg-violet-950/40"
        >
          <p className="text-xs font-semibold">Building block for every project</p>
          <p className="text-sm font-medium">{block.name}</p>
          <p className="font-mono text-xs text-gray-500">
            {block.key} · {block.kind}
            {block.definition.inputs.length > 0
              ? ` · inputs: ${block.definition.inputs.map((i) => i.name).join(', ')}`
              : ''}
          </p>
          {block.description ? <p className="text-xs">{block.description}</p> : null}
          <details className="text-xs">
            <summary className="cursor-pointer text-gray-500">Commands</summary>
            <pre className="mt-1 overflow-x-auto rounded bg-white p-2 font-mono text-[11px] leading-4 dark:bg-gray-950">
              {block.definition.commands}
            </pre>
          </details>
          {savedId ? (
            <p role="status" className="text-xs text-green-800 dark:text-green-300">
              Saved as a draft.{' '}
              <Link href={`/admin/ci-blocks/${savedId}`} className="font-medium underline">
                Review and publish it
              </Link>
            </p>
          ) : (
            <button
              type="button"
              disabled={state.saving !== null}
              onClick={() => onSaveBlock(message)}
              className={`${secondaryButtonClass} w-full disabled:opacity-60`}
            >
              {state.saving === message.id ? 'Saving…' : 'Save as a building block draft'}
            </button>
          )}
          {blockError ? (
            <p role="alert" className="text-xs text-red-700 dark:text-red-400">
              {blockError}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
