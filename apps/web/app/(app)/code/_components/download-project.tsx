'use client';

/**
 * An offline copy of a code project: a button beside Share in the
 * project's header that opens a small dialog and, once the dialog has
 * looked at the checkout, downloads it as a zip
 * (`…/code/projects/[id]/archive`) — the project's base clone as it is
 * on the sandbox, ignored files such as node_modules included, `.git`
 * left out. Before any chat has cloned the repository there is nothing
 * to copy, and the dialog says so instead.
 */

import { useEffect, useState } from 'react';
import Modal from '@/components/modal';
import { Icon, ICONS } from '@/components/icons';
import { LoadingLine } from '@/components/skeleton';
import { getJson } from '@/lib/fetch-json';
import type { CodeProjectView } from '@/lib/code/project-view';

function bytes(value: number): string {
  if (value < 1_048_576) return `${Math.max(1, Math.round(value / 1024))} KB`;
  if (value < 1_073_741_824) return `${(value / 1_048_576).toFixed(1)} MB`;
  return `${(value / 1_073_741_824).toFixed(2)} GB`;
}

export default function DownloadProjectButton({
  projectId,
  repoFullName,
}: {
  projectId: string;
  repoFullName: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Download project"
        title="Download an offline copy"
        className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-900"
      >
        <Icon path={ICONS.download} className="h-5 w-5" />
      </button>
      {open ? (
        <DownloadProjectModal
          projectId={projectId}
          repoFullName={repoFullName}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function DownloadProjectModal({
  projectId,
  repoFullName,
  onClose,
}: {
  projectId: string;
  repoFullName: string;
  onClose: () => void;
}) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; workspace: CodeProjectView['code']['workspace']; enabled: boolean }
  >({ kind: 'loading' });
  useEffect(() => {
    let cancelled = false;
    void getJson<CodeProjectView>(`/api/code/projects/${projectId}`).then((result) => {
      if (cancelled) return;
      if (!result.data) {
        setState({ kind: 'error', message: result.error ?? 'The project could not be read.' });
        return;
      }
      setState({
        kind: 'ready',
        workspace: result.data.code.workspace,
        enabled: result.data.code.enabled,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  const repoName = repoFullName.slice(repoFullName.lastIndexOf('/') + 1);
  const ready = state.kind === 'ready' && state.enabled && state.workspace?.status === 'ready';
  return (
    <Modal title="Download an offline copy" onClose={onClose}>
      <p className="text-sm text-gray-700 dark:text-gray-300">
        A zip of the checkout as it is on the sandbox — every file, ignored ones such as{' '}
        <span className="font-mono text-xs">node_modules</span> included, so it works without a
        network. The repository’s own history (<span className="font-mono text-xs">.git</span>)
        stays on its host.
      </p>
      <div className="mt-3 text-sm">
        {state.kind === 'loading' ? (
          <LoadingLine size="xs" label="Looking at the checkout…" />
        ) : state.kind === 'error' ? (
          <p role="alert" className="text-red-600 dark:text-red-400">
            {state.message}
          </p>
        ) : !state.enabled ? (
          <p className="text-gray-500">Code workspaces are not enabled on this deployment.</p>
        ) : !state.workspace ? (
          <p className="text-gray-500" data-testid="download-not-cloned">
            Nothing is cloned yet: the first chat in this project clones the repository, and
            there is a copy to download after that.
          </p>
        ) : state.workspace.status !== 'ready' ? (
          <p className="text-gray-500">
            {state.workspace.status === 'cloning'
              ? 'The clone is still running; try again once it is ready.'
              : `The last clone failed: ${state.workspace.error ?? 'unknown reason'}.`}
          </p>
        ) : (
          <p className="text-gray-600 dark:text-gray-400">
            <span className="font-mono text-xs">{repoName}.zip</span> · about{' '}
            {bytes(state.workspace.sizeBytes)} before compression, on branch{' '}
            <span className="font-mono text-xs">{state.workspace.branch}</span>.
          </p>
        )}
      </div>
      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
        >
          Done
        </button>
        {ready ? (
          <a
            href={`/api/code/projects/${projectId}/archive`}
            download={`${repoName}.zip`}
            className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            <Icon path={ICONS.download} className="h-4 w-4" />
            Download zip
          </a>
        ) : (
          <button
            type="button"
            disabled
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white opacity-50"
          >
            Download zip
          </button>
        )}
      </div>
    </Modal>
  );
}
