/**
 * What the chat's context ring (context-meter.tsx) shows: how full the
 * conversation's context is against the selected model's window, its
 * colour, and the exact counts its tooltip reads. Without a recorded
 * window, or before the server has an estimate, there is no ring at all.
 * Tested in context-meter.model.test.ts.
 */

/** A token count, short: 950, 42k, 1.5M. */
export function compact(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(tokens);
}

export type MeterTone = 'normal' | 'warning' | 'full';

export interface MeterView {
  /** 0–1: a conversation past its window shows a full ring. */
  fraction: number;
  /** Rounded, for aria-valuenow. */
  percent: number;
  tone: MeterTone;
  /** "Context: 42k of 200k tokens (21%)" */
  title: string;
}

export function meterView(tokens: number | null, contextWindow: number | null): MeterView | null {
  if (tokens === null || contextWindow === null) return null;
  const fraction = Math.min(tokens / contextWindow, 1);
  const percent = Math.round(fraction * 100);
  const tone: MeterTone = fraction >= 0.9 ? 'full' : fraction >= 0.75 ? 'warning' : 'normal';
  return {
    fraction,
    percent,
    tone,
    title: `Context: ${compact(tokens)} of ${compact(contextWindow)} tokens (${percent}%)`,
  };
}
