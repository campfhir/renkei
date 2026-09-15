/**
 * Placeholder shapes for content that has not arrived yet.
 *
 * Two families, for two different waits:
 *
 *   - A **skeleton** stands in for a known shape — a table, a list of
 *     cards, a heading — while the real thing streams in. It is what every
 *     `loading.tsx` renders, and what a panel that fetches on mount shows
 *     in place of its list. The eye reads the layout before the data, so
 *     the page never seems to jump when the content lands.
 *   - A **spinner** marks an action in flight where there is no shape to
 *     promise — a button that was just pressed, a search running. Small,
 *     inline, next to the words that say what is happening.
 *
 * Every shape here is a Server Component-safe plain element (no hooks), so
 * a `loading.tsx` stays a static, prefetchable fallback. Motion is paused
 * under `prefers-reduced-motion` via Tailwind's `motion-reduce:` variant.
 *
 * Accessibility: a skeleton is decorative. Wrap a whole loading region in
 * `<LoadingRegion>` once — it carries the one `role="status"` announcement
 * ("Loading…") a screen reader wants, and hides the grey boxes inside it,
 * which would otherwise be an unreadable pile of empty elements.
 */

import type { ReactNode } from 'react';

/** The grey a placeholder is drawn in, light and dark. */
const BONE = 'animate-pulse motion-reduce:animate-none rounded bg-gray-200 dark:bg-gray-800';

/**
 * One grey block. Size and shape come from `className` (`h-4 w-32`,
 * `h-10 w-10 rounded-full`) so a skeleton reads like the markup it stands
 * in for; the default is a text-line's height and full width.
 */
export function Skeleton({ className = 'h-4 w-full' }: { className?: string }): ReactNode {
  return <div aria-hidden="true" className={`${BONE} ${className}`} />;
}

/**
 * A paragraph: `lines` grey lines, the last one shorter, the way real
 * text ends mid-line. Widths cycle so two paragraphs side by side do not
 * look stamped from the same die.
 */
export function SkeletonText({
  lines = 3,
  className = '',
}: {
  lines?: number;
  className?: string;
}): ReactNode {
  const widths = ['w-full', 'w-11/12', 'w-full', 'w-10/12'];
  return (
    <div aria-hidden="true" className={`space-y-2 ${className}`}>
      {Array.from({ length: lines }, (_, index) => (
        <div
          key={index}
          className={`${BONE} h-3.5 ${index === lines - 1 ? 'w-2/3' : widths[index % widths.length]}`}
        />
      ))}
    </div>
  );
}

/**
 * The title row every page opens with: an `h1`-sized bar, an optional
 * subtitle line under it, and — when the real page puts buttons on the
 * right — a button-sized block or two opposite. Matches the pages' own
 * `mb-6 flex items-start justify-between` header so the swap is invisible.
 */
