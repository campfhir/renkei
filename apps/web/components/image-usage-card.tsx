/**
 * Images, in three numbers: how many pictures were drawn, how much space
 * they take (the files as kept, in KB/MB/GB), and the tokens the image
 * provider billed for them — which only some report (gpt-image does,
 * FLUX does not). Shared by My usage and Organization usage, which
 * differ only in whose numbers these are. The twin of voice-usage-card.tsx.
 */

import { formatTokens } from '@/lib/format-tokens';
import type { ImageTotals } from '@/lib/usage/image-usage';
import { formatBytes } from '@/lib/usage/image-window';

export function ImageUsageCard({
  totals,
  heading = 'Images',
  hint,
}: {
  totals: ImageTotals;
  heading?: string;
  hint: string;
}) {
  const tokens = totals.inputTokens + totals.outputTokens;
  return (
    <section
      className="rounded-lg border border-gray-200 p-4 dark:border-gray-800"
      data-testid="image-usage-card"
    >
      <h2 className="text-sm font-semibold">{heading}</h2>
      <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">{hint}</p>
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-900">
          <p className="text-xs tracking-wide text-gray-500 uppercase">Generated</p>
          <p className="text-2xl font-semibold tabular-nums" data-testid="image-usage-count">
            {totals.images.toLocaleString('en-US')}
          </p>
          <p className="text-xs text-gray-500">{totals.images === 1 ? 'image' : 'images'}</p>
        </div>
        <div className="rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-900">
          <p className="text-xs tracking-wide text-gray-500 uppercase">Stored</p>
          <p className="text-2xl font-semibold tabular-nums" data-testid="image-usage-bytes">
            {formatBytes(totals.bytes)}
          </p>
          <p className="text-xs text-gray-500">of image files</p>
        </div>
      </div>
      <p className="mt-3 text-xs text-gray-500 dark:text-gray-400" data-testid="image-usage-tokens">
        {tokens > 0
          ? `${formatTokens(totals.inputTokens)} tokens in · ${formatTokens(totals.outputTokens)} tokens out, as billed by the image model.`
          : 'No tokens reported — some image models bill per image, not per token.'}
      </p>
    </section>
  );
}
