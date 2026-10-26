/**
 * Documents, in the numbers a person can act on: how many reads OCR did
 * (and the pages they went over), how many summaries and picture
 * descriptions the model wrote for files they uploaded, and what the model
 * billed for those. The twin of image-usage-card.tsx. OCR bills pages, so
 * its reads are counted, not priced; the tokens are the model's.
 */

import { formatTokens } from '@/lib/format-tokens';
import type { DocumentTotals } from '@/lib/usage/document-usage';

export function DocumentUsageCard({
  totals,
  heading = 'Documents',
  hint,
}: {
  totals: DocumentTotals;
  heading?: string;
  hint: string;
}) {
  const tokens = totals.inputTokens + totals.outputTokens;
  return (
    <section
      className="rounded-lg border border-gray-200 p-4 dark:border-gray-800"
      data-testid="document-usage-card"
    >
      <h2 className="text-sm font-semibold">{heading}</h2>
      <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">{hint}</p>
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-900">
          <p className="text-xs tracking-wide text-gray-500 uppercase">OCR</p>
          <p className="text-2xl font-semibold tabular-nums" data-testid="document-usage-pages">
            {totals.pages.toLocaleString('en-US')}
          </p>
          <p className="text-xs text-gray-500">
            {totals.pages === 1 ? 'page' : 'pages'} in {totals.ocrReads.toLocaleString('en-US')}{' '}
            {totals.ocrReads === 1 ? 'read' : 'reads'}
          </p>
        </div>
        <div className="rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-900">
          <p className="text-xs tracking-wide text-gray-500 uppercase">Summarized</p>
          <p className="text-2xl font-semibold tabular-nums" data-testid="document-usage-summaries">
            {(totals.summaries + totals.pictures).toLocaleString('en-US')}
          </p>
          <p className="text-xs text-gray-500">
            {totals.summaries.toLocaleString('en-US')} of text ·{' '}
            {totals.pictures.toLocaleString('en-US')} of pictures
          </p>
        </div>
      </div>
      <p
        className="mt-3 text-xs text-gray-500 dark:text-gray-400"
        data-testid="document-usage-tokens"
      >
        {tokens > 0
          ? `${formatTokens(totals.inputTokens)} tokens in · ${formatTokens(totals.outputTokens)} tokens out, as billed by the model for summaries and descriptions.`
          : 'No model tokens yet for summaries or descriptions.'}
      </p>
    </section>
  );
}
