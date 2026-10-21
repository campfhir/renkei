'use client';

/**
 * Whether chats you have stopped using are archived on their own, and after
 * how many days. Empty means never, which is the default: archiving hides a
 * chat from the list, so it only happens when you ask for it. Archived chats
 * come back from the archive with their messages intact.
 *
 * The organization's chat retention is the ceiling. Past it the chat would be
 * deleted rather than archived, so the field refuses anything longer, and the
 * server checks the same thing again on save.
 */

import { useState } from 'react';
import type { ChatArchivePrefs } from '@renkei/user-prefs/prefs';

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
  const [input, setInput] = useState<string>(
    initial.afterDays === null ? '' : String(initial.afterDays)
  );
  const [saved, setSaved] = useState<string>(input);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [problem, setProblem] = useState<string | null>(null);

  /** The days to save, or a message saying why the entry cannot be saved. */
  function parse(): { days: number | null } | { error: string } {
    const trimmed = input.trim();
    if (trimmed === '') return { days: null };
    const days = Number(trimmed);
    if (!Number.isInteger(days) || days < 1) {
      return { error: 'Enter a whole number of days, or leave it empty to never archive.' };
    }
    if (days > maxDays) {
      return { error: `Enter ${maxDays} days or fewer.` };
    }
    return { days };
  }

  async function save() {
    const parsed = parse();
    if ('error' in parsed) {
      setProblem(parsed.error);
      setStatus('failed');
      return;
    }
    setProblem(null);
    setStatus('saving');
    try {
      const response = await fetch(`/api/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatArchive: { afterDays: parsed.days } }),
      });
      if (response.ok) {
        setSaved(input.trim());
        setStatus('saved');
      } else {
        const body: unknown = await response.json().catch(() => null);
        const message =
          typeof body === 'object' && body !== null ? Reflect.get(body, 'error') : undefined;
        setProblem(typeof message === 'string' ? message : 'Could not save.');
        setStatus('failed');
      }
    } catch {
      setProblem('Could not save.');
      setStatus('failed');
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
        value={input}
        onChange={(event) => {
          setInput(event.target.value);
          setProblem(null);
          setStatus('idle');
        }}
        className="mt-1 w-full max-w-[10rem] rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
      />
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        {retentionDays > 0
          ? `Your organization keeps chats for ${retentionDays} days, so this can be at most ${retentionDays}. Chats are deleted after that, whatever this is set to.`
          : 'Leave it empty to keep every chat in the list until you archive it yourself.'}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={status === 'saving' || input.trim() === saved}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {status === 'saving' ? 'Saving…' : 'Save'}
        </button>
        {status === 'saved' ? <span className="text-sm text-green-700">Saved.</span> : null}
        {status === 'failed' ? (
          <span className="text-sm text-red-600 dark:text-red-400">
            {problem ?? 'Could not save.'}
          </span>
        ) : null}
      </div>
    </section>
  );
}
