'use client';

/**
 * "Permissions", inside the chat's Tools dialog: every decision that
 * applies to tools in this chat — allowed or blocked here, always allowed
 * or always blocked — one row per tool with its tag and a Reset, and
 * "Block a tool", which blocks any tool the chat can be offered (one that
 * only reads included: it never asks, so no card would offer it). Each
 * tag explains itself on hover, and pressed, in a line under the row.
 * Loaded each time the dialog opens. The rules are
 * chat-tool-answers.model.ts's.
 */

import { useEffect, useReducer } from 'react';
import { Icon, ICONS } from '@/components/icons';
import { chatClient } from '@/lib/chat/client';
import {
  chatToolAnswerGroups,
  chatToolAnswersCount,
  chatToolAnswersReducer,
  initialChatToolAnswersState,
  pickerGroups,
  showsChatToolAnswers,
  type ChatToolAnswerRow,
  type TagGlyph,
} from './chat-tool-answers.model';

const GLYPHS: Record<TagGlyph, string> = {
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

const smallButton =
  'inline-flex shrink-0 items-center gap-1 rounded-md border border-gray-300 px-1.5 py-0.5 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800';

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

  async function block(tool: string, scope: 'chat' | 'always') {
    if (state.resetting) return;
    dispatch({ type: 'block-started', tool });
    const result = await chatClient.blockTool(chatId, tool, scope);
    if (result.error === null) dispatch({ type: 'reset-succeeded', answers: result.data });
    else dispatch({ type: 'reset-failed', error: result.error });
  }

  if (!showsChatToolAnswers(state)) return null;
  const count = chatToolAnswersCount(state);
  const picker = state.picker.open ? pickerGroups(state) : null;
  return (
    <section
      aria-labelledby="chat-tool-answers-heading"
      className="mt-3 shrink-0 rounded-md border border-gray-200 dark:border-gray-800"
    >
      <div className="flex items-center gap-2 border-b border-gray-200 px-2 py-1.5 dark:border-gray-800">
        <h3 id="chat-tool-answers-heading" className="text-sm font-medium">
          Permissions
        </h3>
        {count ? <span className="text-xs text-gray-500 dark:text-gray-400">{count}</span> : null}
      </div>
      <div className="max-h-48 overflow-y-auto p-1">
        {chatToolAnswerGroups(state).map((group) => (
          <div key={group.key} role="group" aria-label={group.label}>
            <p className="px-1.5 pt-1.5 text-[11px] font-semibold tracking-wide text-gray-500 uppercase dark:text-gray-400">
              {group.label}
            </p>
            <ul>
              {group.rows.map((row) => {
                const explanationId = `tool-meaning-${row.name}`;
                return (
                  <li
                    key={row.name}
                    className="rounded px-1.5 py-1 text-sm hover:bg-gray-50 dark:hover:bg-gray-900"
                  >
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate" title={row.name}>
                        {row.label}
                      </span>
                      <button
                        type="button"
                        title={row.tag.meaning}
                        aria-expanded={row.explained}
                        aria-controls={row.explained ? explanationId : undefined}
                        onClick={() => dispatch({ type: 'explain', tool: row.name })}
                        className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-medium ${tagClass(row)}`}
                      >
                        <Icon
                          path={GLYPHS[row.tag.glyph]}
                          solid={row.tag.glyph === 'hand'}
                          className="h-3.5 w-3.5"
                        />
                        {row.tag.text}
                      </button>
                      <button
                        type="button"
                        disabled={row.disabled}
                        onClick={() => void reset(row)}
                        aria-label={`Reset ${row.label} (${row.name})`}
                        title={
                          row.scope === 'chat'
                            ? 'Take this back in this chat'
                            : 'Take this back in every chat (changes Preferences)'
                        }
                        className={smallButton}
                      >
                        <Icon
                          path={ICONS.undo}
                          className={`h-3.5 w-3.5 ${row.busy ? 'motion-safe:animate-pulse' : ''}`}
                        />
                        Reset
                      </button>
                    </div>
                    {row.explained ? (
                      <p
                        id={explanationId}
                        className="mt-1 rounded bg-gray-50 px-2 py-1 text-xs text-gray-600 dark:bg-gray-900 dark:text-gray-400"
                      >
                        {row.tag.meaning}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t border-gray-200 px-2 py-1 dark:border-gray-800">
        <p className="flex-1 text-xs text-gray-500 dark:text-gray-400">
          Anything not listed asks first.
        </p>
        <button
          type="button"
          aria-expanded={state.picker.open}
          onClick={() => dispatch({ type: 'picker-toggled' })}
          className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400"
        >
          <Icon path={ICONS.ban} className="h-3.5 w-3.5" />
          {state.picker.open ? 'Done blocking' : 'Block a tool'}
        </button>
      </div>
      {picker ? (
        <div className="border-t border-gray-200 p-2 dark:border-gray-800">
          <input
            type="search"
            value={state.picker.filter}
            onChange={(event) => dispatch({ type: 'picker-filter', filter: event.target.value })}
            placeholder="Search tools"
            aria-label="Search tools to block"
            autoComplete="off"
            className="mb-1 w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
          />
          <div className="max-h-48 overflow-y-auto">
            {picker.groups.length === 0 ? (
              <p className="px-1 py-1 text-xs text-gray-500">No tool matches.</p>
            ) : null}
            {picker.groups.map((group) => (
              <div key={group.key} role="group" aria-label={group.label}>
                <p className="px-1 pt-1.5 text-[11px] font-semibold tracking-wide text-gray-500 uppercase dark:text-gray-400">
                  {group.label}
                </p>
                <ul>
                  {group.tools.map((tool) => (
                    <li
                      key={tool.name}
                      className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-gray-50 dark:hover:bg-gray-900"
                    >
                      <span className="min-w-0 flex-1 truncate" title={tool.name}>
                        {tool.label}
                      </span>
                      {tool.read ? (
                        <span
                          className="shrink-0 rounded bg-gray-100 px-1 text-[11px] text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                          title="Only reads: it never asks, so blocking it here is the way to stop it"
                        >
                          reads
                        </span>
                      ) : null}
                      <button
                        type="button"
                        disabled={state.resetting !== null}
                        onClick={() => void block(tool.name, 'chat')}
                        aria-label={`Block ${tool.label} (${tool.name}) here`}
                        title="Refused in this chat"
                        className={smallButton}
                      >
                        <Icon
                          path={ICONS.ban}
                          className="h-3.5 w-3.5 text-red-600 dark:text-red-400"
                        />
                        Here
                      </button>
                      <button
                        type="button"
                        disabled={state.resetting !== null}
                        onClick={() => void block(tool.name, 'always')}
                        aria-label={`Always block ${tool.label} (${tool.name})`}
                        title="Refused in every chat (changes Preferences)"
                        className={smallButton}
                      >
                        <Icon
                          path={ICONS.stopHand}
                          solid
                          className="h-3.5 w-3.5 text-red-600 dark:text-red-400"
                        />
                        Always
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {picker.more > 0 ? (
              <p className="px-1 py-1 text-xs text-gray-500">
                {picker.more} more — type to narrow.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
      {state.error ? (
        <p className="px-2 pb-1.5 text-xs text-red-600 dark:text-red-400" role="alert">
          {state.error}
        </p>
      ) : null}
    </section>
  );
}
