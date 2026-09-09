/**
 * One token figure the way every card shows it: the number, its label,
 * and the cached part beside it when there is one — "12,400 in · 3,100
 * cached". Cached prompt tokens are a PORTION of the input (see LlmUsage:
 * input is every prompt token the model read, cache-served or not) billed
 * at a fraction of the rest, so the figure says how much of the input
 * was the cheap kind.
 */

const number = (value: number) => value.toLocaleString('en-US');

export function TokenStat({
  label,
  value,
  cached,
  emphasis = false,
}: {
  label: string;
  value: number;
  /** The part of `value` served from the cache; omitted or zero shows nothing. */
  cached?: number;
  emphasis?: boolean;
}): React.ReactNode {
  return (
    <div className="min-w-0">
      <div className={`tabular-nums ${emphasis ? 'text-lg font-semibold' : 'text-sm font-medium'}`}>
        {number(value)}
      </div>
      <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {label}
        {cached ? (
          <span className="ml-1 normal-case tracking-normal text-gray-400 dark:text-gray-500">
            · {number(cached)} cached
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** A label/value pair for the non-token stats (runs, failures) on the same grid. */
export function CountStat({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  tone?: 'neutral' | 'danger';
}): React.ReactNode {
  return (
    <div className="min-w-0">
      <div
        className={`text-sm font-medium tabular-nums ${
          tone === 'danger' && value > 0 ? 'text-red-600 dark:text-red-400' : ''
        }`}
      >
        {number(value)}
      </div>
      <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {label}
      </div>
    </div>
  );
}

/**
 * A model's tokens on one line: name on the left, in (+cached) and out
 * on the right. Shared by the org card and an agent's by-model card.
 */
export function ModelUsageRow({
  name,
  input,
  cached,
  output,
}: {
  name: string;
  input: number;
  cached: number;
  output: number;
}): React.ReactNode {
  return (
    <li className="flex items-center justify-between gap-4 py-1.5">
      <span className="min-w-0 truncate text-sm">{name}</span>
      <span className="flex shrink-0 gap-4 text-right">
        <TokenStat label="in" value={input} cached={cached} />
        <TokenStat label="out" value={output} />
      </span>
    </li>
  );
}
