'use client';

/**
 * The one editing surface of the flow builder. The canvas stays a chart of
 * collapsed nodes; whatever is SELECTED — a step, a trigger — gets edited in
 * here: a docked, sticky sidebar on desktop (click another node, the panel
 * just swaps content, Jira-style), a full-screen modal on phones.
 *
 * Width is the caller's call: 'wide' exists for the schedule editor, whose
 * rule rows and blackout forms would be cramped at sidebar width.
 */

import { useEffect, type ReactNode } from 'react';
import { useMediaQuery } from '@/lib/use-media-query';
import { Icon, ICONS } from '@/components/icons';

export function EditorPanel({
  title,
  width = 'normal',
  onClose,
  footer,
  children,
}: {
  title: string;
  width?: 'normal' | 'wide';
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const isDesktop = useMediaQuery('(min-width: 1024px)');

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Mobile: a modal the person opened and closes (X). Desktop: this panel
  // occupies the SAME slot the agent-settings sidebar sits in the rest of
  // the time — closing it isn't leaving anywhere, it's going back to that,
  // so a back arrow reads truer than a close button.
  const mobileHeader = (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h2 className="min-w-0 truncate text-sm font-semibold">{title}</h2>
      <button
        type="button"
        aria-label="Close editor"
        onClick={onClose}
        className="shrink-0 rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
      >
        <Icon path={ICONS.close} />
      </button>
    </div>
  );

  if (isDesktop) {
    return (
      <aside
        aria-label={title}
        className={`${
          width === 'wide' ? 'lg:w-[36rem]' : 'lg:w-[26rem]'
        } shrink-0 self-start rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950 lg:sticky lg:top-4 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto`}
      >
        <div className="mb-3">
          <button
            type="button"
            onClick={onClose}
            className="mb-2 flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            <Icon path={ICONS.chevronLeft} className="h-3.5 w-3.5" />
            Back
          </button>
          <h2 className="truncate text-sm font-semibold">{title}</h2>
        </div>
        {children}
        {footer ? (
          <div className="mt-4 border-t border-gray-100 pt-3 dark:border-gray-800">{footer}</div>
        ) : null}
      </aside>
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
      className="fixed inset-0 z-40 overflow-y-auto bg-black/40 sm:flex sm:items-start sm:justify-center sm:p-4"
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="min-h-full w-full bg-white p-4 dark:bg-gray-950 sm:my-8 sm:min-h-0 sm:max-w-lg sm:rounded-xl sm:border sm:border-gray-200 sm:shadow-xl sm:dark:border-gray-800"
      >
        {mobileHeader}
        {children}
        {footer ? (
          <div className="mt-4 border-t border-gray-100 pt-3 dark:border-gray-800">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}
