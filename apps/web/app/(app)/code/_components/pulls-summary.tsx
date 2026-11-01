'use client';

/**
 * The Pulls card on a code project's page: how many pull requests are
 * open, and the one most recently updated — with its own condensed
 * pipeline-subscribe row (pr-subscribe.tsx's `compact` layout), so
 * subscribing to the PR that's actually current doesn't require a trip
 * to the full Pulls page. Read once on open, with the person's own
 * grant on whichever host the repository is on (repo-host.ts) — on no
 * usable token or an API failure, the card stays and shows the reason
 * (matching pipelines-summary.tsx's own error-surfacing card, not
 * hiding it: "GitHub is not connected. Connect it on the Connectors
 * page, then try again." is exactly the thing a person needs to see,
 * not silence). What the card shows when is pulls-summary.model.ts.
 */

import Link from 'next/link';
import { useEffect, useReducer } from 'react';
import LocalTime from '@/components/local-time';
import { Icon, ICONS } from '@/components/icons';
import ExternalLink from '@/components/external-link';
import { getJson } from '@/lib/fetch-json';
import Pill from './pill';
import PrSubscribe from './pr-subscribe';
import {
  initialPullsSummary,
  openCountPill,
  pullsSummaryReducer,
  summaryView,
  type Summary,
} from './pulls-summary.model';

const sectionClass = 'rounded-lg border border-gray-200 p-4 dark:border-gray-800';

export default function PullsSummary({
  href,
  projectId,
}: {
  /** The project's Pulls page. */
  href: string;
  projectId: string;
}) {
  const [state, dispatch] = useReducer(pullsSummaryReducer, initialPullsSummary);
  const { summary, error } = state;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getJson<Summary>(`/api/code/projects/${projectId}/pulls?view=summary`);
      if (cancelled) return;
      if (result.data) dispatch({ type: 'loaded', summary: result.data });
      else dispatch({ type: 'loadFailed', error: result.error });
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <section className={sectionClass} aria-busy={summary === null && !error}>
      <div className="mb-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Pull requests</h2>
          {summary ? (
            <Pill tone={openCountPill(summary).tone}>{openCountPill(summary).label}</Pill>
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
      {summaryView(state) === 'error' ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : summary === null ? (
        <p className="text-sm text-gray-500">Reading…</p>
      ) : summary.mostRecent ? (
        <div className="space-y-1.5">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <ExternalLink href={summary.mostRecent.url} className="font-medium hover:underline">
              #{summary.mostRecent.number} {summary.mostRecent.title}
            </ExternalLink>
            <span className="font-mono text-xs text-gray-500">
              {summary.mostRecent.sourceBranch} → {summary.mostRecent.destinationBranch}
            </span>
            <LocalTime at={summary.mostRecent.updatedAt} className="text-xs text-gray-500" />
          </p>
          <PrSubscribe
            compact
            projectId={projectId}
            prNumber={summary.mostRecent.number}
            prUrl={summary.mostRecent.url}
          />
        </div>
      ) : (
        <p className="text-sm text-gray-500">No open pull requests.</p>
      )}
    </section>
  );
}
