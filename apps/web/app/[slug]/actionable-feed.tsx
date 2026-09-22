'use client';

import React, { useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import CoachTarget from '@/components/coach-marks/anchor';
import { Spinner, SkeletonCards } from '@/components/skeleton';

/**
 * The "Show archived"/"Hide archived" toggle and the region it controls.
 *
 * Toggling widens the feed query to the tenant's full history — no longer
 * just the handful of unarchived rows, but everything that has ever
 * accumulated — so it can take a moment. A plain `<Link>` gave no sign
 * that the click had registered: the old cards sat there, unchanged,
 * until the new page arrived all at once. Driving the navigation through
 * our own transition instead surfaces that wait — a spinner on the
 * control itself, and a skeleton standing in for the feed — instead of a
 * page that looks like it ignored the click.
 *
 * The href stays real (plain left-click intercepted, everything else —
 * a modifier click, a middle click, "copy link" — left to the browser).
 */
export default function ActionableFeed({
  slug,
  showArchived,
  children,
}: {
  slug: string;
  showArchived: boolean;
  children: React.ReactNode;
}): React.ReactNode {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const href = showArchived ? `/${slug}` : `/${slug}?archived=1`;

  function handleClick(event: React.MouseEvent<HTMLAnchorElement>): void {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    startTransition(() => {
      router.push(href);
    });
  }

  return (
    <>
      <CoachTarget name="home-feed" className="mb-1 flex items-baseline justify-between gap-4">
        <h1 className="text-xl font-bold">Actionable items</h1>
        <Link
          href={href}
          onClick={handleClick}
          aria-disabled={pending}
          className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
        >
          {pending && <Spinner size={3} />}
          {showArchived ? 'Hide archived' : 'Show archived'}
        </Link>
      </CoachTarget>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        {showArchived
          ? 'The full history, archived cards included.'
          : 'Suggestions from your connected tools. Approving executes the action as you.'}
      </p>
      <div aria-busy={pending}>{pending ? <SkeletonCards count={3} lines={2} chips={2} /> : children}</div>
    </>
  );
}
