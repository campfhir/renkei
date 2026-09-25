'use client';

/**
 * The Actions card on a GitHub code project's page: the last workflow
 * run, with the project's own Actions page a click away for the recent
 * list. GitHub's Bitbucket counterpart is pipelines-summary.tsx (the
 * richer card, with the switch, the config file and variables) — this
 * one is deliberately smaller: GitHub Actions is configured on GitHub
 * itself (workflow YAML in the repo, secrets in the repo's own
 * settings), so there's nothing to set up from here, only runs to
 * watch. On no usable token or an API failure, the card stays and
 * shows the reason, matching pipelines-summary.tsx's own card.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import LocalTime from '@/components/local-time';
import { Icon, ICONS } from '@/components/icons';
import { getJson } from '@/lib/fetch-json';
import type { HostPipelineRun } from '@/lib/code/repo-host';
import Pill, { type PillTone } from './pill';

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
  tenantId,
  projectId,
}: {
  /** The project's Actions page. */
  href: string;
  tenantId: string;
  projectId: string;
}) {
  const [lastRun, setLastRun] = useState<HostPipelineRun | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getJson<{ lastRun: HostPipelineRun | null }>(
        `/api/tenant/${tenantId}/code/projects/${projectId}/actions?view=summary`
      );
      if (cancelled) return;
      if (result.data) setLastRun(result.data.lastRun);
      else setError(result.error ?? 'Actions could not be read.');
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, projectId]);

  return (
    <section className={sectionClass} aria-busy={lastRun === undefined && !error}>
      <div className="mb-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Actions</h2>
          <Link
            href={href}
            className="ml-auto flex items-center gap-1 text-xs font-medium whitespace-nowrap text-blue-600 hover:underline dark:text-blue-400"
          >
            Recent runs
            <Icon path={ICONS.arrowRight} className="h-3.5 w-3.5" />
          </Link>
        </div>
        <p className="text-xs text-gray-500">How GitHub Actions builds this repository.</p>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : lastRun === undefined ? (
        <p className="text-sm text-gray-500">Reading from GitHub…</p>
      ) : lastRun ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <a href={lastRun.url} target="_blank" rel="noopener noreferrer" className="font-medium hover:underline">
            Last run
          </a>
          <Pill tone={STATE_TONE[lastRun.state]}>{STATE_LABEL[lastRun.state]}</Pill>
          <span className="font-mono text-xs">{lastRun.ref}</span>
          {lastRun.startedAt ? (
            <LocalTime at={lastRun.startedAt} className="text-xs text-gray-500" />
          ) : null}
        </p>
      ) : (
        <p className="text-sm text-gray-500">No runs yet.</p>
      )}
    </section>
  );
}
