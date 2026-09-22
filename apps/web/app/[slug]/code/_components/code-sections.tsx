'use client';

/**
 * The two sections that make a project a code project, at the top of
 * its page: the repository (fixed when the project was made) and the
 * state of its checkout on the sandbox — none until the first chat
 * clones it, then ready, cloning, or failed with why — and the
 * environment: the names of the variables the project's commands run
 * with, replaced by pasting a `.env` again. Values are never shown; the
 * worker sealed them and only a command ever sees them.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getJson, sendJsonFull } from '@/lib/fetch-json';
import type { CodeProjectView } from '@/lib/code/project-view';

const sectionClass = 'rounded-lg border border-gray-200 p-4 dark:border-gray-800';
const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';
const POLL_MS = 2_500;

function when(value: string): string {
  return new Date(value).toLocaleString();
}

function bytes(value: number): string {
  if (value < 1_048_576) return `${Math.max(1, Math.round(value / 1024))} KB`;
  if (value < 1_073_741_824) return `${(value / 1_048_576).toFixed(1)} MB`;
  return `${(value / 1_073_741_824).toFixed(2)} GB`;
}

export default function CodeSections({
  tenantId,
  projectId,
  code,
  canEdit,
  envProblems,
}: {
  tenantId: string;
  projectId: string;
  code: CodeProjectView['code'];
  canEdit: boolean;
  /** Lines of a just-pasted .env that were not variables, reported once. */
  envProblems: string[];
}) {
  const router = useRouter();
  const base = `/api/tenant/${tenantId}/code/projects/${projectId}`;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [envOpen, setEnvOpen] = useState(false);
  const [envText, setEnvText] = useState('');
  const [problems, setProblems] = useState(envProblems);

  const workspace = code.workspace;
  const cloning = workspace?.status === 'cloning';

  // While a chat's clone runs, follow it: the worker flips the row on its
  // own, and the page's server data is the truth.
  useEffect(() => {
    if (!cloning) return;
    const timer = setInterval(() => {
      void (async () => {
        const view = await getJson<CodeProjectView>(base);
        if (view.data && view.data.code.workspace?.status !== 'cloning') router.refresh();
      })();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [cloning, base, router]);

  const replaceEnv = async () => {
    setBusy(true);
    setError(null);
    const result = await sendJsonFull<{ problems: string[] }>(`${base}/env`, 'PUT', {
      env: envText,
    });
    setBusy(false);
    if (result.error || !result.data) {
      setError(result.error ?? 'The environment could not be saved.');
      return;
    }
    setProblems(result.data.problems);
    setEnvOpen(false);
    setEnvText('');
    router.refresh();
  };

  const removeVariable = async (name: string) => {
    if (!window.confirm(`Remove ${name}? Commands will no longer see it.`)) return;
    setBusy(true);
    setError(null);
    const result = await sendJsonFull(`${base}/env`, 'DELETE', { name });
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    router.refresh();
  };

  const statusPill = !code.enabled ? (
    <Pill tone="amber">Workspaces off</Pill>
  ) : !workspace ? (
    <Pill tone="gray">Not cloned yet</Pill>
  ) : workspace.status === 'ready' ? (
    <Pill tone="green">Ready</Pill>
  ) : workspace.status === 'cloning' ? (
    <Pill tone="blue">Cloning…</Pill>
  ) : (
    <Pill tone="red">Clone failed</Pill>
  );

  const [workspaceSlug, repoSlug] = code.repoFullName.split('/');
  const isGitHub = code.repoProvider === 'github';
  const hostLabel = isGitHub ? 'GitHub' : 'Bitbucket';
  const hostUrl =
    workspaceSlug && repoSlug
      ? isGitHub
        ? `https://github.com/${encodeURIComponent(workspaceSlug)}/${encodeURIComponent(repoSlug)}`
        : `https://bitbucket.org/${encodeURIComponent(workspaceSlug)}/${encodeURIComponent(repoSlug)}`
      : null;

  return (
    <>
      <section className={sectionClass}>
        <div className="mb-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">Repository</h2>
            {statusPill}
            {hostUrl ? (
              <a
                href={hostUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto text-xs font-medium whitespace-nowrap text-blue-600 hover:underline dark:text-blue-400"
              >
                Open on {hostLabel}
              </a>
            ) : null}
          </div>
          <p className="text-xs text-gray-500">
            The repository this project works in, chosen when it was made.
          </p>
        </div>
        <p className="text-sm">
          <span className="font-mono">{code.repoFullName}</span>
          <span className="text-gray-500">
            {' '}
            @ {workspace?.branch || code.branch || 'default branch'}
          </span>
        </p>
        <p className="mt-1 text-xs text-gray-500">
          {!code.enabled
            ? 'Code workspaces are not enabled on this deployment; chats here have no code tools.'
            : !workspace
              ? `The first chat in this project clones it into the sandbox, with the chatting person’s own ${hostLabel} access.`
              : workspace.status === 'failed'
                ? `The last clone failed: ${workspace.error ?? 'unknown reason'}. The next chat tries again.`
                : workspace.status === 'cloning'
                  ? 'Cloning on the sandbox worker; this page follows it.'
                  : `${bytes(workspace.sizeBytes)} on the sandbox · expires ${when(workspace.expiresAt)} unless used · chats in this project work here, and clone again if it has expired.`}
        </p>
      </section>

      <section className={sectionClass}>
        <div className="mb-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">Environment</h2>
            {canEdit && code.enabled ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => setEnvOpen((value) => !value)}
                className="ml-auto text-xs font-medium whitespace-nowrap text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
              >
                {code.env.length ? 'Replace .env' : 'Add .env'}
              </button>
            ) : null}
          </div>
          <p className="text-xs text-gray-500">What the project’s commands run with.</p>
        </div>
        {code.env.length === 0 ? (
          <p className="text-sm text-gray-500">No environment variables.</p>
        ) : (
          <ul className="divide-y divide-gray-200 text-sm dark:divide-gray-800">
            {code.env.map((variable) => (
              <li key={variable.name} className="flex items-center gap-2 py-1.5">
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-mono">{variable.name}</span>
                  <span className="ml-2 text-xs text-gray-500">
                    set {when(variable.updatedAt)}
                    {variable.lastUsedAt ? ` · last used ${when(variable.lastUsedAt)}` : ''}
                  </span>
                </span>
                {canEdit ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void removeVariable(variable.name)}
                    className="text-xs text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
                  >
                    Remove
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {problems.length > 0 ? (
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
            Not read from the pasted .env: {problems.join('; ')}.
          </p>
        ) : null}
        {envOpen ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void replaceEnv();
            }}
            className="mt-3 space-y-2"
          >
            <textarea
              value={envText}
              onChange={(event) => setEnvText(event.target.value)}
              rows={6}
              spellCheck={false}
              aria-label=".env contents"
              placeholder={'NPM_TOKEN=…\nDATABASE_URL=postgres://…'}
              className={`font-mono ${inputClass}`}
            />
            <div className="flex items-center justify-end gap-2">
              <p className="mr-auto text-xs text-gray-500">
                Replaces every variable. Values are sealed on the worker and never shown again.
              </p>
              <button
                type="button"
                onClick={() => setEnvOpen(false)}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy || !envText.trim()}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        ) : null}
      </section>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </>
  );
}

function Pill({
  tone,
  children,
}: {
  tone: 'green' | 'blue' | 'red' | 'gray' | 'amber';
  children: string;
}) {
  const tones = {
    green: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
    blue: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
    red: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
    gray: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
    amber: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  };
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
