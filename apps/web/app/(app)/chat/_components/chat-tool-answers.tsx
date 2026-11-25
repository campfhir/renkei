'use client';

/**
 * "Decided here", inside the chat's Tools dialog: every decision that
 * applies to tools in this chat — allowed or blocked here, always allowed
 * or always blocked — one row per tool with its tag and a Reset. Anything
 * not listed asks first. Loaded each time the dialog opens; shows nothing
 * when nothing is decided. The rules are chat-tool-answers.model.ts's.
 */

import { useEffect, useReducer } from 'react';
import { Icon, ICONS } from '@/components/icons';
import { chatClient } from '@/lib/chat/client';
import {
  chatToolAnswerGroups,
  chatToolAnswersCount,
  chatToolAnswersReducer,
  initialChatToolAnswersState,
  showsChatToolAnswers,
  type ChatToolAnswerRow,
} from './chat-tool-answers.model';

const GLYPHS: Record<ChatToolAnswerRow['tag']['glyph'], string> = {
  ban: ICONS.ban,
  hand: ICONS.stopHand,
  check: ICONS.check,
  'double-check': ICONS.doubleCheck,
  lock: ICONS.lock,
};

function tagClass(row: ChatToolAnswerRow): string {
  if (row.blocked) return 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300';
  if (row.locked) return 'bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300';
  return 'bg-green-50 text-green-700 dark:bg-green-950/50 dark:text-green-300';
}

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

  async function reset(row: ChatToolAnswerRow) {
    if (state.resetting) return;
    dispatch({ type: 'reset-started', tool: row.name });
    const result = await chatClient.resetToolAnswer(chatId, row.name, row.scope);
    if (result.error === null) dispatch({ type: 'reset-succeeded', answers: result.data });
    else dispatch({ type: 'reset-failed', error: result.error });
  }

  if (!showsChatToolAnswers(state)) return null;
  return (
    <section
      aria-labelledby="chat-tool-answers-heading"
      className="mt-3 shrink-0 rounded-md border border-gray-200 dark:border-gray-800"
    >
      <div className="flex items-center gap-2 border-b border-gray-200 px-2 py-1.5 dark:border-gray-800">
        <h3 id="chat-tool-answers-heading" className="text-sm font-medium">
          Decided here
        </h3>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {chatToolAnswersCount(state)}
        </span>
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
                    className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-medium ${tagClass(row)}`}
                  >
                    <Icon
                      path={GLYPHS[row.tag.glyph]}
                      solid={row.tag.glyph === 'hand'}
                      className="h-3.5 w-3.5"
                    />
                    {row.tag.text}
                  </span>
                  <button
                    type="button"
                    disabled={row.disabled}
                    onClick={() => void reset(row)}
                    aria-label={`Reset ${row.label} (${row.name})`}
                    title={
                      row.scope === 'chat'
                        ? 'Ask again in this chat'
                        : 'Ask again in every chat (changes Preferences)'
                    }
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
      <p className="border-t border-gray-200 px-2 py-1 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
        Anything not listed asks first.
      </p>
      {state.error ? (
        <p className="px-2 pb-1.5 text-xs text-red-600 dark:text-red-400" role="alert">
          {state.error}
        </p>
      ) : null}
    </section>
  );
}
