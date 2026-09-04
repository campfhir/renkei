import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { readStorage } from '@/lib/storage-admin';
import StorageForm from './storage-form';

/**
 * Where the organization's files live: the Azure Blob account that holds
 * chat uploads and the files tools produce. Without one, uploads are off
 * and the model is told not to produce files.
 */
export default async function StoragePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactNode> {
  const { slug } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) notFound();
  if (!(await checkAccess(tenantRef.id, [ROLE_OPERATOR]))) {
    redirect(`/${slug}/admin`);
  }
  const view = await readStorage(tenantRef.id);
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-xl font-bold">Storage</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Where files live: what people attach to chats and projects, and what the assistant&apos;s
        tools produce. Azure Blob Storage today; the account key is sealed with the deployment key
        and never shown again after saving. Without storage, uploads are off and the assistant is
        told not to produce files.
      </p>
      <StorageForm slug={slug} initial={view === 'ERROR' ? null : view} />
    </div>
  );
}
