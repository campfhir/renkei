import React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { readTokenLimitAdminView } from '@/lib/token-limits/admin';
import { TokenLimitsForm } from './token-limits-form';

/**
 * Token limits: how many tokens one person may spend in a week and in a
 * month (their agents' runs included), when the week resets, limits on
 * single models, and what an operator decides about one person — exempt
 * them, or grant a boost for the period in progress.
 */
export default async function TokenLimitsPage(): Promise<React.ReactNode> {
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    redirect(`/admin`);
  }
  const view = await readTokenLimitAdminView();
  if (!view) {
    return (
      <div>
        <h2 className="mb-2 text-lg font-semibold">Error</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">Could not read the token limits.</p>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-1 text-xl font-bold">Token limits</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        The most tokens one person may spend, counting their chats and their agents together. At a
        limit, no new chat turn or agent run starts for them until it resets; whatever is already
        running finishes. Changes take effect within a minute and are recorded in the{' '}
        <Link href={`/admin/audit`} className="text-blue-600 hover:underline dark:text-blue-400">
          audit trail
        </Link>
        .
      </p>
      <TokenLimitsForm initial={view} />
    </div>
  );
}
