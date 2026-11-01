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

import { useCallback, useEffect, useReducer } from 'react';
import { getJson, sendJson, sendJsonFull } from '@/lib/fetch-json';
import { LoadingRegion, SkeletonList } from '@/components/skeleton';
import {
  bulkRemoval,
  canSave,
  initialKnowledge,
  knowledgeReducer,
  preview,
  saveRequest,
  selectAllBox,
  type NoteRow,
} from './knowledge-panel.model';

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900';

export default function KnowledgePanel({ agentId }: { agentId: string }) {
  const [state, dispatch] = useReducer(knowledgeReducer, initialKnowledge);
  const { notes, draft, busy, error, selected, purgeArmed } = state;
  const box = selectAllBox(state);

  const base = `/api/agents/${agentId}/knowledge`;

  const load = useCallback(async () => {
    const { data, error: loadError } = await getJson<{ notes: NoteRow[] }>(base);
    if (loadError) dispatch({ type: 'loadFailed', error: loadError });
    else dispatch({ type: 'loaded', notes: data?.notes ?? [] });
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!draft) return;
    const request = saveRequest(draft);
    dispatch({ type: 'sent' });
    const saveError =
      request.method === 'PUT'
        ? await sendJson(`${base}${request.path}`, 'PUT', request.body)
        : (await sendJsonFull(`${base}${request.path}`, 'POST', request.body)).error;
    if (saveError) {
      dispatch({ type: 'failed', error: saveError });
      return;
    }
    dispatch({ type: 'saved' });
    await load();
  };

  /** Delete the selection, or everything when `all`. */
  const removeMany = async (all: boolean) => {
    const removal = bulkRemoval(state, all);
    dispatch({ type: 'sent' });
    const { error: bulkError } = await sendJsonFull<{ deleted: number }>(base, 'DELETE', removal);
    if (bulkError) {
      dispatch({ type: 'failed', error: bulkError });
      return;
    }
    dispatch({ type: 'removed', removal });
    await load();
  };

  const remove = async (noteId: string) => {
    dispatch({ type: 'sent' });
    const removeError = await sendJson(`${base}/${noteId}`, 'DELETE');
    if (removeError) {
      dispatch({ type: 'failed', error: removeError });
      return;
    }
    dispatch({ type: 'removed', removal: { noteIds: [noteId] } });
    await load();
  };

  return (
    <div>
      <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
        Reference notes this agent reads at the start of every run — policies, contacts, standing
        instructions. The agent can add its own with the knowledge tools.
      </p>

      {notes === null ? (
        <LoadingRegion label="Loading notes…">
          <SkeletonList rows={3} />
        </LoadingRegion>
      ) : null}

      {notes !== null && notes.length === 0 && !draft ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No notes yet.</p>
      ) : null}

      {notes !== null && notes.length > 0 ? (
        <div className="mb-2 flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-1.5 text-gray-600 dark:text-gray-400">
            <input
              type="checkbox"
              checked={box.checked}
              // Indeterminate is the honest state for a partial selection and
              // cannot be expressed as `checked`.
              ref={(input) => {
                if (input) input.indeterminate = box.indeterminate;
              }}
              onChange={() => dispatch({ type: 'toggleAll' })}
            />
            {box.label}
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
                  onClick={() => dispatch({ type: 'disarmPurge' })}
                  className="text-gray-500 hover:underline"
                >
                  Keep them
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => dispatch({ type: 'armPurge' })}
                className="text-red-600 hover:underline dark:text-red-400"
              >
                Clear knowledge
              </button>
            )}
          </span>
        </div>
      ) : null}

      <ul className="space-y-2">
        {(notes ?? []).map((note) => (
          <li
            key={note.noteId}
            className="rounded-md border border-gray-200 p-3 dark:border-gray-800"
          >
            <div className="flex items-start justify-between gap-2">
              <input
                type="checkbox"
                className="mt-1 shrink-0"
                checked={selected.has(note.noteId)}
                onChange={() => dispatch({ type: 'toggle', noteId: note.noteId })}
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
                  {preview(note.content)}
                </p>
              </div>
              <div className="flex shrink-0 gap-2 text-sm">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => dispatch({ type: 'edit', note })}
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
            onChange={(event) =>
              dispatch({ type: 'draftChanged', field: 'title', value: event.target.value })
            }
          />
          <textarea
            aria-label="Note content"
            className={`${inputClass} mt-2 min-h-32`}
            placeholder="What the agent should know…"
            value={draft.content}
            onChange={(event) =>
              dispatch({ type: 'draftChanged', field: 'content', value: event.target.value })
            }
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={!canSave(state)}
              onClick={() => void save()}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {draft.noteId ? 'Save note' : 'Add note'}
            </button>
            <button
              type="button"
              onClick={() => dispatch({ type: 'draftCancelled' })}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => dispatch({ type: 'newNote' })}
          className="mt-2 text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          + Add a note
        </button>
      )}

      {error ? <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  );
}
