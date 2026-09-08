'use client';

/**
 * A person's own chat memory — what chat_memory_remember saves and every
 * chat they own (outside a project) reads back. The project-page "Memory"
 * section is the model for this one, minus the editor/viewer role split:
 * here there is only ever the one owner, so add and delete are always
 * available.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import LocalTime from '@/components/local-time';
import { Icon, ICONS } from '@/components/icons';
import { sendJsonFull } from '@/lib/fetch-json';

export interface UserMemoryEntryView {
  id: string;
  content: string;
  chatId: string | null;
  createdAt: string;
}

export default function ChatMemoryPanel({
  tenantId,
  initialSummary,
  initialEntries,
}: {
  tenantId: string;
  initialSummary: string | null;
  initialEntries: UserMemoryEntryView[];
}) {
  const router = useRouter();
  const base = `/api/tenant/${tenantId}/chat/memory`;
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addNote() {
    const content = note.trim();
    if (!content) return;
    setBusy(true);
    setError(null);
    const result = await sendJsonFull(base, 'POST', { content });
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setNote('');
    router.refresh();
  }

  async function forget(target: string[] | 'all') {
    setBusy(true);
    setError(null);
    const result = await sendJsonFull(base, 'DELETE', target === 'all' ? { all: true } : { ids: target });
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <section
      aria-labelledby="chat-memory-heading"
      className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950"
    >
      <div className="flex items-center gap-2">
        <h3 id="chat-memory-heading" className="font-semibold">
          Memory
        </h3>
        {initialEntries.length > 0 ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void forget('all')}
            className="ml-auto text-xs text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
          >
            Forget all
          </button>
        ) : null}
      </div>
      <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
        Notes the assistant keeps about you across every chat you own — not a project's own chats,
        which keep separate memory of their own.
      </p>

      {initialSummary ? (
        <p className="mt-3 rounded-md bg-gray-50 p-2 text-sm dark:bg-gray-900">{initialSummary}</p>
      ) : null}

      {initialEntries.length === 0 ? (
        <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">Nothing remembered yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-gray-200 text-sm dark:divide-gray-800">
          {initialEntries.map((entry) => (
            <li key={entry.id} className="flex items-start gap-2 py-1.5">
              <span className="min-w-0 flex-1">
                {entry.content}
                <span className="block text-xs text-gray-500">
                  <LocalTime at={entry.createdAt} format="date" />
                </span>
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void forget([entry.id])}
                aria-label="Forget this note"
                className="rounded p-1 text-gray-400 hover:text-red-600 disabled:opacity-50"
              >
                <Icon path={ICONS.trash} className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void addNote();
        }}
        className="mt-3 flex gap-2"
      >
        <input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Add a note the assistant should remember about you"
          maxLength={500}
          className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
        />
        <button
          type="submit"
          disabled={busy || !note.trim()}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          Add
        </button>
      </form>
      {error ? <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
    </section>
  );
}
