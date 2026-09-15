/**
 * "Tokens by surface": how spend splits across chat, chat projects, code
 * projects and agents — the same four buckets and the same colors whether
 * it's read org-wide (Organization Usage) or for one person (My usage),
 * so a color always means the same surface everywhere it appears.
 */

import { formatTokens } from '@/lib/format-tokens';
import type { OrgTokenTotals, SurfaceTokens } from '@/lib/usage/org-usage';

const SURFACES: { key: keyof OrgTokenTotals; label: string; className: string }[] = [
  { key: 'chat', label: 'Chat', className: 'bg-blue-500' },
  { key: 'chatProjects', label: 'Chat projects', className: 'bg-teal-500' },
  { key: 'codeProjects', label: 'Code projects', className: 'bg-amber-500' },
  { key: 'agents', label: 'Agents', className: 'bg-purple-500' },
];

function Row({
  label,
  tokens,
  shareOfTotal,
  className,
}: {
  label: string;
  tokens: SurfaceTokens;
  shareOfTotal: number;
  className: string;
}) {
  return (
    <li>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="min-w-0 truncate">{label}</span>
        <span className="shrink-0 tabular-nums text-gray-600 dark:text-gray-400">
          {formatTokens(tokens.input + tokens.output)}
          <span className="ml-1 text-xs text-gray-400">
            ({formatTokens(tokens.input)} in · {formatTokens(tokens.output)} out)
          </span>
        </span>
      </div>
      <div
        className="mt-1 h-1.5 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800"
        aria-hidden="true"
      >
        <div className={`h-full rounded-full ${className}`} style={{ width: `${shareOfTotal}%` }} />
      </div>
    </li>
  );
}

export function TokenSurfaceBreakdown({
  tokens,
  heading = 'Tokens by surface',
}: {
  tokens: OrgTokenTotals;
  heading?: string;
}) {
  const total = SURFACES.reduce(
    (sum, surface) => sum + tokens[surface.key].input + tokens[surface.key].output,
    0
  );
  return (
    <section className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
      <h2 className="mb-3 text-sm font-semibold">{heading}</h2>
      <ul className="space-y-3">
        {SURFACES.map((surface) => (
          <Row
            key={surface.key}
            label={surface.label}
            tokens={tokens[surface.key]}
            shareOfTotal={total > 0 ? ((tokens[surface.key].input + tokens[surface.key].output) / total) * 100 : 0}
            className={surface.className}
          />
        ))}
      </ul>
    </section>
  );
}
