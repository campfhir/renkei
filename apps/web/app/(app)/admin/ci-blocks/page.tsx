import React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import BlocksList from './blocks-list';

/**
 * The organization's CI building blocks (lib/ci/blocks.ts): the steps code
 * projects build pipelines from, each written once and rendered for
 * Bitbucket Pipelines or GitHub Actions. Operators only.
 */
export default async function AdminCiBlocksPage(): Promise<React.ReactNode> {
  if (!(await checkAccess([ROLE_OPERATOR]))) redirect('/admin');
  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-[1_1_420px]">
          <h1 className="mb-1 text-xl font-bold">Building blocks</h1>
          <p className="max-w-2xl text-sm text-gray-600 dark:text-gray-400">
            The steps your organization builds pipelines from. Each block is written once and works
            on Bitbucket Pipelines and GitHub Actions; code projects assemble them, and the agent
            uses the same catalogue.
          </p>
        </div>
        <Link
          href="/admin/ci-blocks/new?draft=ai"
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
        >
          Draft a block with AI
        </Link>
        <Link
          href="/admin/ci-blocks/new"
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          New block
        </Link>
      </div>
      <BlocksList />
    </div>
  );
}
