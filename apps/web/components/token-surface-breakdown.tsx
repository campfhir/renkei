/**
 * "Tokens by surface": how spend splits across chat, chat projects, code
 * projects, agents, images and documents — the same five buckets and the same colors whether
 * it's read org-wide (Organization Usage) or for one person (My usage),
 * so a color always means the same surface everywhere it appears.
 */

import { formatTokens } from '@/lib/format-tokens';
import type { OrgTokenTotals, SurfaceTokens } from '@/lib/usage/org-usage';
import type { DocumentTotals } from '@/lib/usage/document-usage';

const SURFACES: { key: keyof OrgTokenTotals; label: string; className: string }[] = [
  { key: 'chat', label: 'Chat', className: 'bg-blue-500' },
  { key: 'chatProjects', label: 'Chat projects', className: 'bg-teal-500' },
  { key: 'codeProjects', label: 'Code projects', className: 'bg-amber-500' },
  { key: 'agents', label: 'Agents', className: 'bg-purple-500' },
  // What image generation models billed; pink — distinct from the Agents purple — like the Images leaderboard and chart segment.
  { key: 'images', label: 'Images', className: 'bg-pink-500' },
  // What the model billed to summarize uploaded files and describe their pictures; green, distinct from the rest.
  { key: 'documents', label: 'Documents', className: 'bg-emerald-500' },
];

/**
 * The Documents row's activity, in the words of the work done: OCR reads
 * (and their pages), summaries of text, and pictures described.
 */
function documentsDetail(documents: DocumentTotals): string | null {
  const parts = [
    documents.ocrReads > 0
      ? `${documents.ocrReads.toLocaleString('en-US')} OCR ${documents.ocrReads === 1 ? 'read' : 'reads'}, ${documents.pages.toLocaleString('en-US')} ${documents.pages === 1 ? 'page' : 'pages'}`
      : null,
    documents.summaries > 0
      ? `${documents.summaries.toLocaleString('en-US')} ${documents.summaries === 1 ? 'summary' : 'summaries'}`
      : null,
    documents.pictures > 0
      ? `${documents.pictures.toLocaleString('en-US')} ${documents.pictures === 1 ? 'picture' : 'pictures'} described`
      : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function Row({
  label,
  tokens,
  shareOfTotal,
  className,
  detail,
}: {
  label: string;
  tokens: SurfaceTokens;
  shareOfTotal: number;
  className: string;
  detail?: string | null;
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
      {detail ? <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{detail}</p> : null}
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
  documents,
  heading = 'Tokens by surface',
}: {
  tokens: OrgTokenTotals;
  /** The Documents work behind the Documents row: OCR reads and pages, summaries, pictures. */
  documents?: DocumentTotals;
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
            shareOfTotal={
              total > 0
                ? ((tokens[surface.key].input + tokens[surface.key].output) / total) * 100
                : 0
            }
            className={surface.className}
            detail={surface.key === 'documents' && documents ? documentsDetail(documents) : null}
          />
        ))}
      </ul>
    </section>
  );
}
