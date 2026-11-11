import React from 'react';
import Link from 'next/link';

/**
 * The frame every list-of-records table in the app draws in: a bordered
 * box whose body scrolls inside itself, with the column headings stuck to
 * its top and the pager stuck to the bottom of the viewport, and a table
 * on wide screens that turns into cards on narrow ones — the shape the
 * activity log viewer set (logs-viewer.tsx), made reusable.
 *
 * - The body is capped at the viewport's height (BODY_MAX_HEIGHT) and
 *   scrolls internally, so a long page of runs never pushes the pager off
 *   the screen; the headings stay put while it scrolls (`Th` is sticky).
 * - The footer is `sticky bottom-0`: while the frame runs past the bottom
 *   of the viewport the pager rides the bottom edge, and it settles into
 *   place once the frame is fully in view.
 * - With `cards`, the table shows from `breakpoint` up and the cards below
 *   it (cards have no headings, so on a phone there is only the footer).
 *   Without `cards`, the table shows at every width.
 *
 * Server-renderable: no state, no effects. What a row says is the caller's.
 */

export type DataTableBreakpoint = 'sm' | 'md';

// Literal class names (Tailwind reads them from source), one pair per breakpoint.
const TABLE_FROM: Record<DataTableBreakpoint, string> = {
  sm: 'hidden sm:block',
  md: 'hidden md:block',
};
const CARDS_UNTIL: Record<DataTableBreakpoint, string> = {
  sm: 'sm:hidden',
  md: 'md:hidden',
};

/** Tall enough to read, short enough that the top bar and the pager both fit. */
const BODY_MAX_HEIGHT = 'max-h-[calc(100dvh-11rem)]';

export function DataFrame({
  label,
  table,
  cards,
  empty,
  footer,
  breakpoint = 'sm',
  stickyFooter = true,
  bodyHeight = BODY_MAX_HEIGHT,
  className = '',
}: {
  /** The frame's accessible name, e.g. "Runs". */
  label: string;
  /** A `DataTable`. */
  table?: React.ReactNode;
  /** `<li>` cards for narrow screens; omit to show the table everywhere. */
  cards?: React.ReactNode;
  /** What to say when there is nothing to list (shown in place of the body). */
  empty?: React.ReactNode;
  /** Usually a `Pager`. */
  footer?: React.ReactNode;
  breakpoint?: DataTableBreakpoint;
  /**
   * Whether the footer rides the bottom edge of the viewport while the
   * frame runs past it (the default). A short, fixed-height table turns it
   * off, so its footer stays under its last row.
   */
  stickyFooter?: boolean;
  /**
   * The scrolling body's height, as Tailwind classes (literal, so they are
   * read from source). The default caps it at the viewport; a list that
   * shows a fixed few rows gives its own (`h-…`), the headings and the
   * footer staying put as the rows scroll.
   */
  bodyHeight?: string;
  className?: string;
}): React.ReactNode {
  return (
    // A labelled group, not a landmark: the page around it has its own.
    <div
      role="group"
      aria-label={label}
      className={`flex flex-col rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950 ${className}`}
    >
      <div data-table-body className={`${bodyHeight} min-h-0 overflow-auto rounded-t-lg`}>
        {empty ?? (
          <>
            {table ? <div className={cards ? TABLE_FROM[breakpoint] : ''}>{table}</div> : null}
            {cards ? (
              <ul aria-label={label} className={`${CARDS_UNTIL[breakpoint]} space-y-2 p-2`}>
                {cards}
              </ul>
            ) : null}
          </>
        )}
      </div>
      {footer ? (
        <div
          className={`${stickyFooter ? 'sticky bottom-0 z-10 ' : ''}rounded-b-lg border-t border-gray-200 bg-white/95 px-3 py-2 backdrop-blur dark:border-gray-800 dark:bg-gray-950/95`}
        >
          {footer}
        </div>
      ) : null}
    </div>
  );
}

/** The table inside a `DataFrame`: fixed layout, so the headings' widths hold on every page. */
export function DataTable({
  head,
  children,
}: {
  /** The `Th` cells of the heading row. */
  head: React.ReactNode;
  children: React.ReactNode;
}): React.ReactNode {
  return (
    <table className="w-full table-fixed text-sm">
      <thead className="text-left text-xs text-gray-500 dark:text-gray-400">
        <tr>{head}</tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

/** A column heading, stuck to the top of the frame's scrolling body. */
export function Th({
  children,
  className = '',
}: {
  children?: React.ReactNode;
  /** Width and alignment, e.g. "w-20 text-right". */
  className?: string;
}): React.ReactNode {
  return (
    <th
      scope="col"
      className={`sticky top-0 z-[1] bg-gray-50 px-3 py-2 font-medium dark:bg-gray-900 ${className}`}
    >
      {children}
    </th>
  );
}

const PAGER_BUTTON = 'rounded-md border border-gray-300 px-3 py-1.5 dark:border-gray-700';

/**
 * Previous / range / Next. Always drawn when there is a range — a single
 * page says so, with both buttons shown but switched off — so a filtered
 * list never looks unpaged. `keepScroll` keeps the reader where they are
 * (a pager whose list stays put); otherwise the link's own hash, or the top
 * of the page, is where it lands.
 */
export function Pager({
  label,
  range,
  previousHref,
  nextHref,
  previousLabel = '← Previous',
  nextLabel = 'Next →',
  keepScroll = false,
  className = '',
}: {
  /** The nav's accessible name, e.g. "Runs pages". */
  label: string;
  /** "Runs 1–45", or null when there is nothing to page. */
  range: string | null;
  previousHref: string | null;
  nextHref: string | null;
  previousLabel?: string;
  nextLabel?: string;
  keepScroll?: boolean;
  className?: string;
}): React.ReactNode {
  if (range === null) return null;
  const side = (href: string | null, text: string) =>
    href ? (
      <Link
        href={href}
        scroll={!keepScroll}
        className={`${PAGER_BUTTON} hover:bg-gray-100 dark:hover:bg-gray-900`}
      >
        {text}
      </Link>
    ) : (
      <span aria-disabled="true" className={`${PAGER_BUTTON} cursor-default opacity-40`}>
        {text}
      </span>
    );
  return (
    <nav
      aria-label={label}
      className={`flex items-center justify-between gap-2 text-sm ${className}`}
    >
      {side(previousHref, previousLabel)}
      <span className="text-xs text-gray-500 dark:text-gray-400">{range}</span>
      {side(nextHref, nextLabel)}
    </nav>
  );
}
