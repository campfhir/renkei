import React from 'react';
import Link from 'next/link';
import BackLink from '@/components/back-link';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { getBatch, listItems } from '@renkei/batch-jobs-store';
import { BatchStatusPill, batchStatusLabel, batchProgress } from '../batch-status';
import LocalTime from '@/components/local-time';
import AutoRefresh from '@/components/auto-refresh';

const ITEM_STATUS_TABS = ['pending', 'processing', 'succeeded', 'failed'] as const;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export default async function BatchJobDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; batchId: string }>;
  searchParams: Promise<{ status?: string }>;
}): Promise<React.ReactNode> {
  const { slug, batchId } = await params;
  const { status } = await searchParams;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();

  const session = await getSessionFromCookies(tenant.id);
  if (!session) {
    redirect(signInUrl(tenant.id, `/${slug}/batch-jobs/${batchId}`));
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const batch = await getBatch(dbResult.val, batchId, tenant.id);
  // A batch owned by someone else reads as "not found" — same discipline
  // batch_get_job uses (id alone is not an existence oracle).
  if (!batch || batch.subject !== session.subject) notFound();

  const filter = ITEM_STATUS_TABS.some((tab) => tab === status) ? status : undefined;
  const items = await listItems(dbResult.val, batch.id, { limit: 200, status: filter });

  const tabHref = (tabStatus?: string) =>
    tabStatus ? `/${slug}/batch-jobs/${batchId}?status=${tabStatus}` : `/${slug}/batch-jobs/${batchId}`;

  return (
    <div className="mx-auto max-w-3xl">
      <AutoRefresh />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <BackLink href={`/${slug}/batch-jobs`} label="Batch Jobs" />
        <h1 className="min-w-0 truncate text-xl font-bold">{batch.name}</h1>
        <BatchStatusPill status={batch.status} />
      </div>

      <div className="mb-6 space-y-1 rounded-md border border-gray-200 p-3 text-sm dark:border-gray-800">
        <p>
          <span className="font-medium">Kind:</span> {batch.kind}
        </p>
        {batch.schedule_id ? (
          <p>
            <span className="font-medium">Schedule:</span>{' '}
            <Link
              href={`/${slug}/batch-jobs/schedules/${batch.schedule_id}`}
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              Started by a schedule
            </Link>
          </p>
        ) : null}
        <p>
          <span className="font-medium">Progress:</span> {batchProgress(batch)}
        </p>
        <p>
          <span className="font-medium">Started:</span>{' '}
          <LocalTime at={batch.created_at} />
        </p>
        {batch.finished_at ? (
          <p>
            <span className="font-medium">Finished:</span> <LocalTime at={batch.finished_at} />
          </p>
        ) : null}
        {batch.last_error ? (
          <p className="text-red-700 dark:text-red-300">
            <span className="font-medium">Error:</span> {batch.last_error}
          </p>
        ) : null}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        {[
          { label: 'All', value: undefined },
          ...ITEM_STATUS_TABS.map((value) => ({ label: batchStatusLabel(value), value })),
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

      {items.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {filter ? 'No items match.' : batch.total === null ? 'Still discovering the source folder…' : 'No items.'}
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => {
            const documentKey = str(item.payload.documentKey) || item.id;
            const sandboxFileId = item.result ? str(item.result.sandboxFileId) : '';
            return (
              <li
                key={item.id}
                className="rounded-md border border-gray-200 p-3 text-sm dark:border-gray-800"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate font-medium">{documentKey}</span>
                  <BatchStatusPill status={item.status} />
                </div>
                {sandboxFileId ? (
                  <p className="mt-1 break-all font-mono text-xs text-gray-500 dark:text-gray-400">
                    Staged as sandbox file {sandboxFileId} — readable with sandbox_read_file.
                  </p>
                ) : null}
                {item.error ? (
                  <p className="mt-1 text-xs text-red-700 dark:text-red-300">{item.error}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {items.length === 200 ? (
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
          Showing the first 200 matching items — narrow with a status tab to see the rest.
        </p>
      ) : null}
    </div>
  );
}
