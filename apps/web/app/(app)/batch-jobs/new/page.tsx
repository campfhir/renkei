import React from 'react';
import BackLink from '@/components/back-link';
import { redirect, notFound } from 'next/navigation';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import NewBatchJobForm from './new-batch-job-form';

export default async function NewBatchJobPage(): Promise<React.ReactNode> {
  const session = await getSessionFromCookies();
  if (!session) {
    redirect(signInUrl(`/batch-jobs/new`));
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-center gap-2">
        <BackLink href={`/batch-jobs`} label="Batch Jobs" />
        <h1 className="text-xl font-bold">New batch job</h1>
      </div>
      <NewBatchJobForm />
    </div>
  );
}
