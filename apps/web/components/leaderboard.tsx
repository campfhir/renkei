/**
 * A ranked list with a bar proportional to the leader — the shared shape
 * behind every "top N" card across the usage surfaces (org-wide top
 * users/agents/tools, and a person's own "most efficient agents").
 *
 * A row can carry an explicit rank (`rankOf`), be singled out
 * (`highlightOf`), or sit after a gap (`gapBefore`) — the three together
 * are how the org page shows the top five people and then, below an
 * ellipsis, the one selected person at "#9" without listing six through
 * eight.
 */

export function Leaderboard<Row>({
  heading,
  hint,
  rows,
  empty,
  keyOf,
  labelOf,
  valueOf,
  formatValue,
  barClassName = 'bg-blue-500',
  rankOf,
  highlightOf,
  gapBefore,
}: {
  heading: string;
  hint: string;
  rows: Row[];
  empty: string;
  keyOf: (row: Row) => string;
  labelOf: (row: Row) => React.ReactNode;
  valueOf: (row: Row) => number;
  formatValue: (row: Row) => string;
  barClassName?: string;
  /** Shown before the label as "#n"; omit for an unnumbered list. */
  rankOf?: (row: Row) => number;
  /** The row to set apart — tinted, with a bolder label. */
  highlightOf?: (row: Row) => boolean;
  /** An ellipsis rendered above this row, for a rank that skips ahead. */
  gapBefore?: (row: Row) => boolean;
}) {
  const largest = rows.reduce((max, row) => Math.max(max, valueOf(row)), 0);
  return (
    <section className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
      <h2 className="text-sm font-semibold">{heading}</h2>
      <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">{hint}</p>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{empty}</p>
      ) : (
        <ol className="space-y-2">
          {rows.map((row) => {
            const highlighted = highlightOf?.(row) ?? false;
            return (
              <li
                key={keyOf(row)}
                className={
                  highlighted
                    ? '-mx-2 rounded-md bg-blue-50 px-2 py-1 dark:bg-blue-900/30'
                    : undefined
                }
                aria-current={highlighted ? 'true' : undefined}
              >
                {gapBefore?.(row) && (
                  <div
                    className="mb-2 text-center text-xs leading-none tracking-widest text-gray-400"
                    aria-label="Ranks in between not shown"
                  >
                    ···
                  </div>
                )}
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className={`min-w-0 truncate ${highlighted ? 'font-medium' : ''}`}>
                    {rankOf && (
                      <span className="mr-1.5 tabular-nums text-gray-400 dark:text-gray-500">
                        #{rankOf(row)}
                      </span>
                    )}
                    {labelOf(row)}
                  </span>
                  <span className="shrink-0 tabular-nums text-gray-600 dark:text-gray-400">
                    {formatValue(row)}
                  </span>
                </div>
                <div
                  className="mt-1 h-1 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800"
                  aria-hidden="true"
                >
                  <div
                    className={`h-full rounded-full ${barClassName}`}
                    style={{ width: `${largest > 0 ? (valueOf(row) / largest) * 100 : 0}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
