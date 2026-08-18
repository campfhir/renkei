'use client';

/**
 * A section that folds: native `<details>` on desktop (the house accordion),
 * a button that opens a full modal on phones — where an accordion would just
 * push everything else off screen.
 *
 * One `children` instance, chosen by matchMedia, never two: panels inside
 * are stateful (Knowledge fetches and mutates), and a render-both approach
 * would double-fetch and desync. SSR and the first client render always
 * produce the `<details>` form — `useMediaQuery` reports its default until
 * hydration — so there is no mismatch; on phones the summary row swaps into
 * a visually identical button a beat later.
 *
 * Children mount when their container mounts: on desktop at page load (a
 * collapsed <details> still mounts its content), on mobile when the modal
 * opens — which turns fetch-on-mount panels into fetch-on-open for free.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useMediaQuery } from '@/lib/use-media-query';
import { Icon, ICONS } from '@/components/icons';

const SECTION_FRAME = 'mb-3 rounded-lg border border-gray-200 dark:border-gray-800';
const SUMMARY_TEXT = 'text-sm font-medium';

export default function CollapsibleSection({
  title,
  hint,
  defaultOpen = false,
  children,
}: {
  title: string;
  /** Muted line under the title in the summary row, e.g. a count. */
  hint?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const isMobile = useMediaQuery('(max-width: 1023.98px)');
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    if (!modalOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setModalOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modalOpen]);

  if (!isMobile) {
    return (
      <details className={`${SECTION_FRAME} p-3`} open={defaultOpen}>
        <summary className={`cursor-pointer ${SUMMARY_TEXT}`}>
          {title}
          {hint ? <span className="ml-2 font-normal text-gray-500">{hint}</span> : null}
        </summary>
        <div className="mt-3">{children}</div>
      </details>
    );
  }

  return (
    <div className={SECTION_FRAME}>
      <button
        type="button"
        onClick={() => setModalOpen(true)}
        className="flex w-full items-center justify-between p-3 text-left"
      >
        <span className={SUMMARY_TEXT}>
          {title}
          {hint ? <span className="ml-2 font-normal text-gray-500">{hint}</span> : null}
        </span>
        <Icon path={ICONS.chevron} className="h-4 w-4 text-gray-400" />
      </button>

      {modalOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={title}
          onClick={() => setModalOpen(false)}
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center"
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border border-gray-200 bg-white p-5 shadow-xl dark:border-gray-800 dark:bg-gray-950"
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">{title}</h2>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setModalOpen(false)}
                className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
              >
                <Icon path={ICONS.close} />
              </button>
            </div>
            {children}
          </div>
        </div>
      ) : null}
    </div>
  );
}
