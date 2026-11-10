'use client';

/**
 * The OCR part of a file's details: the button that asks for a read of a
 * scan or image, and while a read is in flight, how far it has got and how
 * long the estimate says it has left. The estimate counts down between the
 * page's own refreshes, so the time moves every second.
 */

import { useEffect, useState } from 'react';
import DownloadLink, { useDownloadReady } from '@/components/download-link';
import { chatClient } from '@/lib/chat/client';
import type { LibraryItem } from '@/lib/chat/artifact-library';
import { ocrOffer, ocrProgress, textFilename } from './artifact-ocr-panel.model';

export { canRunOcr, durationLabel } from './artifact-ocr-panel.model';

export default function OcrPanel({
  item,
  digests,
  onStart,
}: {
  item: LibraryItem;
  /** Whether the organization writes summaries, which is what search reads. */
  digests: boolean;
  onStart: (item: LibraryItem) => Promise<void>;
}) {
  // The server's snapshot of the run, and when this copy of it was made.
  // The page refreshes it every few seconds; the clock between is local.
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(mountedAt);
  const [busy, setBusy] = useState(false);
  // The text's link waits here until its file is in hand for the share sheet.
  const textHref = chatClient.attachmentTextUrl(item.id);
  const textName = textFilename(item.filename);
  const textReady = useDownloadReady(textHref, textName);
  const running = item.ocr;

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  if (running) {
    const progress = ocrProgress(running, now - mountedAt);
    const { percent } = progress;
    return (
      <section aria-label="OCR" className="border-t border-gray-100 px-4 py-3 dark:border-gray-900">
        <h3 className="mb-2 text-xs font-semibold text-gray-500">OCR</h3>
        {running.stalled ? (
          <>
            <p className="text-sm text-amber-700 dark:text-amber-400">
              This read has not reported back in over 15 minutes.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void onStart(item).finally(() => setBusy(false));
              }}
              className="mt-2 rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
            >
              Start it again
            </button>
          </>
        ) : (
          <>
            <div
              role="progressbar"
              aria-label="OCR progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent === null ? undefined : Math.round(percent)}
              className="h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800"
            >
              {percent === null ? (
                <div className="h-full w-1/3 animate-pulse rounded-full bg-blue-400" />
              ) : (
                <div
                  className="h-full bg-blue-600 transition-[width] duration-1000"
                  style={{ width: `${percent}%` }}
                />
              )}
            </div>
            <p className="mt-2 text-sm">{progress.sofar}</p>
            <p className="mt-1 text-xs text-gray-500">{progress.estimate}</p>
          </>
        )}
      </section>
    );
  }

  const offer = ocrOffer(item);
  if (offer) {
    return (
      <section aria-label="OCR" className="border-t border-gray-100 px-4 py-3 dark:border-gray-900">
        <h3 className="mb-2 text-xs font-semibold text-gray-500">OCR</h3>
        {offer.pages !== null ? (
          <p className="mb-1 text-sm text-gray-700 dark:text-gray-300">{offer.pages}</p>
        ) : null}
        {offer.download ? (
          textReady === 'pending' ? (
            <p className="mb-1 text-sm text-gray-500">Preparing the text…</p>
          ) : (
            <DownloadLink
              href={textHref}
              filename={textName}
              className="mb-1 inline-block text-sm text-blue-600 hover:underline dark:text-blue-400"
            >
              Download the text
            </DownloadLink>
          )
        ) : null}
        <p className="text-sm text-gray-700 dark:text-gray-300">{offer.explanation}</p>
        {!digests ? (
          <p className="mt-1 text-xs text-gray-500">
            Summaries and descriptions are off for this organization, so search will not find this
            file by its content until they are on (Admin → Settings).
          </p>
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onStart(item).finally(() => setBusy(false));
          }}
          className="mt-2 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {offer.button}
        </button>
      </section>
    );
  }

  return null;
}
