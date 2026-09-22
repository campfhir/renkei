'use client';

import React, { useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import CoachTarget from '@/components/coach-marks/anchor';
import { Icon, ICONS } from '@/components/icons';
import { Spinner, SkeletonCards } from '@/components/skeleton';

/**
 * The "Show archived"/"Hide archived" toggle, the pager beneath the feed,
 * and the region both of them control.
 *
 * Either one can widen or shift the query behind the feed — archived
 * brings in a tenant's whole history, a page turn moves the window through
 * it — so both can take a moment. A plain `<Link>` gave no sign that a
 * click had registered: the old cards sat there, unchanged, until the new
 * page arrived all at once. Driving every navigation here through one
 * shared transition instead surfaces that wait — a spinner on whichever
 * control was pressed, and a skeleton standing in for the feed — instead
 * of a page that looks like it ignored the click.
 *
 * Every href stays real (plain left-click intercepted, everything else —
 * a modifier click, a middle click, "copy link" — left to the browser).
 */
export default function ActionableFeed({
  slug,
  showArchived,
  page,
  hasMore,
  children,
}: {
  slug: string;
  showArchived: boolean;
  /** 1-based — the page this render's `children` came from. */
  page: number;
  /** Whether the query found a page past this one. */
  hasMore: boolean;
  children: React.ReactNode;
}): React.ReactNode {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function hrefFor(targetPage: number, archived: boolean): string {
    const params = new URLSearchParams();
    if (archived) params.set('archived', '1');
    if (targetPage > 1) params.set('page', String(targetPage));
    const query = params.toString();
    return query ? `/${slug}?${query}` : `/${slug}`;
  }

  function navigate(href: string): void {
    startTransition(() => {
      router.push(href);
    });
  }

  function handleClick(href: string) {
    return (event: React.MouseEvent<HTMLAnchorElement>): void => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      navigate(href);
    };
  }

  const toggleHref = hrefFor(1, !showArchived);
  const prevHref = page > 1 ? hrefFor(page - 1, showArchived) : null;
  const nextHref = hasMore ? hrefFor(page + 1, showArchived) : null;

  return (
    <>
      <CoachTarget name="home-feed" className="mb-1 flex items-baseline justify-between gap-4">
        <h1 className="text-xl font-bold">Actionable items</h1>
        <Link
          href={toggleHref}
          onClick={handleClick(toggleHref)}
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
      <div aria-busy={pending}>
        {pending ? <SkeletonCards count={3} lines={2} chips={2} /> : children}
      </div>
      {(prevHref || nextHref) && (
        <div className="mt-4 flex items-center justify-between gap-2">
          {prevHref ? (
            <Link
              href={prevHref}
              onClick={handleClick(prevHref)}
              aria-disabled={pending}
              className="flex items-center gap-1 rounded-md border border-gray-300 px-2.5 py-1.5 text-xs text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-900"
            >
              <Icon path={ICONS.chevronLeft} className="h-3.5 w-3.5" />
              Prev
            </Link>
          ) : (
            <span />
          )}
          <span className="text-xs text-gray-500 dark:text-gray-400">Page {page}</span>
          {nextHref ? (
            <Link
              href={nextHref}
              onClick={handleClick(nextHref)}
              aria-disabled={pending}
              className="flex items-center gap-1 rounded-md border border-gray-300 px-2.5 py-1.5 text-xs text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-900"
            >
              Next
              <Icon path={ICONS.chevron} className="h-3.5 w-3.5" />
            </Link>
          ) : (
            <span />
          )}
        </div>
      )}
    </>
  );
}
