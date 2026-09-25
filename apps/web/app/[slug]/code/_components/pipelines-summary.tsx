'use client';

/**
 * The Pipelines card on a Bitbucket code project's page: the setup at a
 * glance — on or off, whether the pipeline file is on the branch, how
 * many variables — and the last run, with the project's Pipelines page
 * a click away for the runs, the switch and the variables themselves.
 * Read once on open, with the person's own grant; names and values stay
 * on the page that edits them (the summary view carries counts only).
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import LocalTime from '@/components/local-time';
import { Icon, ICONS } from '@/components/icons';
import ExternalLink from '@/components/external-link';
import { getJson } from '@/lib/fetch-json';
import type { PipelineSummary } from '@/lib/code/bitbucket-pipelines';
import { RunStatePill, StatusPill } from './pipelines-page';

const sectionClass = 'rounded-lg border border-gray-200 p-4 dark:border-gray-800';

export default function PipelinesSummary({
  href,
  tenantId,
  projectId,
  branch,
}: {
  /** The project's Pipelines page. */
  href: string;
  tenantId: string;
  projectId: string;
  /** The project's branch; empty for the repository's default. */
  branch: string;
}) {
  const [summary, setSummary] = useState<PipelineSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getJson<PipelineSummary>(
        `/api/tenant/${tenantId}/code/projects/${projectId}/pipelines?view=summary`
      );
      if (cancelled) return;
      if (result.data) setSummary(result.data);
      else setError(result.error ?? 'The pipelines could not be read.');
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, projectId]);

  const branchLabel = branch || 'the default branch';
  const facts: string[] = [];
  if (summary) {
    facts.push(
      summary.configFile === 'present'
        ? `bitbucket-pipelines.yml on ${branchLabel}`
        : summary.configFile === 'absent'
          ? `no bitbucket-pipelines.yml on ${branchLabel} yet`
          : 'pipeline file not checked'
    );
    if (summary.variableCount !== null) {
      facts.push(
        `${summary.variableCount} variable${summary.variableCount === 1 ? '' : 's'}` +
          (summary.environmentCount
            ? ` across the repository and ${summary.environmentCount} environment${summary.environmentCount === 1 ? '' : 's'}`
            : '')
      );
    }
  }

  return (
    <section className={sectionClass} aria-busy={summary === null && !error}>
      <div className="mb-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Pipelines</h2>
          {summary ? <StatusPill enabled={summary.enabled} /> : null}
          <Link
            href={href}
            className="ml-auto flex items-center gap-1 text-xs font-medium whitespace-nowrap text-blue-600 hover:underline dark:text-blue-400"
          >
            Runs, setup &amp; variables
            <Icon path={ICONS.arrowRight} className="h-3.5 w-3.5" />
          </Link>
        </div>
        <p className="text-xs text-gray-500">How Bitbucket builds and deploys this repository.</p>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : summary === null ? (
        <p className="text-sm text-gray-500">Reading from Bitbucket…</p>
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
            <span className="text-gray-500"> · {facts.join(' · ')}</span>
          </p>
          {summary.lastRun ? (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-gray-500">Last run</span>
              <ExternalLink href={summary.lastRun.url} className="font-medium hover:underline">
                #{summary.lastRun.buildNumber}
              </ExternalLink>
              <RunStatePill state={summary.lastRun.state} />
              <span className="font-mono text-xs">{summary.lastRun.ref}</span>
              {summary.lastRun.createdOn ? (
                <LocalTime at={summary.lastRun.createdOn} className="text-xs text-gray-500" />
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
