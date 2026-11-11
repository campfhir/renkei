'use client';

/**
 * A code chat's Pipelines dialog — its overflow menu's "Pipelines" item:
 * the project's Bitbucket Pipelines page, or its GitHub Actions page,
 * drawn in a dialog by the very same component the page uses
 * (pipelines-page.tsx / actions-page.tsx, `presentation="modal"`), so a
 * person can look at what a chat drafted — the workflow file, the
 * variables it set, the secrets still to add — and change it without
 * leaving the conversation. Which host it is, the repository and the
 * person's role are read from the project when the dialog opens; the
 * panel inside reads the setup itself and again after every change.
 */

import { useEffect, useState } from 'react';
import Modal from '@/components/modal';
import { LoadingLine } from '@/components/skeleton';
import { getJson } from '@/lib/fetch-json';
import { codeProjectUrl } from '@/lib/code/urls';
import ActionsPage from './actions-page';
import PipelinesPage from './pipelines-page';
import { modalTitle, panelFor, projectHostOf, type PipelinesTarget } from './pipelines-modal.model';

export default function PipelinesModal({
  projectId,
  projectName,
  onClose,
}: {
  projectId: string;
  projectName: string;
  onClose: () => void;
}) {
  const [target, setTarget] = useState<PipelinesTarget | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const result = await getJson<unknown>(codeProjectUrl(projectId));
      if (!live) return;
      const found = projectHostOf(result.data);
      if (found) setTarget(found);
      else setError(result.error ?? 'The project’s repository could not be read.');
    })();
    return () => {
      live = false;
    };
  }, [projectId]);

  return (
    <Modal title={modalTitle(target)} onClose={onClose} size="wide" flush>
      {error ? (
        <p role="alert" className="p-4 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : !target ? (
        <div className="p-4">
          <LoadingLine label="Reading the project" />
        </div>
      ) : panelFor(target) === 'actions' ? (
        <ActionsPage
          projectId={projectId}
          projectName={projectName}
          repoFullName={target.repoFullName}
          branch={target.branch}
          canEdit={target.canEdit}
          presentation="modal"
        />
      ) : panelFor(target) === 'pipelines' ? (
        <PipelinesPage
          projectId={projectId}
          projectName={projectName}
          repoFullName={target.repoFullName}
          branch={target.branch}
          canEdit={target.canEdit}
          presentation="modal"
        />
      ) : (
        <p className="p-4 text-sm text-gray-500">
          This project’s repository host has no pipelines to show here.
        </p>
      )}
    </Modal>
  );
}
