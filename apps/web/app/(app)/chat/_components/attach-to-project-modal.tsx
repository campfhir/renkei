'use client';

/**
 * From the library: attach one artifact to one of the viewer's projects,
 * choosing how that project's chats use it. The project page's picker
 * (attach-artifacts-modal.tsx) is the same act from the other side.
 */

import { useState } from 'react';
import Modal from '@/components/modal';
import { chatClient } from '@/lib/chat/client';
import type { LibraryItem } from '@/lib/chat/artifact-library';
import { DialogFooter } from './chat-nav';
import { ModeToggle, type Mode } from './artifact-bits';

export default function AttachToProjectModal({
  item,
  projects,
  onDone,
  onClose,
}: {
  item: LibraryItem;
  projects: { id: string; name: string; kind: string }[];
  onDone: () => void;
  onClose: () => void;
}) {
  const open = projects.filter((project) => !item.projects.some((used) => used.id === project.id));
  const [projectId, setProjectId] = useState(open[0]?.id ?? '');
  const [mode, setMode] = useState<Mode>('on_demand');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const attach = async () => {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    const result = await chatClient.attachArtifact(projectId, item.id, mode);
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onDone();
    onClose();
  };

  return (
    <Modal title={`Attach ${item.filename}`} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void attach();
        }}
        className="space-y-3 text-sm"
      >
        {open.length === 0 ? (
          <p className="text-gray-500">It is attached to every project you can edit.</p>
        ) : (
          <>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-500">Project</span>
              <select
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
                className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
              >
                {open.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-gray-500">Its chats use it</span>
              <ModeToggle label="How the project's chats use it" value={mode} onChange={setMode} />
            </div>
          </>
        )}
        <DialogFooter
          busy={busy || open.length === 0}
          error={error}
          label="Attach"
          onCancel={onClose}
        />
      </form>
    </Modal>
  );
}
