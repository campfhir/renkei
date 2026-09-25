'use client';

/**
 * The Pulls card on a code project's page: how many pull requests are
 * open, and the one most recently updated, with the project's Pulls
 * page a click away for the full list. Read once on open, with the
 * person's own grant on whichever host the repository is on
 * (repo-host.ts) — hidden entirely rather than shown broken when
 * there's no usable token, matching lib/code/github-browse.ts's
 * hide-on-failure pattern (a project screen never fails for want of a
 * PR list).
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import LocalTime from '@/components/local-time';
import { Icon, ICONS } from '@/components/icons';
import { getJson } from '@/lib/fetch-json';
import type { HostPullRequest } from '@/lib/code/repo-host';
import Pill from './pill';

const sectionClass = 'rounded-lg border border-gray-200 p-4 dark:border-gray-800';

interface Summary {
  openCount: number;
  hasMore: boolean;
  mostRecent: HostPullRequest | null;
}

export default function PullsSummary({
  href,
  tenantId,
  projectId,
}: {
  /** The project's Pulls page. */
  href: string;
  tenantId: string;
  projectId: string;
}) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getJson<Summary>(
        `/api/tenant/${tenantId}/code/projects/${projectId}/pulls?view=summary`
      );
      if (cancelled) return;
      if (result.data) setSummary(result.data);
      else setHidden(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, projectId]);

  if (hidden) return null;

  return (
    <section className={sectionClass} aria-busy={summary === null}>
      <div className="mb-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Pull requests</h2>
          {summary ? (
            <Pill tone={summary.openCount > 0 ? 'green' : 'gray'}>
              {summary.openCount}
              {summary.hasMore ? '+' : ''} open
            </Pill>
          ) : null}
          <Link
            href={href}
            className="ml-auto flex items-center gap-1 text-xs font-medium whitespace-nowrap text-blue-600 hover:underline dark:text-blue-400"
          >
            See all
            <Icon path={ICONS.arrowRight} className="h-3.5 w-3.5" />
          </Link>
        </div>
        <p className="text-xs text-gray-500">Open on the project's repository.</p>
      </div>
      {summary === null ? (
        <p className="text-sm text-gray-500">Reading…</p>
      ) : summary.mostRecent ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <a
            href={summary.mostRecent.url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium hover:underline"
          >
            #{summary.mostRecent.number} {summary.mostRecent.title}
          </a>
          <span className="font-mono text-xs text-gray-500">
            {summary.mostRecent.sourceBranch} → {summary.mostRecent.destinationBranch}
          </span>
          <LocalTime at={summary.mostRecent.updatedAt} className="text-xs text-gray-500" />
        </p>
      ) : (
        <p className="text-sm text-gray-500">No open pull requests.</p>
      )}
    </section>
  );
}
