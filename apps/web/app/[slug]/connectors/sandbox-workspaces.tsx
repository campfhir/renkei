'use client';

/**
 * The code-workspaces card on the connectors page — where a person clones
 * one of their Bitbucket repositories into the sandbox and hands it to a
 * chat. A workspace is a checkout the model can work in (list, search,
 * read and edit files, run the project's own commands, commit, push);
 * "Open in chat" starts a chat with that workspace named in the first
 * message. Clones run on the worker in the background, so a fresh row
 * reads "cloning" and this card polls until it is ready. Deleting a
 * workspace discards anything not pushed.
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { getJson, sendJson, sendJsonFull } from '@/lib/fetch-json';
import { inputClass } from '../admin/file-shares/share-config-fields';

export interface WorkspaceView {
  id: string;
  repoFullName: string;
  branch: string;
  status: 'cloning' | 'ready' | 'failed';
  error: string | null;
  sizeBytes: number;
  expiresAt: string;
  lastUsedAt: string;
}

interface RepoChoice {
  fullName: string;
  mainBranch: string | null;
}

const POLL_MS = 2_500;

function when(value: string): string {
  return new Date(value).toLocaleString();
}

function bytes(value: number): string {
  if (value < 1_048_576) return `${Math.max(1, Math.round(value / 1024))} KB`;
  if (value < 1_073_741_824) return `${(value / 1_048_576).toFixed(1)} MB`;
  return `${(value / 1_073_741_824).toFixed(2)} GB`;
}

export default function SandboxWorkspaces({
  slug,
  tenantId,
  workspaces: initialWorkspaces,
  bitbucketConnected,
  maxWorkspaces,
}: {
  slug: string;
  tenantId: string;
  workspaces: WorkspaceView[];
  /** Cloning needs the person's own Bitbucket grant; without one the form points at the Bitbucket card. */
  bitbucketConnected: boolean;
  maxWorkspaces: number;
}) {
  const [workspaces, setWorkspaces] = useState(initialWorkspaces);
  const [adding, setAdding] = useState(false);
  const [repository, setRepository] = useState('');
  const [branch, setBranch] = useState('');
  const [choices, setChoices] = useState<RepoChoice[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const base = `/api/tenant/${tenantId}/sandbox/workspaces`;

  // While any clone is running, follow it: the worker flips the row to
  // ready or failed on its own, and this is the only place a person sees it.
  const cloning = workspaces.some((workspace) => workspace.status === 'cloning');
  useEffect(() => {
    if (!cloning) return;
    const timer = setInterval(() => {
      void (async () => {
        const listed = await getJson<{ workspaces: WorkspaceView[] }>(base);
        if (listed.data) setWorkspaces(listed.data.workspaces);
      })();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [cloning, base]);

  const search = (query: string) => {
    setRepository(query);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!bitbucketConnected) return;
    searchTimer.current = setTimeout(() => {
      void (async () => {
        setSearching(true);
        const listed = await getJson<{ repos: RepoChoice[] }>(
          `${base}/repos?q=${encodeURIComponent(query.split('/').pop() ?? query)}`
        );
        setSearching(false);
        if (listed.data) setChoices(listed.data.repos.slice(0, 12));
      })();
    }, 300);
  };

  const clone = async () => {
    setBusy(true);
    setError(null);
    const result = await sendJsonFull<{ workspace: WorkspaceView }>(base, 'POST', {
      repository: repository.trim(),
      ...(branch.trim() ? { branch: branch.trim() } : {}),
    });
    setBusy(false);
    if (result.error || !result.data) {
      setError(result.error ?? 'Could not start the clone');
      return;
    }
    setWorkspaces((current) => [result.data!.workspace, ...current]);
    setAdding(false);
    setRepository('');
    setBranch('');
    setChoices([]);
  };

  const remove = async (workspace: WorkspaceView) => {
    if (
      !window.confirm(
        `Delete the workspace for ${workspace.repoFullName}? Anything not pushed is lost.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    const saveError = await sendJson(`${base}/${workspace.id}`, 'DELETE');
    setBusy(false);
    if (saveError) {
      setError(saveError);
      return;
    }
    setWorkspaces((current) => current.filter((entry) => entry.id !== workspace.id));
  };

  const full = workspaces.length >= maxWorkspaces;

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Code workspaces</h2>
        {adding ? null : (
          <button
            type="button"
            disabled={busy || full}
            title={full ? `At most ${maxWorkspaces} workspaces — delete one first.` : undefined}
            onClick={() => {
              setAdding(true);
              setError(null);
            }}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Clone a repository
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        A repository cloned into the sandbox for a chat to work in: it can read and edit the files,
        run the project’s own commands (tests, builds, installs) with your environment variables,
        commit, and push a branch back to Bitbucket. Workspaces expire a week after their last use.
      </p>

      {adding ? (
        <div className="mt-3 rounded-md border border-gray-200 p-3 dark:border-gray-800">
          {bitbucketConnected ? null : (
            <p className="mb-2 text-xs text-amber-700 dark:text-amber-400">
              Connect Bitbucket on this page first — a clone uses your own Bitbucket access.
            </p>
          )}
          <div className="grid gap-2 sm:grid-cols-[2fr_1fr]">
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">
              Repository
              <input
                value={repository}
                onChange={(event) => search(event.target.value)}
                placeholder="workspace/repo-slug"
                autoComplete="off"
                className={`mt-1 w-full font-mono ${inputClass}`}
                list="sandbox-workspace-repos"
              />
              <datalist id="sandbox-workspace-repos">
                {choices.map((choice) => (
                  <option key={choice.fullName} value={choice.fullName} />
                ))}
              </datalist>
            </label>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">
              Branch
              <input
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                placeholder={
                  choices.find((choice) => choice.fullName === repository)?.mainBranch ??
                  'main branch'
                }
                autoComplete="off"
                className={`mt-1 w-full font-mono ${inputClass}`}
              />
            </label>
          </div>
          {searching ? (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Searching Bitbucket…</p>
          ) : null}
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setAdding(false);
                setError(null);
              }}
              className="rounded-md px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-900"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || !bitbucketConnected || !repository.trim().includes('/')}
              onClick={() => void clone()}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? 'Starting…' : 'Clone'}
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}

      {workspaces.length === 0 && !adding ? (
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">No workspaces yet.</p>
      ) : null}

      <ul className="mt-3 space-y-3">
        {workspaces.map((workspace) => (
          <li
            key={workspace.id}
            className="rounded-md border border-gray-200 p-2.5 dark:border-gray-800"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-sm font-medium">
                <span className="font-mono">{workspace.repoFullName}</span>
                <span className="ml-1 text-gray-500 dark:text-gray-400">@ {workspace.branch}</span>
                <span
                  className={`ml-2 rounded px-1.5 py-0.5 text-[11px] font-medium ${
                    workspace.status === 'ready'
                      ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
                      : workspace.status === 'cloning'
                        ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300'
                        : 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
                  }`}
                >
                  {workspace.status === 'ready'
                    ? 'Ready'
                    : workspace.status === 'cloning'
                      ? 'Cloning…'
                      : 'Clone failed'}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-3">
                {workspace.status === 'ready' ? (
                  <Link
                    href={`/${slug}/chat/new?workspace=${workspace.id}`}
                    className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                  >
                    Open in chat
                  </Link>
                ) : null}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void remove(workspace)}
                  className="text-xs font-medium text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
                >
                  Delete
                </button>
              </span>
            </div>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {workspace.status === 'failed' && workspace.error ? (
                <span className="text-red-600 dark:text-red-400">{workspace.error} · </span>
              ) : null}
              {workspace.status === 'ready' ? `${bytes(workspace.sizeBytes)} · ` : ''}
              Last used {when(workspace.lastUsedAt)} · Expires {when(workspace.expiresAt)} ·{' '}
              <span className="font-mono">{workspace.id}</span>
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
