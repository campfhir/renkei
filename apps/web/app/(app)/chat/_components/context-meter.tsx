'use client';

/**
 * How full the conversation's context is, as a small ring next to the model
 * picker: tokens the next request will carry (the server's estimate, which
 * drops after a compaction) against the selected model's context window.
 * Without a recorded window there is nothing to measure against, so nothing
 * shows. The exact counts are in the tooltip. What it shows is
 * context-meter.model.ts, tested in node.
 */

import type { ModelOption } from '@/lib/chat/views';
import { meterView, type MeterTone } from './context-meter.model';

const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const TONE: Record<MeterTone, string> = {
  normal: 'text-blue-500',
  warning: 'text-amber-500',
  full: 'text-red-500',
};

export default function ContextMeter({
  tokens,
  model,
}: {
  tokens: number | null;
  model: ModelOption | null;
}) {
  const view = meterView(tokens, model?.contextWindow ?? null);
  if (!view) return null;
  const { fraction, percent, title } = view;

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
          className={TONE[view.tone]}
        />
      </svg>
    </div>
  );
}
