import React from 'react';
import { redirect } from 'next/navigation';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import TargetsPage from './targets-page';

/**
 * The organization's CI targets (lib/ci/targets.ts): where deploy blocks
 * run — groups of self-hosted runners, read from Bitbucket and GitHub with
 * the organization's service accounts. Operators only.
 */
export default async function AdminCiTargetsPage(): Promise<React.ReactNode> {
  if (!(await checkAccess([ROLE_OPERATOR]))) redirect('/admin');
  return (
    <div className="max-w-5xl">
      <h1 className="mb-1 text-xl font-bold">Targets</h1>
      <p className="mb-6 max-w-3xl text-sm text-gray-600 dark:text-gray-400">
        Where deploy blocks run. Runners are read from your Bitbucket workspace and GitHub
        organization through a service account, so a pipeline names a target and the right runner
        labels follow for each host.
      </p>
      <TargetsPage />
    </div>
  );
}
