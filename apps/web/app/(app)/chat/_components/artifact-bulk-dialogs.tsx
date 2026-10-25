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
 */

import { useEffect, useState } from 'react';
import Modal from '@/components/modal';
import { chatClient } from '@/lib/chat/client';
import type { ArtifactImpact, LibraryItem } from '@/lib/chat/artifact-library';
import { DialogFooter } from './chat-nav';

/** Runs an act for each id in turn; the first failure does not stop the rest. */
async function eachInTurn(
  ids: string[],
  act: (id: string) => Promise<{ error: string | null }>
): Promise<string[]> {
  const failures: string[] = [];
  for (const id of ids) {
    const result = await act(id);
    if (result.error) failures.push(result.error);
  }
  return failures;
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
  const [projectId, setProjectId] = useState<string>(projects[0]?.id ?? '');
  const [mode, setMode] = useState<'always' | 'on_demand'>('on_demand');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const target = projects.find((project) => project.id === projectId) ?? null;
  const toAdd = items.filter((item) => !item.projects.some((project) => project.id === projectId));

  const confirm = async () => {
    if (!target || toAdd.length === 0) return;
    setBusy(true);
    setError(null);
    const failures = await eachInTurn(
      toAdd.map((item) => item.id),
      (id) =>
        chatClient.attachArtifact(target.id, id, mode).then((result) => ({ error: result.error }))
    );
    setBusy(false);
    onDone();
    if (failures.length > 0) {
      setError(`${failures.length} of ${toAdd.length} could not be added: ${failures[0]}`);
      return;
    }
    onClose();
  };

  return (
    <Modal
      title={`Add ${items.length} ${items.length === 1 ? 'file' : 'files'} to a project`}
      onClose={onClose}
    >
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
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
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
                value={mode}
                onChange={(event) =>
                  setMode(event.target.value === 'always' ? 'always' : 'on_demand')
                }
                className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
              >
                <option value="on_demand">On demand — searched and read when asked</option>
                <option value="always">Always — in full every turn, against the budget</option>
              </select>
            </label>
            <p className="text-xs text-gray-500">
              {toAdd.length === items.length
                ? `${toAdd.length} will be added.`
                : `${items.length - toAdd.length} already in ${target?.name ?? 'this project'}; ${toAdd.length} will be added.`}
            </p>
          </>
        )}
        <DialogFooter
          busy={busy || !target || toAdd.length === 0}
          error={error}
          label={`Add ${toAdd.length}`}
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
  const owned = items.filter((item) => item.via === 'owner');
  const left = items.filter((item) => item.via !== 'owner');
  const [impacts, setImpacts] = useState<Record<string, ArtifactImpact> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      owned.map(async (item) => {
        const result = await chatClient.artifactImpact(item.id);
        return [
          item.id,
          result.data?.impact ?? { projects: [], sharedWith: [], chat: null },
        ] as const;
      })
    ).then((entries) => {
      if (!cancelled) setImpacts(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
    // The owned set is fixed for the life of the dialog.
  }, []);

  const shared = owned.filter((item) => {
    const impact = impacts?.[item.id];
    return impact ? impact.projects.length > 0 || impact.sharedWith.length > 0 : false;
  });

  const confirm = async () => {
    setBusy(true);
    setError(null);
    const failures = await eachInTurn(
      items.map((item) => item.id),
      (id) => chatClient.deleteArtifact(id)
    );
    setBusy(false);
    onDone();
    if (failures.length > 0) {
      setError(`${failures.length} of ${items.length} could not be removed: ${failures[0]}`);
      return;
    }
    onClose();
  };

  return (
    <Modal
      title={`Delete ${items.length} ${items.length === 1 ? 'file' : 'files'}?`}
      onClose={onClose}
    >
      <div className="space-y-3 text-sm">
        {owned.length > 0 && impacts === null ? (
          <p className="text-gray-500">Working out who uses them…</p>
        ) : null}
        {shared.length > 0 ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
            <p className="mb-1 font-medium">Deleting removes these files for everyone</p>
            <ul className="space-y-0.5">
              {shared.map((item) => {
                const impact = impacts?.[item.id];
                const users = [
                  ...(impact?.projects.map((project) => project.name) ?? []),
                  ...(impact?.sharedWith.map((person) => person.name ?? person.email ?? '…') ?? []),
                ];
                return (
                  <li key={item.id}>
                    {item.filename}: {users.join(', ')}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
        <p className="text-gray-600 dark:text-gray-400">
          {owned.length > 0
            ? `${owned.length} ${owned.length === 1 ? 'file is' : 'files are'} yours and will be removed for good.`
            : null}
          {owned.length > 0 && left.length > 0 ? ' ' : null}
          {left.length > 0
            ? `${left.length} shared with you ${left.length === 1 ? 'leaves' : 'leave'} your list; the owner keeps ${left.length === 1 ? 'it' : 'them'}.`
            : null}
        </p>
        <DialogFooter
          busy={busy || (owned.length > 0 && impacts === null)}
          error={error}
          label={`Delete ${items.length}`}
          danger
          onCancel={onClose}
          onConfirm={() => void confirm()}
        />
      </div>
    </Modal>
  );
}
