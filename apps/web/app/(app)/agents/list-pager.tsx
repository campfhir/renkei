import React from 'react';
import Link from 'next/link';

/**
 * Previous / range / Next under a paged list. Renders nothing when there is
 * only one page. `keepScroll` keeps the reader where they are (a pager
 * mid-page whose list stays put); otherwise the link's own hash or the top
 * of the page is where it lands.
 */
export default function ListPager({
  label,
  range,
  previousHref,
  nextHref,
  keepScroll = false,
}: {
  /** The nav's accessible name, e.g. "In flight pages". */
  label: string;
  range: string | null;
  previousHref: string | null;
  nextHref: string | null;
  keepScroll?: boolean;
}): React.ReactNode {
  if (!previousHref && !nextHref) return null;
  const button =
    'rounded-md border border-gray-300 px-3 py-1.5 hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900';
  return (
    <nav aria-label={label} className="mt-2 flex items-center justify-between gap-2 text-sm">
      {previousHref ? (
        <Link href={previousHref} scroll={!keepScroll} className={button}>
          ← Previous
        </Link>
      ) : (
        <span />
      )}
      <span className="text-xs text-gray-500 dark:text-gray-400">{range}</span>
      {nextHref ? (
        <Link href={nextHref} scroll={!keepScroll} className={button}>
          Next →
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}
