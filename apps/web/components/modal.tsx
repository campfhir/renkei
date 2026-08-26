'use client';

/**
 * The house modal, extracted: the same overlay/panel recipe the section
 * sheets and dialogs across the app hand-roll (collapsible-section.tsx is
 * the canonical copy). Clicking the backdrop or pressing Escape closes;
 * clicks inside the panel stay inside. No footer API on purpose — callers
 * render their own buttons, because every dialog's actions differ.
 *
 * No portal: nothing in the app portals its overlays, and z-50 sits above
 * the nav in the documented z-budget (see toast-stack.tsx).
 */

import { useEffect, type ReactNode } from 'react';
import { Icon, ICONS } from './icons';

export default function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center"
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-5 shadow-xl dark:border-gray-800 dark:bg-gray-950"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
          >
            <Icon path={ICONS.close} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
