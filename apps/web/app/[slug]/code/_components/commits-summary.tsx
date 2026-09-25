'use client';

/**
 * The Commits card on a code project's page: the newest commit on the
 * project's branch, with its own scrolling Commits page a click away.
 * Read once on open, with the person's own grant on whichever host the
 * repository is on (repo-host.ts) — on no usable token or an API
 * failure, the card stays and shows the reason (pulls-summary.tsx's own
 * pattern; pipelines-summary.tsx did this first).
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import LocalTime from '@/components/local-time';
import { Icon, ICONS } from '@/components/icons';
import { getJson } from '@/lib/fetch-json';
import type { HostCommit } from '@/lib/code/repo-host';

const sectionClass = 'rounded-lg border border-gray-200 p-4 dark:border-gray-800';

export default function CommitsSummary({
  href,
  tenantId,
  projectId,
}: {
  /** The project's Commits page. */
  href: string;
  tenantId: string;
  projectId: string;
}) {
  const [mostRecent, setMostRecent] = useState<HostCommit | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getJson<{ mostRecent: HostCommit | null }>(
        `/api/tenant/${tenantId}/code/projects/${projectId}/commits?view=summary`
      );
      if (cancelled) return;
      if (result.data) setMostRecent(result.data.mostRecent);
      else setError(result.error ?? 'Commits could not be read.');
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, projectId]);

  return (
    <section className={sectionClass} aria-busy={mostRecent === undefined && !error}>
      <div className="mb-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Commits</h2>
          <Link
            href={href}
            className="ml-auto flex items-center gap-1 text-xs font-medium whitespace-nowrap text-blue-600 hover:underline dark:text-blue-400"
          >
            See history
            <Icon path={ICONS.arrowRight} className="h-3.5 w-3.5" />
          </Link>
        </div>
        <p className="text-xs text-gray-500">The most recent commit on the project's branch.</p>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : mostRecent === undefined ? (
        <p className="text-sm text-gray-500">Reading…</p>
      ) : mostRecent ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <a
            href={mostRecent.url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-xs font-medium hover:underline"
          >
            {mostRecent.sha.slice(0, 12)}
          </a>
          <span className="min-w-0 truncate">{mostRecent.message}</span>
          <span className="text-xs text-gray-500">{mostRecent.author}</span>
          <LocalTime at={mostRecent.date} className="text-xs text-gray-500" />
        </p>
      ) : (
        <p className="text-sm text-gray-500">No commits yet.</p>
      )}
    </section>
  );
}
