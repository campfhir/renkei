'use client';

/**
 * A task the chat handed one of the person's agents, drawn as a message
 * to a colleague (agent-ask-card.model.ts): the agent's name and where it
 * stands, the task as it got it, and its reply once it answers — with a
 * way to write back to it and to open its run. Checks on the agent every
 * few seconds while it can still move on its own.
 */

import Link from 'next/link';
import { useEffect, useReducer } from 'react';
import { Icon, ICONS } from '@/components/icons';
import { Spinner } from '@/components/skeleton';
import { chatClient } from '@/lib/chat/client';
import type { AskableAgent } from '@/lib/chat/agent-ask-view';
import Markdown from './markdown';
import {
  agentAskCardReducer,
  agentAskCardView,
  initialAgentAskCard,
  shouldPoll,
  type AskCallState,
} from './agent-ask-card.model';

/** How often a card checks on an agent still at work. */
const POLL_MS = 5_000;

export default function AgentAskCard({
  chatId,
  toolUseId,
  call,
  onReply,
}: {
  chatId: string;
  toolUseId: string;
  call: { state: AskCallState; input: unknown; result: { content: string; isError?: boolean } | null };
  /** Address the composer to this agent; absent where the thread cannot send. */
  onReply: ((agent: AskableAgent) => void) | null;
}) {
  const [state, dispatch] = useReducer(agentAskCardReducer, initialAgentAskCard);
  const poll = shouldPoll(call.state, state);

  useEffect(() => {
    if (!poll) return;
    let live = true;
    const check = async () => {
      const result = await chatClient.agentAsk(chatId, toolUseId);
      if (!live) return;
      if (result.data) dispatch({ type: 'loaded', ask: result.data.ask });
      else {
        dispatch({
          type: 'loadFailed',
          message: result.error ?? 'Could not check on the agent',
          notFound: result.error === 'No agent was asked by that call',
        });
      }
    };
    // The first check right away; then every few seconds while it is live.
    const first = state.ask === null && state.error === null;
    const timer = setTimeout(() => void check(), first ? 0 : POLL_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [poll, chatId, toolUseId, state]);

  const view = agentAskCardView(call, state);
  const toneClass =
    view.tone === 'failed'
      ? 'text-red-600 dark:text-red-400'
      : view.tone === 'waiting'
        ? 'text-amber-700 dark:text-amber-300'
        : 'text-gray-500 dark:text-gray-400';
  return (
    <div
      data-agent-ask
      data-agent-ask-tone={view.tone}
      className="my-2 overflow-hidden rounded-lg border border-indigo-200 bg-indigo-50/40 text-sm dark:border-indigo-900 dark:bg-indigo-950/20"
    >
      <div className="flex items-start gap-2 px-3 py-2">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-indigo-600 dark:bg-indigo-900/60 dark:text-indigo-300">
          <Icon path={ICONS.agent} className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-gray-900 dark:text-gray-100">{view.title}</p>
          <p className={`flex items-center gap-1.5 text-xs ${toneClass}`} data-agent-ask-status>
            {view.busy ? <Spinner size={3} /> : null}
            <span className="min-w-0">{view.line}</span>
          </p>
        </div>
        {view.runPath ? (
          <Link
            href={view.runPath}
            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-gray-500 hover:bg-indigo-100 hover:text-gray-800 dark:hover:bg-indigo-900/40 dark:hover:text-gray-200"
          >
            View run
            <Icon path={ICONS.externalLink} className="h-3 w-3" />
          </Link>
        ) : null}
      </div>
      {view.task ? (
        <details className="border-t border-indigo-100 px-3 py-1.5 dark:border-indigo-900/60">
          <summary className="cursor-pointer text-xs text-gray-500">The task it was given</summary>
          <p className="mt-1 whitespace-pre-wrap break-words text-gray-700 dark:text-gray-300">
            {view.task}
          </p>
        </details>
      ) : null}
      {view.reply ? (
        <div
          data-agent-ask-reply
          className="border-t border-indigo-100 bg-white px-3 py-2 dark:border-indigo-900/60 dark:bg-gray-950"
        >
          <Markdown text={view.reply} />
        </div>
      ) : null}
      {view.replyTo && onReply ? (
        <div className="border-t border-indigo-100 px-3 py-1.5 dark:border-indigo-900/60">
          <button
            type="button"
            onClick={() => view.replyTo && onReply(view.replyTo)}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 dark:text-indigo-300 dark:hover:bg-indigo-900/40"
          >
            <Icon path={ICONS.send} className="h-3.5 w-3.5" />
            Reply to {view.replyTo.name}
          </button>
        </div>
      ) : null}
    </div>
  );
}
