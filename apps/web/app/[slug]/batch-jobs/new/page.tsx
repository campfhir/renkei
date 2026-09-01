import React from 'react';
import BackLink from '@/components/back-link';
import { redirect, notFound } from 'next/navigation';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import NewBatchJobForm from './new-batch-job-form';

export default async function NewBatchJobPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactNode> {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();

  const session = await getSessionFromCookies(tenant.id);
  if (!session) {
    redirect(signInUrl(tenant.id, `/${slug}/batch-jobs/new`));
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-center gap-2">
        <BackLink href={`/${slug}/batch-jobs`} label="Batch Jobs" />
        <h1 className="text-xl font-bold">New batch job</h1>
      </div>
      <NewBatchJobForm slug={slug} tenantId={tenant.id} />
    </div>
  );
}
