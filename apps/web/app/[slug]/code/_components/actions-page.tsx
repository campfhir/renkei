'use client';

/**
 * A GitHub code project's recent Actions runs. Bitbucket's richer
 * counterpart is pipelines-page.tsx (the switch, the config file, the
 * variables); this page is deliberately just the run list — see
 * actions-summary.tsx's note on why GitHub Actions has nothing to
 * configure from here.
 */

import { useCallback, useEffect, useState } from 'react';
import BackLink from '@/components/back-link';
import ExternalLink from '@/components/external-link';
import LocalTime from '@/components/local-time';
import { getJson } from '@/lib/fetch-json';
import type { HostPipelineRun } from '@/lib/code/repo-host';
import Pill, { type PillTone } from './pill';

const STATE_TONE: Record<HostPipelineRun['state'], PillTone> = {
  success: 'green',
  failure: 'red',
  running: 'blue',
  pending: 'gray',
  other: 'gray',
};
const STATE_LABEL: Record<HostPipelineRun['state'], string> = {
  success: 'Success',
  failure: 'Failure',
  running: 'Running',
  pending: 'Pending',
  other: 'Unknown',
};

export default function ActionsPage({
  slug,
  tenantId,
  projectId,
  projectName,
  repoFullName,
}: {
  slug: string;
  tenantId: string;
  projectId: string;
  projectName: string;
  repoFullName: string;
}) {
  const url = `/api/tenant/${tenantId}/code/projects/${projectId}/actions`;
  const [runs, setRuns] = useState<HostPipelineRun[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setBusy(true);
    const result = await getJson<{ runs: HostPipelineRun[] }>(url);
    setBusy(false);
    if (result.data) {
      setRuns(result.data.runs);
      setLoadError(null);
    } else setLoadError(result.error ?? 'The runs could not be read.');
  }, [url]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-gray-200 px-4 dark:border-gray-800">
        <BackLink href={`/${slug}/code/${projectId}`} label={projectName} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">Actions</h1>
          <p className="truncate text-xs text-gray-500">
            {projectName} · <span className="font-mono">{repoFullName}</span>
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void reload()}
          className="rounded-md border border-gray-300 px-2.5 py-1 text-xs hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
        >
          Refresh
        </button>
        <ExternalLink
          href={`https://github.com/${repoFullName}/actions`}
          className="text-xs font-medium whitespace-nowrap text-blue-600 hover:underline dark:text-blue-400"
        >
          Open on GitHub
        </ExternalLink>
      </header>

      <div className="mx-auto max-w-3xl space-y-4 p-4">
        <p className="text-xs text-gray-500">
          Workflow YAML and secrets live in the repository itself — configure them on GitHub.
        </p>
        {loadError ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {loadError}
          </p>
        ) : runs === null ? (
          <p className="text-sm text-gray-500">Reading…</p>
        ) : runs.length === 0 ? (
          <p className="text-sm text-gray-500">No runs yet.</p>
        ) : (
          <>
            <ul className="divide-y divide-gray-200 sm:hidden dark:divide-gray-800">
              {runs.map((run) => (
                <li key={run.id} className="space-y-1 py-2 text-sm">
                  <div className="flex items-center gap-2">
                    <ExternalLink href={run.url} className="font-medium hover:underline">
                      Run {run.id}
                    </ExternalLink>
                    <span className="ml-auto shrink-0">
                      <Pill tone={STATE_TONE[run.state]}>{STATE_LABEL[run.state]}</Pill>
                    </span>
                  </div>
                  <div className="truncate font-mono text-xs" title={run.ref}>
                    {run.ref}
                  </div>
                  <div className="text-xs text-gray-500">
                    {run.startedAt ? <LocalTime at={run.startedAt} /> : '—'}
                  </div>
                </li>
              ))}
            </ul>
            <table className="hidden w-full text-sm sm:table">
              <thead className="text-left text-xs text-gray-500">
                <tr>
                  <th scope="col" className="py-1 pr-2 font-medium">
                    Run
                  </th>
                  <th scope="col" className="py-1 pr-2 font-medium">
                    State
                  </th>
                  <th scope="col" className="py-1 pr-2 font-medium">
                    Branch
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Started
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td className="py-1.5 pr-2 whitespace-nowrap">
                      <ExternalLink href={run.url} className="font-medium hover:underline">
                        Run {run.id}
                      </ExternalLink>
                    </td>
                    <td className="py-1.5 pr-2">
                      <Pill tone={STATE_TONE[run.state]}>{STATE_LABEL[run.state]}</Pill>
                    </td>
                    <td className="py-1.5 pr-2 font-mono text-xs">
                      <span className="block max-w-[10rem] truncate" title={run.ref}>
                        {run.ref}
                      </span>
                    </td>
                    <td className="py-1.5 text-xs whitespace-nowrap text-gray-500">
                      {run.startedAt ? <LocalTime at={run.startedAt} /> : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}
