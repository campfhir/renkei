'use client';

/**
 * The agent's knowledge notes — reference material every run loads into
 * context ("Your knowledge notes"). The owner curates them here; an agent
 * can add one deliberately with agent_knowledge_write, and those appear in
 * the same list marked as agent-written. (knowledge_create_note does NOT
 * land here: it writes an ORG note, and an agent using it was silently
 * growing its own prompt — see AGENT_NOTE_SCOPE.)
 *
 * The rule-forms shape: a list plus one draft form for create and edit,
 * with a selection for deleting several at once — an agent that has been
 * writing its own notes for a while accumulates more than anyone wants to
 * remove one at a time.
 */

import { useCallback, useEffect, useState } from 'react';
import { getJson, sendJson, sendJsonFull } from '@/lib/fetch-json';

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900';

interface NoteRow {
  noteId: string;
  title: string;
  content: string;
  authoredBy: 'user' | 'agent';
  sourceAt: string | null;
}

interface Draft {
  noteId: string | null;
  title: string;
  content: string;
}

export default function KnowledgePanel({
  tenantId,
  agentId,
}: {
  tenantId: string;
  agentId: string;
}) {
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [purgeArmed, setPurgeArmed] = useState(false);

  const base = `/api/tenant/${tenantId}/agents/${agentId}/knowledge`;

  const load = useCallback(async () => {
    const { data, error: loadError } = await getJson<{ notes: NoteRow[] }>(base);
    if (loadError) setError(loadError);
    else {
      setError(null);
      setNotes(data?.notes ?? []);
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    const body = { title: draft.title, content: draft.content };
    const saveError = draft.noteId
      ? await sendJson(`${base}/${draft.noteId}`, 'PUT', body)
      : (await sendJsonFull(base, 'POST', body)).error;
    setBusy(false);
    if (saveError) {
      setError(saveError);
      return;
    }
    setDraft(null);
    await load();
  };

  const toggle = (noteId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(noteId)) next.delete(noteId);
      else next.add(noteId);
      return next;
    });
  };

  /** Delete the selection, or everything when `all`. */
  const removeMany = async (all: boolean) => {
    setBusy(true);
    setError(null);
    const body = all ? { all: true } : { noteIds: [...selected] };
    const { error: bulkError } = await sendJsonFull<{ deleted: number }>(base, 'DELETE', body);
    setBusy(false);
    setPurgeArmed(false);
    if (bulkError) {
      setError(bulkError);
      return;
    }
    // A draft editing something just deleted would save it back.
    if (draft?.noteId && (all || selected.has(draft.noteId))) setDraft(null);
    setSelected(new Set());
    await load();
  };

  const remove = async (noteId: string) => {
    setBusy(true);
    setError(null);
    const removeError = await sendJson(`${base}/${noteId}`, 'DELETE');
    setBusy(false);
    if (removeError) {
      setError(removeError);
      return;
    }
    if (draft?.noteId === noteId) setDraft(null);
    await load();
  };

  return (
    <div>
      <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
        Reference notes this agent reads at the start of every run — policies, contacts, standing
        instructions. The agent can add its own with the knowledge tools.
      </p>

      {notes.length === 0 && !draft ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No notes yet.</p>
      ) : null}

      {notes.length > 0 ? (
        <div className="mb-2 flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-1.5 text-gray-600 dark:text-gray-400">
            <input
              type="checkbox"
              checked={selected.size === notes.length && notes.length > 0}
              // Indeterminate is the honest state for a partial selection and
              // cannot be expressed as `checked`.
              ref={(input) => {
                if (input) input.indeterminate = selected.size > 0 && selected.size < notes.length;
              }}
              onChange={() =>
                setSelected(
                  selected.size === notes.length ? new Set() : new Set(notes.map((n) => n.noteId))
                )
              }
            />
            {selected.size > 0 ? `${selected.size} selected` : 'Select all'}
          </label>
          {selected.size > 0 ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void removeMany(false)}
              className="text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
            >
              Delete {selected.size}
            </button>
          ) : null}
          <span className="ml-auto">
            {purgeArmed ? (
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void removeMany(true)}
                  className="rounded-md bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700 disabled:opacity-50"
                >
                  Really delete all {notes.length}
                </button>
                <button
                  type="button"
                  onClick={() => setPurgeArmed(false)}
                  className="text-gray-500 hover:underline"
                >
                  Keep them
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setPurgeArmed(true)}
                className="text-red-600 hover:underline dark:text-red-400"
              >
                Clear knowledge
              </button>
            )}
          </span>
        </div>
      ) : null}

      <ul className="space-y-2">
        {notes.map((note) => (
          <li
            key={note.noteId}
            className="rounded-md border border-gray-200 p-3 dark:border-gray-800"
          >
            <div className="flex items-start justify-between gap-2">
              <input
                type="checkbox"
                className="mt-1 shrink-0"
                checked={selected.has(note.noteId)}
                onChange={() => toggle(note.noteId)}
                aria-label={`Select ${note.title}`}
              />
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-medium">
                  {note.title}
                  {note.authoredBy === 'agent' ? (
                    <span className="ml-2 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-normal text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                      written by the agent
                    </span>
                  ) : null}
                </p>
                <p className="mt-1 break-words whitespace-pre-wrap text-xs text-gray-600 dark:text-gray-400">
                  {note.content.length > 300 ? `${note.content.slice(0, 299)}…` : note.content}
                </p>
              </div>
              <div className="flex shrink-0 gap-2 text-sm">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    setDraft({ noteId: note.noteId, title: note.title, content: note.content })
                  }
                  className="text-blue-600 hover:underline dark:text-blue-400"
                >
                  Edit
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void remove(note.noteId)}
                  className="text-red-600 hover:underline dark:text-red-400"
                >
                  Delete
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      {draft ? (
        <div className="mt-2 rounded-md border border-gray-200 p-3 dark:border-gray-800">
          <input
            aria-label="Note title"
            className={inputClass}
            placeholder="Title (e.g. Escalation policy)"
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          />
          <textarea
            aria-label="Note content"
            className={`${inputClass} mt-2 min-h-32`}
            placeholder="What the agent should know…"
            value={draft.content}
            onChange={(event) => setDraft({ ...draft, content: event.target.value })}
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={busy || !draft.title.trim() || !draft.content.trim()}
              onClick={() => void save()}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {draft.noteId ? 'Save note' : 'Add note'}
            </button>
            <button
              type="button"
              onClick={() => setDraft(null)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setDraft({ noteId: null, title: '', content: '' })}
          className="mt-2 text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          + Add a note
        </button>
      )}

      {error ? <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  );
}