export function SkeletonHeading({
  subtitle = true,
  actions = 0,
  back = false,
  className = 'mb-6',
}: {
  /** A one-line description under the title, as most pages carry. */
  subtitle?: boolean;
  /** How many button-shaped blocks sit at the right edge. */
  actions?: number;
  /** A chevron-sized square before the title (pages using BackLink). */
  back?: boolean;
  className?: string;
}): ReactNode {
  return (
    <div aria-hidden="true" className={`flex items-start justify-between gap-4 ${className}`}>
      <div className="flex min-w-0 items-center gap-2">
        {back ? <div className={`${BONE} h-7 w-7 shrink-0`} /> : null}
        <div className="min-w-0">
          <div className={`${BONE} h-7 w-48 max-w-full`} />
          {subtitle ? <div className={`${BONE} mt-2 h-3.5 w-72 max-w-full`} /> : null}
        </div>
      </div>
      {actions > 0 ? (
        <div className="flex shrink-0 gap-2">
          {Array.from({ length: actions }, (_, index) => (
            <div key={index} className={`${BONE} h-9 w-24 rounded-lg`} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A table: a header row of column labels, then `rows` body rows separated
 * by the same hairline the real tables use. Column widths are staggered so
 * it reads as data and not as a grid of equal blocks.
 */
export function SkeletonTable({
  rows = 6,
  columns = 4,
  className = '',
}: {
  rows?: number;
  columns?: number;
  className?: string;
}): ReactNode {
  const widths = ['w-2/3', 'w-1/2', 'w-3/4', 'w-1/3', 'w-1/2'];
  return (
    <div aria-hidden="true" className={`overflow-hidden ${className}`}>
      <div className="flex gap-4 border-b border-gray-200 pb-2 dark:border-gray-800">
        {Array.from({ length: columns }, (_, column) => (
          <div key={column} className="flex-1">
            <div className={`${BONE} h-3 w-16`} />
          </div>
        ))}
      </div>
      {Array.from({ length: rows }, (_, row) => (
        <div
          key={row}
          className="flex gap-4 border-b border-gray-100 py-3 last:border-b-0 dark:border-gray-800/60"
        >
          {Array.from({ length: columns }, (_, column) => (
            <div key={column} className="flex-1">
              <div className={`${BONE} h-3.5 ${widths[(row + column) % widths.length]}`} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * The card most list pages are built from: `rounded-lg border … p-4`,
 * with a title line, a line or two of description, and a short row of
 * chips at the bottom — the agents list, the connectors, the batch jobs.
 */
export function SkeletonCard({
  lines = 2,
  chips = 2,
  className = '',
}: {
  lines?: number;
  chips?: number;
  className?: string;
}): ReactNode {
  return (
    <div
      aria-hidden="true"
      className={`rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950 ${className}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className={`${BONE} h-5 w-40 max-w-[60%]`} />
        <div className={`${BONE} h-5 w-16 rounded-full`} />
      </div>
      {lines > 0 ? <SkeletonText lines={lines} className="mt-3" /> : null}
      {chips > 0 ? (
        <div className="mt-4 flex gap-2">
          {Array.from({ length: chips }, (_, index) => (
            <div key={index} className={`${BONE} h-5 w-20 rounded-full`} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A stack of cards, the way a list page shows them. */
export function SkeletonCards({
  count = 3,
  lines,
  chips,
  className = 'space-y-3',
}: {
  count?: number;
  lines?: number;
  chips?: number;
  className?: string;
}): ReactNode {
  return (
    <div aria-hidden="true" className={className}>
      {Array.from({ length: count }, (_, index) => (
        <SkeletonCard key={index} lines={lines} chips={chips} />
      ))}
    </div>
  );
}

/**
 * A short list of people or notes — the "who has access" panels and the
 * knowledge notes: a line of text per row, no card around it, so it sits
 * inside whatever box the real list will.
 */
export function SkeletonList({
  rows = 3,
  className = 'space-y-2.5',
}: {
  rows?: number;
  className?: string;
}): ReactNode {
  const widths = ['w-2/3', 'w-1/2', 'w-3/5', 'w-2/5'];
  return (
    <div aria-hidden="true" className={className}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-3">
          <div className={`${BONE} h-3.5 flex-none ${widths[index % widths.length]}`} />
          <div className={`${BONE} ml-auto h-3 w-12`} />
        </div>
      ))}
    </div>
  );
}

/**
 * A list of rows — a run, a batch job, a schedule, a notification: a
 * status pill, a line of text, and a time at the right edge. By default
 * each row is its own `rounded-md border … p-3` card, as the runs and
 * batch lists draw them; `divided` puts them in one bordered box with
 * hairlines between, as the admin lists and the chat indexes do.
 */
export function SkeletonRows({
  count = 5,
  divided = false,
  pill = true,
  className = '',
}: {
  count?: number;
  divided?: boolean;
  /** A pill-shaped block before the text (a status, an icon slot). */
  pill?: boolean;
  className?: string;
}): ReactNode {
  const widths = ['w-1/2', 'w-1/3', 'w-2/5', 'w-3/5', 'w-1/4'];
  const rows = Array.from({ length: count }, (_, index) => (
    <div
      key={index}
      className={`flex items-center gap-3 ${
        divided ? 'px-3 py-2.5' : 'rounded-md border border-gray-200 p-3 dark:border-gray-800'
      }`}
    >
      {pill ? <div className={`${BONE} h-5 w-16 shrink-0 rounded-full`} /> : null}
      <div className={`${BONE} h-3.5 ${widths[index % widths.length]}`} />
      <div className={`${BONE} ml-auto h-3 w-16 shrink-0`} />
    </div>
  ));
  return divided ? (
    <div
      aria-hidden="true"
      className={`divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white dark:divide-gray-900 dark:border-gray-800 dark:bg-gray-950 ${className}`}
    >
      {rows}
    </div>
  ) : (
    <div aria-hidden="true" className={`space-y-2 ${className}`}>
      {rows}
    </div>
  );
}

/** A row of filter pills — the status tabs above the runs and batch lists. */
export function SkeletonPills({
  count = 4,
  className = 'mb-4',
}: {
  count?: number;
  className?: string;
}): ReactNode {
  return (
    <div aria-hidden="true" className={`flex flex-wrap gap-2 ${className}`}>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className={`${BONE} h-7 w-20 rounded-full`} />
      ))}
    </div>
  );
}

/**
 * The wide client viewers — Tools, My usage, Organization usage: the
 * header with its link, the period pills, four stat tiles, a chart card,
 * and a table below it.
 */
export function ViewerSkeleton({ label = 'Loading…' }: { label?: string }): ReactNode {
  return (
    <LoadingRegion label={label} wide className="flex flex-col gap-5">
      <div
        aria-hidden="true"
        className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2"
      >
        <div className={`${BONE} h-7 w-40`} />
        <div className={`${BONE} h-4 w-20`} />
        <div className={`${BONE} h-3.5 w-full max-w-xl`} />
      </div>
      <div aria-hidden="true" className="flex flex-wrap items-center gap-2">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className={`${BONE} h-9 w-20 rounded-lg`} />
        ))}
      </div>
      <SkeletonStats count={4} />
      <div
        aria-hidden="true"
        className="rounded-lg border border-gray-200 p-4 dark:border-gray-800"
      >
        <div className={`${BONE} mb-3 h-4 w-32`} />
        <div className={`${BONE} h-32 w-full`} />
      </div>
      <div
        aria-hidden="true"
        className="overflow-x-auto rounded-lg border border-gray-200 p-3 dark:border-gray-800"
      >
        <SkeletonTable rows={6} columns={4} />
      </div>
    </LoadingRegion>
  );
}

/**
 * A row of stat tiles — the small label over the big figure — as the
 * usage pages and the person page open with.
 */
export function SkeletonStats({
  count = 4,
  className = '',
}: {
  count?: number;
  className?: string;
}): ReactNode {
  return (
    <div
      aria-hidden="true"
      className={`grid grid-cols-2 gap-3 ${STAT_COLUMNS[count] ?? STAT_COLUMNS[4]} ${className}`}
    >
      {Array.from({ length: count }, (_, index) => (
        <div
          key={index}
          className="rounded-lg border border-gray-200 px-4 py-3 dark:border-gray-800"
        >
          <div className={`${BONE} h-3 w-20`} />
          <div className={`${BONE} mt-2 h-8 w-16`} />
        </div>
      ))}
    </div>
  );
}

// Spelled out for the same reason as SPINNER_SIZES below.
const STAT_COLUMNS: Record<number, string> = {
  1: 'sm:grid-cols-1',
  2: 'sm:grid-cols-2',
  3: 'sm:grid-cols-3',
  4: 'sm:grid-cols-4',
  5: 'sm:grid-cols-5',
  6: 'sm:grid-cols-3 lg:grid-cols-6',
};

/**
 * A form: `fields` label-and-input pairs and a button at the foot, for
 * the settings and connector pages that load their current values before
 * they can show anything.
 */
export function SkeletonForm({
  fields = 4,
  className = '',
}: {
  fields?: number;
  className?: string;
}): ReactNode {
  return (
    <div aria-hidden="true" className={`space-y-4 ${className}`}>
      {Array.from({ length: fields }, (_, index) => (
        <div key={index}>
          <div className={`${BONE} h-3.5 w-28`} />
          <div className={`${BONE} mt-1.5 h-9 w-full rounded-md`} />
        </div>
      ))}
      <div className={`${BONE} h-9 w-28 rounded-md`} />
    </div>
  );
}

/**
 * The one announcement a loading area makes. Screen readers hear
 * "Loading…" (or `label`) once; the grey shapes inside are hidden from
 * them. `aria-busy` tells assistive tech the region is about to change.
 *
 * Renders a `div` by default; pass `as="section"` or similar when the
 * skeleton stands in for a landmark.
 */
export function LoadingRegion({
  label = 'Loading…',
  className,
  wide = false,
  children,
}: {
  label?: string;
  className?: string;
  /** Asks the layout for the wide column (`data-wide-page`), as the viewers do. */
  wide?: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={className}
      data-wide-page={wide ? '' : undefined}
    >
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/**
 * A whole page in the shared reading column, for a `loading.tsx`: the
 * `mx-auto max-w-3xl` block every page centres itself in, the title row,
 * and whatever body shape the page has. `width` follows the page's own
 * max-width class so the column does not jump when the content lands.
 */
export function PageSkeleton({
  label = 'Loading…',
  width = '3xl',
  back = false,
  actions = 0,
  subtitle = true,
  children,
}: {
  label?: string;
  width?: 'lg' | '3xl' | '4xl' | '5xl' | 'full';
  back?: boolean;
  actions?: number;
  subtitle?: boolean;
  children?: ReactNode;
}): ReactNode {
  return (
    <LoadingRegion label={label} className={`mx-auto ${PAGE_WIDTHS[width]}`}>
      <SkeletonHeading back={back} actions={actions} subtitle={subtitle} />
      {children}
    </LoadingRegion>
  );
}

const PAGE_WIDTHS = {
  lg: 'max-w-lg',
  '3xl': 'max-w-3xl',
  '4xl': 'max-w-4xl',
  '5xl': 'max-w-5xl',
  full: 'w-full',
} as const;

/**
 * The inline spinner for an action in flight — the ring the agents list
 * already drew for "Writing a summary…", now in one place. Sits beside a
 * word ("Saving…", "Searching…") rather than replacing it: a ring alone
 * says something is happening but never what.
 *
 * `size` is the Tailwind height/width step: 3.5 (14px, inline with small
 * text) by default, 4 or 5 for a standalone indicator.
 */
export function Spinner({
  className = '',
  size = 3.5,
  label,
}: {
  className?: string;
  size?: 3 | 3.5 | 4 | 5 | 6 | 8;
  /** Announced to screen readers; omit when the surrounding text already says it. */
  label?: string;
}): ReactNode {
  const dimension = SPINNER_SIZES[size] ?? SPINNER_SIZES[3.5];
  return (
    <span
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : 'true'}
      className={`inline-block shrink-0 animate-spin rounded-full border-2 border-gray-300 border-t-blue-600 dark:border-gray-700 dark:border-t-blue-400 ${dimension} ${className}`}
    />
  );
}

// Tailwind only emits classes it can see spelled out, so the sizes are a
// table rather than a template string.
const SPINNER_SIZES = {
  3: 'h-3 w-3',
  3.5: 'h-3.5 w-3.5',
  4: 'h-4 w-4',
  5: 'h-5 w-5',
  6: 'h-6 w-6',
  8: 'h-8 w-8',
} as const;

/**
 * A spinner with its words, centred in whatever box it is given: the
 * placeholder for a panel that is fetching and has no shape worth
 * sketching (a picker's options, a popover's list).
 */
export function LoadingLine({
  label = 'Loading…',
  className = '',
  size = 'sm',
}: {
  label?: string;
  className?: string;
  size?: 'xs' | 'sm';
}): ReactNode {
  return (
    <p
      role="status"
      aria-live="polite"
      className={`flex items-center gap-2 text-gray-500 dark:text-gray-400 ${size === 'xs' ? 'text-xs' : 'text-sm'} ${className}`}
    >
      <Spinner size={size === 'xs' ? 3 : 3.5} />
      {label}
    </p>
  );
}
