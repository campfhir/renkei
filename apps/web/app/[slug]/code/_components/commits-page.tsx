'use client';

/**
 * A code project's recent commit history on its own branch, read with
 * the signed-in person's own grant on whichever host the repository is
 * on (repo-host.ts) — a scrollable list, "Load more" widening the page
 * rather than a true cursor (the adapter has no next-page token today;
 * raising `max` is the simple version of "keep going"). Its summary
 * card on the project page is commits-summary.tsx.
 */

import { useCallback, useEffect, useState } from 'react';
import BackLink from '@/components/back-link';
import LocalTime from '@/components/local-time';
import { getJson } from '@/lib/fetch-json';
import type { HostCommit } from '@/lib/code/repo-host';

const PAGE = 30;

export default function CommitsPage({
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
  const base = `/api/tenant/${tenantId}/code/projects/${projectId}/commits`;
  const [commits, setCommits] = useState<HostCommit[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [max, setMax] = useState(PAGE);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(
    async (nextMax: number) => {
      setBusy(true);
      const result = await getJson<{ commits: HostCommit[]; hasMore: boolean }>(
        `${base}?max=${nextMax}`
      );
      setBusy(false);
      if (result.data) {
        setCommits(result.data.commits);
        setHasMore(result.data.hasMore);
        setLoadError(null);
      } else setLoadError(result.error ?? 'The commits could not be read.');
    },
    [base]
  );

  useEffect(() => {
    void reload(max);
  }, [reload, max]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-gray-200 px-4 dark:border-gray-800">
        <BackLink href={`/${slug}/code/${projectId}`} label={projectName} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">Commits</h1>
          <p className="truncate text-xs text-gray-500">
            {projectName} · <span className="font-mono">{repoFullName}</span>
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void reload(max)}
          className="rounded-md border border-gray-300 px-2.5 py-1 text-xs hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
        >
          Refresh
        </button>
      </header>

      <div className="mx-auto max-w-3xl space-y-4 p-4">
        {loadError ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {loadError}
          </p>
        ) : commits === null ? (
          <p className="text-sm text-gray-500">Reading…</p>
        ) : commits.length === 0 ? (
          <p className="text-sm text-gray-500">No commits yet.</p>
        ) : (
          <>
            <ul className="max-h-[calc(100vh-10rem)] divide-y divide-gray-200 overflow-y-auto text-sm dark:divide-gray-800">
              {commits.map((commit) => (
                <li key={commit.sha} className="space-y-1 py-2">
                  <div className="flex items-center gap-2">
                    <a
                      href={commit.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-xs font-medium hover:underline"
                    >
                      {commit.sha.slice(0, 12)}
                    </a>
                    <span className="min-w-0 truncate">{commit.message}</span>
                  </div>
                  <div className="text-xs text-gray-500">
                    {commit.author} · <LocalTime at={commit.date} />
                  </div>
                </li>
              ))}
            </ul>
            {hasMore ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => setMax((was) => was + PAGE)}
                className="w-full rounded-md border border-gray-300 py-1.5 text-sm hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
              >
                {busy ? 'Loading…' : 'Load more'}
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
