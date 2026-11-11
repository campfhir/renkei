import { formatReset, formatTokens, limitProgress } from '@/lib/token-limits/format';
import type { OwnTokenLimits } from '@/lib/token-limits/own';

function Meter({
  title,
  of,
  used,
  limit,
  boost = 0,
  resetsAt,
}: {
  title: string;
  /** The model this meter is for, said to a screen reader; the person's overall limit without it. */
  of?: string;
  used: number;
  limit: number | null;
  boost?: number;
  resetsAt: string;
}) {
  const progress = limitProgress(used, limit, boost);
  const tone = progress.reached ? 'bg-red-500' : progress.near ? 'bg-amber-500' : 'bg-blue-600';
  return (
    <div className="min-w-0" data-limit-meter={title}>
      <p className="flex flex-wrap items-baseline justify-between gap-x-2 text-sm">
        <span className="font-medium">{title}</span>
        <span className="tabular-nums text-gray-600 dark:text-gray-400">{progress.label}</span>
      </p>
      {progress.limit !== null && (
        <div
          role="progressbar"
          aria-label={`${of ? `${of}, ` : ''}${title.toLowerCase()} token limit`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress.percent}
          className="mt-1 h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800"
        >
          <div
            className={`h-full rounded-full ${tone}`}
            style={{ width: `${progress.percent}%` }}
          />
        </div>
      )}
      <p className="mt-1 text-xs text-gray-500">
        {progress.limit === null
          ? 'No limit'
          : progress.reached
            ? `Limit reached — resets ${formatReset(resetsAt)}`
            : `Resets ${formatReset(resetsAt)}`}
        {boost > 0 && progress.limit !== null ? ` · includes a ${formatTokens(boost)} boost` : ''}
      </p>
    </div>
  );
}

/**
 * Where the person stands against the organization's token limits: this
 * week, this month, and each model that carries a limit of its own. The
 * numbers are since each period began, whatever period the page charts.
 */
export default function TokenLimitsCard({ limits }: { limits: OwnTokenLimits }) {
  return (
    <section
      aria-label="Token limits"
      className="rounded-lg border border-gray-200 p-4 dark:border-gray-800"
    >
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium text-gray-700 dark:text-gray-300">Your token limits</h2>
        {limits.exempt && (
          <span className="rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-800 dark:bg-green-900/40 dark:text-green-300">
            Unlimited
          </span>
        )}
      </div>
      {limits.exempt ? (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          No token limit applies to you. You have used {formatTokens(limits.week.used)} this week
          and {formatTokens(limits.month.used)} this month, your agents included.
        </p>
      ) : (
        <>
          {limits.stopped && (
            <p
              role="status"
              className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-300"
            >
              You have reached a token limit. New chat turns and agent runs wait until it resets; an
              operator can grant a boost.
            </p>
          )}
          <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
            <Meter
              title="This week"
              used={limits.week.used}
              limit={limits.week.limit}
              boost={limits.week.boost}
              resetsAt={limits.week.resetsAt}
            />
            <Meter
              title="This month"
              used={limits.month.used}
              limit={limits.month.limit}
              boost={limits.month.boost}
              resetsAt={limits.month.resetsAt}
            />
          </div>
          {limits.models.length > 0 && (
            <div className="mt-4 border-t border-gray-200 pt-3 dark:border-gray-800">
              <p className="mb-2 text-xs uppercase tracking-wide text-gray-500">
                Models with their own limit
              </p>
              <ul className="space-y-3">
                {limits.models.map((model) => (
                  <li key={model.id} data-limit-model={model.label}>
                    <p className="mb-1 text-sm font-medium">{model.label}</p>
                    <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
                      {model.week.limit !== null && (
                        <Meter
                          title="This week"
                          of={model.label}
                          used={model.week.used}
                          limit={model.week.limit}
                          resetsAt={limits.week.resetsAt}
                        />
                      )}
                      {model.month.limit !== null && (
                        <Meter
                          title="This month"
                          of={model.label}
                          used={model.month.used}
                          limit={model.month.limit}
                          resetsAt={limits.month.resetsAt}
                        />
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="mt-3 text-xs text-gray-500">
            Counts your chats and your agents together, input and output tokens. A turn or run
            already going always finishes.
          </p>
        </>
      )}
    </section>
  );
}
