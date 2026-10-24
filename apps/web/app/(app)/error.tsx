'use client';

/**
 * The error boundary under the app shell: a page that throws while it
 * renders or loads its data lands here, inside the nav, instead of on
 * Next's bare "Application error" screen. Every page's data comes from
 * somewhere that can be momentarily away (the database, the delegate, a
 * git host, the sandbox worker), so the first offer is to try again,
 * which re-fetches and re-renders the page. A server-side error arrives
 * with its message replaced by a digest; the digest is shown so the
 * person can quote it, and instrumentation.ts's onRequestError logs the
 * same digest beside the real error for whoever looks it up.
 */

import { useEffect } from 'react';
import Link from 'next/link';

function digestOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('digest' in error)) return null;
  const digest: unknown = error.digest;
  return typeof digest === 'string' && digest ? digest : null;
}

export default function AppError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const digest = digestOf(error);
  // A client-side error keeps its own words; a server-side one has only
  // the digest, its message being Next's generic stand-in.
  const message = !digest && error instanceof Error && error.message ? error.message : null;

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-16" role="alert" data-testid="app-error">
      <div className="rounded-lg border border-red-200 bg-white p-6 dark:border-red-900 dark:bg-gray-950">
        <h1 className="text-lg font-semibold">This page hit an error</h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          Something went wrong while loading it. Trying again fixes a momentary problem; if it keeps
          happening, the reference below points whoever looks into it at the cause.
        </p>
        {message ? (
          <p className="mt-3 rounded-md bg-gray-50 px-3 py-2 font-mono text-xs break-words text-gray-700 dark:bg-gray-900 dark:text-gray-300">
            {message}
          </p>
        ) : null}
        {digest ? (
          <p className="mt-3 text-xs text-gray-500">
            Reference <span className="font-mono">{digest}</span>
          </p>
        ) : null}
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => retry()}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            Try again
          </button>
          <Link
            href="/"
            className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            Go to the home page
          </Link>
        </div>
      </div>
    </div>
  );
}
