'use client';

/**
 * "Decided here", inside the chat's Tools dialog: the tools the owner
 * blocked or allowed for this chat from its permission cards. Short on
 * purpose — an icon per row, a count in the heading, an undo button per
 * row and Reset all — with the explanation in the heading's tooltip.
 * Loaded each time the dialog opens; shows nothing when nothing is
 * decided. The rules are chat-tool-answers.model.ts's.
 */

import { useEffect, useReducer } from 'react';
import { Icon, ICONS } from '@/components/icons';
import { chatClient } from '@/lib/chat/client';
import {
  chatToolAnswerGroups,
  chatToolAnswersCount,
  chatToolAnswersReducer,
  initialChatToolAnswersState,
  resetAllView,
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

  async function resetAll() {
    if (state.resetting) return;
    dispatch({ type: 'reset-all-started' });
    const result = await chatClient.resetAllToolAnswers(chatId);
    if (result.error === null) dispatch({ type: 'reset-succeeded', answers: result.data });
    else dispatch({ type: 'reset-failed', error: result.error });
  }

  if (!showsChatToolAnswers(state)) return null;
  const all = resetAllView(state);
  return (
    <section
      aria-labelledby="chat-tool-answers-heading"
      className="mt-3 shrink-0 rounded-md border border-gray-200 dark:border-gray-800"
    >
      <div className="flex items-center gap-2 border-b border-gray-200 px-2 py-1.5 dark:border-gray-800">
        <h3
          id="chat-tool-answers-heading"
          className="text-sm font-medium"
          title="Answered on this chat's permission cards. Undo puts a tool back to asking from the next message."
        >
          Decided here
        </h3>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {chatToolAnswersCount(state)}
        </span>
        {all.shown ? (
          <button
            type="button"
            disabled={all.disabled}
            onClick={() => void resetAll()}
            className="ml-auto inline-flex items-center gap-1 text-xs text-blue-600 hover:underline disabled:cursor-default disabled:opacity-50 dark:text-blue-400"
          >
            <Icon path={ICONS.undo} className="h-3.5 w-3.5" />
            Reset all
          </button>
        ) : null}
      </div>
      <div className="max-h-48 overflow-y-auto p-1">
        {chatToolAnswerGroups(state).map((group) => (
          <div key={group.key} role="group" aria-label={group.label}>
            <p className="px-1.5 pt-1.5 text-[11px] font-semibold tracking-wide text-gray-500 uppercase dark:text-gray-400">
              {group.label}
            </p>
            <ul>
              {group.rows.map((row) => (
                <li
                  key={row.name}
                  className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-gray-50 dark:hover:bg-gray-900"
                >
                  <span className="min-w-0 flex-1 truncate" title={row.name}>
                    {row.label}
                  </span>
                  <span
                    className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-medium ${
                      row.blocked
                        ? 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300'
                        : 'bg-green-50 text-green-700 dark:bg-green-950/50 dark:text-green-300'
                    }`}
                  >
                    <Icon path={row.blocked ? ICONS.ban : ICONS.check} className="h-3.5 w-3.5" />
                    {row.status}
                  </span>
                  <button
                    type="button"
                    disabled={row.disabled}
                    onClick={() => void reset(row.name)}
                    aria-label={`Reset ${row.label} (${row.name})`}
                    title="Back to asking from the next message"
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-gray-300 px-1.5 py-0.5 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                  >
                    <Icon
                      path={ICONS.undo}
                      className={`h-3.5 w-3.5 ${row.busy ? 'motion-safe:animate-pulse' : ''}`}
                    />
                    Reset
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {state.error ? (
        <p className="px-2 pb-1.5 text-xs text-red-600 dark:text-red-400" role="alert">
          {state.error}
        </p>
      ) : null}
    </section>
  );
}
