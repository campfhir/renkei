/**
 * The usage trend chart: stacked bars, one series at a time (tokens by
 * surface, agent runs, tool calls), no chart dependency. Shared by
 * Organization usage and My usage, which feed it the same buckets — the
 * only difference is whose rows were read, decided server side.
 */

import type { OrgBucket } from '@/app/(app)/admin/usage/window';
import { formatBytes } from '@/lib/usage/image-window';

export type UsageSeries = 'tokens' | 'runs' | 'tools';

export const USAGE_SERIES: { key: UsageSeries; label: string }[] = [
  { key: 'tokens', label: 'Tokens' },
  { key: 'runs', label: 'Agent runs' },
  { key: 'tools', label: 'Tool calls' },
];

const TOKEN_SEGMENTS: {
  key:
    | 'chatTokens'
    | 'chatProjectTokens'
    | 'codeProjectTokens'
    | 'agentTokens'
    | 'imageTokens'
    | 'documentTokens';
  label: string;
  className: string;
}[] = [
  { key: 'chatTokens', label: 'Chat', className: 'bg-blue-500' },
  { key: 'chatProjectTokens', label: 'Chat projects', className: 'bg-teal-500' },
  { key: 'codeProjectTokens', label: 'Code projects', className: 'bg-amber-500' },
  { key: 'agentTokens', label: 'Agents', className: 'bg-purple-500' },
  // Pink, distinct from the Agents purple; the breakdown's Images row and the leaderboard match.
  { key: 'imageTokens', label: 'Images', className: 'bg-pink-500' },
  // Summaries and picture descriptions the model wrote; green, apart from the rest.
  { key: 'documentTokens', label: 'Documents', className: 'bg-emerald-500' },
];

interface Segment {
  label: string;
  value: number;
  className: string;
  /** Said beside the figure in the tooltip — for images, how many and how big. */
  detail?: string;
}

function legendFor(series: UsageSeries): { label: string; className: string }[] {
  if (series === 'tokens')
    return TOKEN_SEGMENTS.map(({ label, className }) => ({ label, className }));
  if (series === 'runs')
    return [
      { label: 'Succeeded', className: 'bg-blue-500' },
      { label: 'Failed', className: 'bg-red-500' },
    ];
  return [
    { label: 'OK', className: 'bg-blue-500' },
    { label: 'Failed', className: 'bg-red-500' },
  ];
}

function segmentsOf(bucket: OrgBucket, series: UsageSeries): Segment[] {
  if (series === 'tokens') {
    return TOKEN_SEGMENTS.map((seg) => ({
      label: seg.label,
      value: bucket[seg.key],
      className: seg.className,
      ...(seg.key === 'imageTokens' && bucket.images > 0
        ? {
            detail: `${bucket.images.toLocaleString('en-US')} ${bucket.images === 1 ? 'image' : 'images'}, ${formatBytes(bucket.imageBytes)}`,
          }
        : {}),
    }));
  }
  if (series === 'runs') {
    return [
      {
        label: 'Succeeded',
        value: Math.max(0, bucket.runs - bucket.failures),
        className: 'bg-blue-500',
      },
      { label: 'Failed', value: bucket.failures, className: 'bg-red-500' },
    ];
  }
  return [
    {
      label: 'OK',
      value: Math.max(0, bucket.toolCalls - bucket.toolErrors),
      className: 'bg-blue-500',
    },
    { label: 'Failed', value: bucket.toolErrors, className: 'bg-red-500' },
  ];
}

/**
 * Stacked bars, one series at a time, no chart dependency — the same
 * inline-CSS shape every usage surface in this app already uses. Segments
 * are drawn in reverse order (last first in the DOM) so `justify-end`
 * anchors the base of the stack to the bar's bottom and the first-listed
 * category ends up on top, which is where its rounded corner belongs.
 */
export function UsageChart({ points, series }: { points: OrgBucket[]; series: UsageSeries }) {
  const legend = legendFor(series);
  const rows = points.map((point) => segmentsOf(point, series));
  const totals = rows.map((segments) => segments.reduce((sum, seg) => sum + seg.value, 0));
  const peak = Math.max(1, ...totals);
  if (points.length === 0 || totals.every((total) => total === 0)) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">Nothing in this period.</p>;
  }
  return (
    <div>
      <div
        className="flex h-40 items-end gap-px"
        role="img"
        aria-label={`${legend.map((entry) => entry.label).join(', ')} over time`}
      >
        {points.map((point, index) => {
          const segments = rows[index]!;
          const total = totals[index]!;
          const height = (total / peak) * 100;
          const tooltip = `${point.label}: ${segments
            .filter((seg) => seg.value > 0)
            .map(
              (seg) =>
                `${seg.label} ${seg.value.toLocaleString('en-US')}${seg.detail ? ` (${seg.detail})` : ''}`
            )
            .join(', ')}`;
          return (
            <div
              key={point.bucket}
              className="group relative flex-1"
              style={{ height: '100%' }}
              title={tooltip || point.label}
            >
              <div
                className="absolute inset-x-0 bottom-0 flex flex-col justify-end"
                style={{ height: '100%' }}
              >
                {[...segments].reverse().map((seg, idx) => (
                  <div
                    key={seg.label}
                    className={`w-full ${seg.className} ${idx === 0 ? 'rounded-t-sm' : ''}`}
                    style={{ height: `${total > 0 ? (seg.value / total) * height : 0}%` }}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-xs text-gray-500">
        <span>{points[0]?.label}</span>
        <span>{points[points.length - 1]?.label}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
        {legend.map((entry) => (
          <span key={entry.label} className="inline-flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-sm ${entry.className}`} /> {entry.label}
          </span>
        ))}
      </div>
    </div>
  );
}
