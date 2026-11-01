'use client';

/**
 * Whether chats you have stopped using are archived on their own, and after
 * how many days. Empty means never, which is the default: archiving hides a
 * chat from the list, so it only happens when you ask for it. Archived chats
 * come back from the archive with their messages intact.
 *
 * The organization's chat retention is the ceiling. Past it the chat would be
 * deleted rather than archived, so the field refuses anything longer, and the
 * server checks the same thing again on save. What the form decides is
 * chat-archive-form.model.ts.
 */

import { useReducer } from 'react';
import type { ChatArchivePrefs } from '@renkei/user-prefs/prefs';
import { reportFetchFailure } from '@/lib/fetch-json';
import {
  archiveRequest,
  canSave,
  chatArchiveReducer,
  initChatArchive,
  parseArchiveDays,
  refusalWords,
  retentionNote,
  saveLabel,
} from './chat-archive-form.model';

export default function ChatArchiveForm({
  initial,
  retentionDays,
  maxDays,
}: {
  initial: ChatArchivePrefs;
  /** The organization's chat retention in days; 0 keeps everything. */
  retentionDays: number;
  /** The longest window the field accepts. */
  maxDays: number;
}) {
  const [state, dispatch] = useReducer(chatArchiveReducer, initial.afterDays, initChatArchive);

  async function save() {
    const parsed = parseArchiveDays(state.input, maxDays);
    if ('error' in parsed) {
      dispatch({ type: 'failed', problem: parsed.error });
      return;
    }
    dispatch({ type: 'sent' });
    try {
      const response = await fetch(`/api/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(archiveRequest(parsed.days)),
      });
      if (response.ok) {
        dispatch({ type: 'stored' });
      } else {
        const problem = refusalWords(await response.json().catch(() => null));
        reportFetchFailure('PUT', '/api/preferences', response.status, problem);
        dispatch({ type: 'failed', problem });
      }
    } catch (error) {
      reportFetchFailure('PUT', '/api/preferences', 0, 'Could not reach the server', error);
      dispatch({ type: 'failed', problem: 'Could not save.' });
    }
  }

  return (
    <section
      aria-labelledby="chat-archive-heading"
      className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950"
    >
      <h3 id="chat-archive-heading" className="font-semibold">
        Archive old chats
      </h3>
      <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
        Archive a chat automatically once you have not used it for this many days.
      </p>

      <label className="mt-3 block text-sm" htmlFor="chat-archive-days">
        Archive chats after (days)
      </label>
      <input
        id="chat-archive-days"
        type="number"
        inputMode="numeric"
        min={1}
        max={maxDays}
        step={1}
        placeholder="Never"
        value={state.input}
        onChange={(event) => dispatch({ type: 'typed', input: event.target.value })}
        className="mt-1 w-full max-w-[10rem] rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
      />
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        {retentionNote(retentionDays)}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!canSave(state)}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {saveLabel(state)}
        </button>
        {state.status === 'saved' ? <span className="text-sm text-green-700">Saved.</span> : null}
        {state.status === 'failed' ? (
          <span className="text-sm text-red-600 dark:text-red-400">
            {state.problem ?? 'Could not save.'}
          </span>
        ) : null}
      </div>
    </section>
  );
}
