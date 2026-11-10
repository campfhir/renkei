'use client';

/**
 * The two dialogs for acting on several artifacts at once from the library:
 *
 *   - Add to a project: each file the project does not hold yet is attached
 *     with the mode chosen here, the same call the single file's picker makes.
 *   - Delete: the impact of every owned file is worked out first, and the
 *     warning lists the projects and people that lose it. Files shared with
 *     the viewer only leave their list. Hand-over is single-file only: use
 *     the one-file delete dialog to hand a file over.
 *
 * What each decides is artifact-bulk-dialogs.model.ts.
 */

import { useEffect, useReducer } from 'react';
import Modal from '@/components/modal';
import { chatClient } from '@/lib/chat/client';
import type { ArtifactImpact, LibraryItem } from '@/lib/chat/artifact-library';
import { DialogFooter } from './chat-nav';
import { NO_IMPACT } from './artifact-dialogs.model';
import {
  bulkAddReducer,
  bulkAddTitle,
  bulkAddView,
  bulkDeleteReducer,
  bulkDeleteTitle,
  bulkDeleteView,
  deleteSummary,
  deleteWarnings,
  initialBulkAdd,
  initialBulkDelete,
  splitByOwner,
  type Outcome,
} from './artifact-bulk-dialogs.model';

/** Runs an act for each id in turn; the first failure does not stop the rest. */
async function eachInTurn(
  ids: string[],
  act: (id: string) => Promise<{ error: string | null }>
): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (const id of ids) {
    const result = await act(id);
    outcomes.push({ id, error: result.error });
  }
  return outcomes;
}

export function BulkAddModal({
  items,
  projects,
  onDone,
  onClose,
}: {
  items: LibraryItem[];
  projects: { id: string; name: string; kind: string }[];
  onDone: () => void;
  onClose: () => void;
}) {
  const [state, dispatch] = useReducer(bulkAddReducer, projects, initialBulkAdd);
  const view = bulkAddView(state, items, projects);
  const { target, toAdd } = view;

  const confirm = async () => {
    if (!target || toAdd.length === 0) return;
    dispatch({ type: 'sent' });
    const outcomes = await eachInTurn(
      toAdd.map((item) => item.id),
      (id) =>
        chatClient
          .attachArtifact(target.id, id, state.mode)
          .then((result) => ({ error: result.error }))
    );
    dispatch({ type: 'answered', projectId: target.id, outcomes });
    onDone();
    if (outcomes.some((outcome) => outcome.error !== null)) return;
    onClose();
  };

  return (
    <Modal title={bulkAddTitle(items.length)} onClose={onClose}>
      <div className="space-y-3 text-sm">
        {projects.length === 0 ? (
          <p className="text-gray-600 dark:text-gray-400">
            You have no project to add them to yet.
          </p>
        ) : (
          <>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                Project
              </span>
              <select
                value={state.projectId}
                onChange={(event) =>
                  dispatch({ type: 'projectChosen', projectId: event.target.value })
                }
                className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                How its chats use them
              </span>
              <select
                value={state.mode}
                onChange={(event) =>
                  dispatch({
                    type: 'modeChosen',
                    mode: event.target.value === 'always' ? 'always' : 'on_demand',
                  })
                }
                className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
              >
                <option value="on_demand">On demand — searched and read when asked</option>
                <option value="always">Always — in full every turn, against the budget</option>
              </select>
            </label>
            <p className="text-xs text-gray-500">{view.summary}</p>
          </>
        )}
        <DialogFooter
          busy={view.disabled}
          error={state.error}
          label={view.label}
          onCancel={onClose}
          onConfirm={() => void confirm()}
        />
      </div>
    </Modal>
  );
}

export function BulkDeleteModal({
  items,
  onDone,
  onClose,
}: {
  items: LibraryItem[];
  onDone: () => void;
  onClose: () => void;
}) {
  const [state, dispatch] = useReducer(bulkDeleteReducer, initialBulkDelete);
  const view = bulkDeleteView(state, items);
  const warnings = deleteWarnings(items, state.impacts);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      splitByOwner(items).owned.map(async (item) => {
        const result = await chatClient.artifactImpact(item.id);
        return [item.id, result.data?.impact ?? NO_IMPACT] as const;
      })
    ).then((entries) => {
      if (!cancelled) {
        const impacts: Record<string, ArtifactImpact> = Object.fromEntries(entries);
        dispatch({ type: 'impactsLoaded', impacts });
      }
    });
    return () => {
      cancelled = true;
    };
    // The owned set is fixed for the life of the dialog.
  }, []);

  const confirm = async () => {
    if (view.toRemove.length === 0) return;
    dispatch({ type: 'sent' });
    const outcomes = await eachInTurn(view.toRemove, (id) => chatClient.deleteArtifact(id));
    dispatch({ type: 'answered', outcomes });
    onDone();
    if (outcomes.some((outcome) => outcome.error !== null)) return;
    onClose();
  };

  return (
    <Modal title={bulkDeleteTitle(items.length)} onClose={onClose}>
      <div className="space-y-3 text-sm">
        {view.loading ? <p className="text-gray-500">Working out who uses them…</p> : null}
        {warnings.length > 0 ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
            <p className="mb-1 font-medium">Deleting removes these files for everyone</p>
            <ul className="space-y-0.5">
              {warnings.map((warning) => (
                <li key={warning.id}>{warning.line}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="text-gray-600 dark:text-gray-400">{deleteSummary(items)}</p>
        <DialogFooter
          busy={view.disabled}
          error={state.error}
          label={view.label}
          danger
          onCancel={onClose}
          onConfirm={() => void confirm()}
        />
      </div>
    </Modal>
  );
}
