'use client';

/**
 * The Actions card on a GitHub code project's page — pipelines-summary.tsx
 * for GitHub: the switch, how many workflow files are on the branch and
 * how many variables the runs get, and the last run, with the Actions page
 * (actions-page.tsx) a click away for the runs, the files and the
 * variables themselves. The counts come from `?view=summary`: no variable
 * names or values, so any member may see it. On no usable token or an API
 * failure the card stays and shows the reason.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import LocalTime from '@/components/local-time';
import { Icon, ICONS } from '@/components/icons';
import ExternalLink from '@/components/external-link';
import { getJson } from '@/lib/fetch-json';
import type { ActionsSummary as Summary } from '@/lib/code/github-actions';
import type { HostPipelineRun } from '@/lib/code/repo-host';
import Pill, { type PillTone } from './pill';
import { StatusPill } from './pipeline-parts';
import { summaryFacts } from './actions-summary.model';

const sectionClass = 'rounded-lg border border-gray-200 p-4 dark:border-gray-800';

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

export default function ActionsSummary({
  href,
  projectId,
  branch = '',
}: {
  /** The project's Actions page. */
  href: string;
  projectId: string;
  /** The project's branch; empty for the repository's default. */
  branch?: string;
}) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getJson<Summary>(`/api/code/projects/${projectId}/actions?view=summary`);
      if (cancelled) return;
      if (result.data) setSummary(result.data);
      else setError(result.error ?? 'Actions could not be read.');
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const lastRun = summary?.lastRun ?? null;
  return (
    <section className={sectionClass} aria-busy={summary === null && !error}>
      <div className="mb-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Actions</h2>
          {summary ? <StatusPill enabled={summary.enabled} /> : null}
          <Link
            href={href}
            className="ml-auto flex items-center gap-1 text-xs font-medium whitespace-nowrap text-blue-600 hover:underline dark:text-blue-400"
          >
            Runs, setup &amp; variables
            <Icon path={ICONS.arrowRight} className="h-3.5 w-3.5" />
          </Link>
        </div>
        <p className="text-xs text-gray-500">How GitHub builds and deploys this repository.</p>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : summary === null ? (
        <p className="text-sm text-gray-500">Reading from GitHub…</p>
      ) : (
        <div className="space-y-1 text-sm">
          <p>
            {summary.enabled === null ? (
              <span className="text-gray-500">Switch not readable</span>
            ) : summary.enabled ? (
              'On'
            ) : (
              'Off'
            )}
            <span className="text-gray-500"> · {summaryFacts(summary, branch).join(' · ')}</span>
          </p>
          {lastRun ? (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-gray-500">Last run</span>
              <ExternalLink href={lastRun.url} className="font-medium hover:underline">
                Run {lastRun.id}
              </ExternalLink>
              <Pill tone={STATE_TONE[lastRun.state]}>{STATE_LABEL[lastRun.state]}</Pill>
              <span className="font-mono text-xs">{lastRun.ref}</span>
              {lastRun.startedAt ? (
                <LocalTime at={lastRun.startedAt} className="text-xs text-gray-500" />
              ) : null}
            </p>
          ) : summary.runsError ? (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Runs could not be read: {summary.runsError}
            </p>
          ) : (
            <p className="text-gray-500">No runs yet.</p>
          )}
        </div>
      )}
    </section>
  );
}
