'use client';

/**
 * "Decided in this chat", inside the chat's Tools dialog: the tools the
 * owner allowed or blocked for this chat from its permission card, each
 * with Reset (back to asking). Loaded each time the dialog opens; shows
 * nothing when the chat has decided nothing. The rules are
 * chat-tool-answers.model.ts's.
 */

import { useEffect, useReducer } from 'react';
import { chatClient } from '@/lib/chat/client';
import {
  chatToolAnswerRows,
  chatToolAnswersReducer,
  initialChatToolAnswersState,
  showsChatToolAnswers,
} from './chat-tool-answers.model';

export default function ChatToolAnswers({ chatId }: { chatId: string }) {
  const [state, dispatch] = useReducer(chatToolAnswersReducer, initialChatToolAnswersState);

  useEffect(() => {
    let live = true;
    void chatClient.toolAnswers(chatId).then((result) => {
      if (!live) return;
      if (result.data) dispatch({ type: 'loaded', answers: result.data });
      else dispatch({ type: 'load-failed' });
    });
    return () => {
      live = false;
    };
  }, [chatId]);

  async function reset(tool: string) {
    if (state.resetting) return;
    dispatch({ type: 'reset-started', tool });
    const result = await chatClient.resetToolAnswer(chatId, tool);
    if (result.error === null) dispatch({ type: 'reset-succeeded', answers: result.data });
    else dispatch({ type: 'reset-failed', error: result.error });
  }

  if (!showsChatToolAnswers(state)) return null;
  return (
    <section
      aria-labelledby="chat-tool-answers-heading"
      className="mt-3 shrink-0 rounded-md border border-gray-200 p-2 dark:border-gray-800"
    >
      <h3 id="chat-tool-answers-heading" className="px-1 text-sm font-medium">
        Decided in this chat
      </h3>
      <p className="px-1 text-xs text-gray-500 dark:text-gray-400">
        From this chat&rsquo;s permission cards. Reset puts a tool back to asking from the next
        message.
      </p>
      <ul className="mt-1 max-h-40 overflow-y-auto">
        {chatToolAnswerRows(state).map((row) => (
          <li key={row.name} className="flex items-center gap-2 rounded px-1 py-1.5 text-sm">
            <span className="min-w-0 flex-1">
              <span className="block truncate" title={row.name}>
                {row.label}
              </span>
              <span
                className={`block text-xs ${
                  row.blocked
                    ? 'text-red-700 dark:text-red-300'
                    : 'text-gray-500 dark:text-gray-400'
                }`}
              >
                {row.decided}
              </span>
            </span>
            <button
              type="button"
              disabled={row.reset.disabled}
              onClick={() => void reset(row.name)}
              aria-label={`${row.reset.label} ${row.label} (${row.name})`}
              className="shrink-0 rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
            >
              {row.reset.label}
            </button>
          </li>
        ))}
      </ul>
      {state.error ? (
        <p className="px-1 text-xs text-red-600 dark:text-red-400" role="alert">
          {state.error}
        </p>
      ) : null}
    </section>
  );
}
