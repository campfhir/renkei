'use client';

/**
 * How full the conversation's context is, as a small ring next to the model
 * picker: tokens the next request will carry (the server's estimate, which
 * drops after a compaction) against the selected model's context window.
 * Without a recorded window there is nothing to measure against, so nothing
 * shows. The exact counts are in the tooltip.
 */

import type { ModelOption } from '@/lib/chat/views';

const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function compact(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(tokens);
}

export default function ContextMeter({
  tokens,
  model,
}: {
  tokens: number | null;
  model: ModelOption | null;
}) {
  const limit = model?.contextWindow ?? null;
  if (tokens === null || limit === null) return null;
  const fraction = Math.min(tokens / limit, 1);
  const percent = Math.round(fraction * 100);
  const tone =
    fraction >= 0.9 ? 'text-red-500' : fraction >= 0.75 ? 'text-amber-500' : 'text-blue-500';
  const title = `Context: ${compact(tokens)} of ${compact(limit)} tokens (${percent}%)`;

  return (
    <div
      data-testid="context-meter"
      role="progressbar"
      aria-label="Context used"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={title}
      title={title}
      className="flex h-6 w-6 shrink-0 items-center justify-center"
    >
      <svg viewBox="0 0 20 20" className="h-5 w-5 -rotate-90" aria-hidden="true">
        <circle
          cx="10"
          cy="10"
          r={RADIUS}
          fill="none"
          strokeWidth="3"
          className="stroke-gray-200 dark:stroke-gray-700"
        />
        <circle
          cx="10"
          cy="10"
          r={RADIUS}
          fill="none"
          strokeWidth="3"
          strokeLinecap="round"
          stroke="currentColor"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - fraction)}
          className={tone}
        />
      </svg>
    </div>
  );
}
