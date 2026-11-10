'use client';

/**
 * A code project's open pull requests, read with the signed-in person's
 * own grant on whichever host the repository is on (repo-host.ts). Its
 * summary card on the project page is pulls-summary.tsx; what each row
 * shows is pulls-page.model.ts.
 */

import { useCallback, useEffect, useReducer } from 'react';
import BackLink from '@/components/back-link';
import ExternalLink from '@/components/external-link';
import LocalTime from '@/components/local-time';
import { getJson } from '@/lib/fetch-json';
import type { HostPullRequest } from '@/lib/code/repo-host';
import Pill from './pill';
import PrSubscribe from './pr-subscribe';
import {
  initialPulls,
  offersSubscribe,
  pullBranches,
  pullStatePill,
  pullTitle,
  pullsReducer,
  pullsView,
} from './pulls-page.model';

function StatePill({ state }: { state: HostPullRequest['state'] }) {
  const { tone, label } = pullStatePill(state);
  return <Pill tone={tone}>{label}</Pill>;
}

export default function PullsPage({
  projectId,
  projectName,
  repoFullName,
}: {
  projectId: string;
  projectName: string;
  repoFullName: string;
}) {
  const url = `/api/code/projects/${projectId}/pulls`;
  const [state, dispatch] = useReducer(pullsReducer, initialPulls);
  const { pullRequests, loadError, busy } = state;

  const reload = useCallback(async () => {
    dispatch({ type: 'reading' });
    const result = await getJson<{ pullRequests: HostPullRequest[] }>(url);
    if (result.data) dispatch({ type: 'loaded', pullRequests: result.data.pullRequests });
    else
      dispatch({
        type: 'loadFailed',
        error: result.error ?? 'The pull requests could not be read.',
      });
  }, [url]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const view = pullsView(state);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-gray-200 px-4 dark:border-gray-800">
        <BackLink href={`/code/${projectId}`} label={projectName} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">Pull requests</h1>
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
      </header>

      <div className="mx-auto max-w-4xl space-y-4 p-4">
        {view === 'error' ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {loadError}
          </p>
        ) : view === 'reading' || pullRequests === null ? (
          <p className="text-sm text-gray-500">Reading…</p>
        ) : view === 'empty' ? (
          <p className="text-sm text-gray-500">No open pull requests.</p>
        ) : (
          <>
            <ul className="divide-y divide-gray-200 sm:hidden dark:divide-gray-800">
              {pullRequests.map((pr) => (
                <li key={pr.number} className="space-y-1 py-2 text-sm">
                  <div className="flex items-center gap-2">
                    <ExternalLink
                      href={pr.url}
                      className="min-w-0 truncate font-medium hover:underline"
                    >
                      {pullTitle(pr)}
                    </ExternalLink>
                    <span className="ml-auto shrink-0">
                      <StatePill state={pr.state} />
                    </span>
                  </div>
                  <div className="truncate font-mono text-xs text-gray-500">{pullBranches(pr)}</div>
                  <div className="text-xs text-gray-500">
                    {pr.author} · <LocalTime at={pr.updatedAt} />
                  </div>
                  {offersSubscribe(pr) ? (
                    <details className="pt-1">
                      <summary className="cursor-pointer text-xs text-blue-600 dark:text-blue-400">
                        Subscribe
                      </summary>
                      <div className="mt-1.5">
                        <PrSubscribe projectId={projectId} prNumber={pr.number} prUrl={pr.url} />
                      </div>
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
            <table className="hidden w-full text-sm sm:table">
              <thead className="text-left text-xs text-gray-500">
                <tr>
                  <th scope="col" className="py-1 pr-2 font-medium">
                    PR
                  </th>
                  <th scope="col" className="py-1 pr-2 font-medium">
                    State
                  </th>
                  <th scope="col" className="py-1 pr-2 font-medium">
                    Branches
                  </th>
                  <th scope="col" className="hidden py-1 pr-2 font-medium sm:table-cell">
                    Author
                  </th>
                  <th scope="col" className="py-1 pr-2 font-medium">
                    Updated
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Subscribe
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                {pullRequests.map((pr) => (
                  <tr key={pr.number}>
                    <td className="py-1.5 pr-2">
                      <ExternalLink
                        href={pr.url}
                        className="block max-w-[24rem] truncate font-medium hover:underline"
                        title={pr.title}
                      >
                        {pullTitle(pr)}
                      </ExternalLink>
                    </td>
                    <td className="py-1.5 pr-2">
                      <StatePill state={pr.state} />
                    </td>
                    <td className="py-1.5 pr-2 font-mono text-xs">
                      <span className="block max-w-[14rem] truncate">{pullBranches(pr)}</span>
                    </td>
                    <td className="hidden max-w-[10rem] truncate py-1.5 pr-2 text-xs text-gray-500 sm:table-cell">
                      {pr.author || '—'}
                    </td>
                    <td className="py-1.5 pr-2 text-xs whitespace-nowrap text-gray-500">
                      <LocalTime at={pr.updatedAt} />
                    </td>
                    <td className="py-1.5 align-top">
                      {offersSubscribe(pr) ? (
                        <details>
                          <summary className="cursor-pointer text-xs text-blue-600 dark:text-blue-400">
                            Subscribe
                          </summary>
                          <div className="mt-1.5 w-56">
                            <PrSubscribe
                              projectId={projectId}
                              prNumber={pr.number}
                              prUrl={pr.url}
                            />
                          </div>
                        </details>
                      ) : null}
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
