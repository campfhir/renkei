'use client';

/**
 * The Services card on a code project's page: what runs beside the
 * checkout at a glance — how many, their names — with the project's
 * Services page a click away for the addresses, the logs, and starting
 * or stopping one. Read once on open (the route's `?view=summary`,
 * counts and names only). Where the deployment offers no services the
 * card says so in a line rather than hiding, so the feature is
 * discoverable and its switch named.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icon, ICONS } from '@/components/icons';
import { getJson } from '@/lib/fetch-json';
import type { ServicesSummary } from '@/lib/code/services';

const sectionClass = 'rounded-lg border border-gray-200 p-4 dark:border-gray-800';

export default function ServicesSummaryCard({
  href,
  tenantId,
  projectId,
}: {
  /** The project's Services page. */
  href: string;
  tenantId: string;
  projectId: string;
}) {
  const [summary, setSummary] = useState<ServicesSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getJson<ServicesSummary>(
        `/api/tenant/${tenantId}/code/projects/${projectId}/services?view=summary`
      );
      if (cancelled) return;
      if (result.data) setSummary(result.data);
      else setError(result.error ?? 'The services could not be read.');
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, projectId]);

  return (
    <section className={sectionClass} aria-busy={summary === null && !error}>
      <div className="mb-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Services</h2>
          {summary?.enabled ? (
            <span
              className={`rounded px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${
                summary.running
                  ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
                  : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
              }`}
            >
              {summary.running ? `${summary.running} running` : 'None running'}
            </span>
          ) : null}
          <Link
            href={href}
            className="ml-auto flex items-center gap-1 text-xs font-medium whitespace-nowrap text-blue-600 hover:underline dark:text-blue-400"
          >
            Running services &amp; logs
            <Icon path={ICONS.arrowRight} className="h-3.5 w-3.5" />
          </Link>
        </div>
        <p className="text-xs text-gray-500">
          Containers beside the checkout for the project&rsquo;s tests: a database, a cache, a
          broker.
        </p>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : summary === null ? (
        <p className="text-sm text-gray-500">Reading from the sandbox…</p>
      ) : !summary.enabled ? (
        <p className="text-sm text-gray-500">Not enabled on this deployment.</p>
      ) : summary.names.length === 0 ? (
        <p className="text-sm text-gray-500">
          None yet
          <span className="text-gray-500">
            {' '}
            · {summary.allowedCount} allowed image{summary.allowedCount === 1 ? '' : 's'}
          </span>
        </p>
      ) : (
        <p className="text-sm">
          <span className="font-mono">{summary.names.join(', ')}</span>
          <span className="text-gray-500">
            {' '}
            · {summary.allowedCount} allowed image{summary.allowedCount === 1 ? '' : 's'}
          </span>
        </p>
      )}
    </section>
  );
}
