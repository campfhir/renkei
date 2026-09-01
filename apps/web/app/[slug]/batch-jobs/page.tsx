import React from 'react';
import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { listBatches } from '@renkei/batch-jobs-store';
import { BatchStatusPill, batchStatusLabel, batchProgress } from './batch-status';
import LocalTime from '@/components/local-time';
import AutoRefresh from '@/components/auto-refresh';

const STATUS_TABS = ['running', 'succeeded', 'partial', 'failed'] as const;

/** Your batch jobs — a per-user list, the runs-page precedent. */
export default async function BatchJobsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ status?: string }>;
}): Promise<React.ReactNode> {
  const { slug } = await params;
  const { status } = await searchParams;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();

  const session = await getSessionFromCookies(tenant.id);
  if (!session) {
    redirect(signInUrl(tenant.id, `/${slug}/batch-jobs`));
  }

  const dbResult = getDatabase();
  const filter = STATUS_TABS.some((tab) => tab === status) ? status : undefined;
  const batches = dbResult.ok
    ? await listBatches(dbResult.val, tenant.id, session.subject, { limit: 50, status: filter })
    : [];

  const tabHref = (tabStatus?: string) =>
    tabStatus ? `/${slug}/batch-jobs?status=${tabStatus}` : `/${slug}/batch-jobs`;

  return (
    <div className="mx-auto max-w-3xl">
      <AutoRefresh />
      <div className="mb-1 flex items-center justify-between gap-3">
        <h1 className="min-w-0 truncate text-xl font-bold">Batch Jobs</h1>
        <Link
          href={`/${slug}/batch-jobs/new`}
          className="shrink-0 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          New batch job
        </Link>
      </div>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Long-running work over many documents at once — pull a fileshare folder through OCR and
        stage the results for an agent to classify and file. Started here or by an agent calling
        batch_start_document_pipeline; both land in this list.
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        {[
          { label: 'All', value: undefined },
          // Shorter than the full "Partially succeeded" pill label — a tab
          // is a chip, not a sentence.
          ...STATUS_TABS.map((value) => ({
            label: value === 'partial' ? 'Partial' : batchStatusLabel(value),
            value,
          })),
        ].map((tab) => (
          <Link
            key={tab.label}
            href={tabHref(tab.value)}
            className={`rounded-full border px-3 py-1 ${
              tab.value === filter
                ? 'border-blue-600 bg-blue-600 text-white'
                : 'border-gray-300 text-gray-600 dark:border-gray-700 dark:text-gray-400'
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </div>

      {batches.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {filter ? 'No batch jobs match.' : 'No batch jobs yet.'}
        </p>
      ) : (
        <ul className="space-y-2">
          {batches.map((batch) => (
            <li key={batch.id}>
              <Link
                href={`/${slug}/batch-jobs/${batch.id}`}
                className="flex items-center justify-between gap-3 rounded-md border border-gray-200 p-3 text-sm hover:border-blue-400 dark:border-gray-800"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <BatchStatusPill status={batch.status} />
                  <span className="truncate text-gray-600 dark:text-gray-400">{batch.kind}</span>
                </span>
                <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">
                  {batchProgress(batch)} · <LocalTime at={batch.created_at} format="date" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {batches.length === 50 ? (
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
          Showing the newest 50 matching batch jobs — narrow with a status tab to reach older ones.
        </p>
      ) : null}
    </div>
  );
}
