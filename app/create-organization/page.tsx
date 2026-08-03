'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

function CreateOrganizationContent() {
  const searchParams = useSearchParams();
  const domain = searchParams.get('domain') || '';

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-50 dark:bg-black px-4">
      <main style={{ maxWidth: '30rem' }} className="w-full">
        <Link
          href="/"
          className="text-blue-600 hover:text-blue-700 dark:text-blue-400 text-sm mb-6 inline-block"
        >
          ← Back to sign in
        </Link>

        <h1 className="text-3xl font-bold mb-2">Create your organization</h1>
        <p className="text-gray-600 dark:text-gray-400 mb-6">
          {domain
            ? `Create a new organization for ${domain}.`
            : 'To create a new organization, you can contact your system administrator.'}
        </p>

        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 mb-6">
          <h2 className="font-semibold text-blue-900 dark:text-blue-100 mb-2">How it works</h2>
          <ol className="list-decimal list-inside space-y-2 text-sm text-blue-800 dark:text-blue-200">
            <li>Sign in with your work email</li>
            <li>An admin will add your organization</li>
            <li>You'll have access to your Jira work items</li>
          </ol>
        </div>

        <p className="text-sm text-gray-600 dark:text-gray-400">
          Questions? Contact your organization administrator for more information.
        </p>

        <p className="text-center text-sm text-gray-500 dark:text-gray-500 mt-12">
          Renkei — Jira work item gateway
        </p>
      </main>
    </div>
  );
}

export default function CreateOrganization() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <CreateOrganizationContent />
    </Suspense>
  );
}
