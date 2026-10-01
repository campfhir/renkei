/**
 * Images over time as bars: the bytes of the pictures drawn in each hour,
 * day, week or month (whichever the period calls for — the buckets come
 * sized from bucketImageSeries), with the scale spelled out in KB/MB/GB so a
 * bar can be read, not just compared. Hovering a bar says how many pictures,
 * how much space and what the provider billed. Inline markup like the other
 * usage charts: no chart dependency. Shared by My usage and Organization
 * usage.
 */

import { formatTokens } from '@/lib/format-tokens';
import { formatBytes, type ImageBucket } from '@/lib/usage/image-window';

function tooltipOf(point: ImageBucket): string {
  if (point.images === 0) return `${point.label}: no images`;
  const tokens = point.inputTokens + point.outputTokens;
  return [
    `${point.label}: ${formatBytes(point.bytes)}`,
    `${point.images.toLocaleString('en-US')} ${point.images === 1 ? 'image' : 'images'}`,
    tokens > 0
      ? `${formatTokens(point.inputTokens)} tokens in, ${formatTokens(point.outputTokens)} out`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function ImageUsageChart({ points }: { points: ImageBucket[] }) {
  const peak = Math.max(0, ...points.map((point) => point.bytes));
  if (points.length === 0 || peak === 0) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">Nothing in this period.</p>;
  }
  const total = points.reduce((sum, point) => sum + point.bytes, 0);
  return (
    <div data-testid="image-usage-chart">
      <div className="mb-1 flex justify-between text-xs text-gray-500 dark:text-gray-400">
        <span data-testid="image-usage-peak">Peak {formatBytes(peak)}</span>
        <span data-testid="image-usage-total">{formatBytes(total)} in all</span>
      </div>
      <div
        className="flex h-40 items-end gap-px border-b border-gray-200 dark:border-gray-800"
        role="img"
        aria-label={`Size of the images drawn over time, peaking at ${formatBytes(peak)}`}
      >
        {points.map((point) => (
          <div
            key={point.bucket}
            className="relative flex-1"
            style={{ height: '100%' }}
            title={tooltipOf(point)}
            data-testid="image-usage-bar"
            data-bytes={point.bytes}
            data-images={point.images}
          >
            <div
              className="absolute inset-x-0 bottom-0 rounded-t-sm bg-violet-500"
              style={{ height: `${(point.bytes / peak) * 100}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-xs text-gray-500">
        <span>{points[0]?.label}</span>
        <span>{points[points.length - 1]?.label}</span>
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
        <span className="inline-block h-2.5 w-2.5 rounded-sm bg-violet-500" />
        Image files kept
      </div>
    </div>
  );
}
