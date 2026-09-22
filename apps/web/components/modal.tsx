'use client';

/**
 * The house modal, extracted: the same overlay/panel recipe the section
 * sheets and dialogs across the app hand-roll (collapsible-section.tsx is
 * the canonical copy). Clicking the backdrop or pressing Escape closes;
 * clicks inside the panel stay inside. No footer API on purpose — callers
 * render their own buttons, because every dialog's actions differ.
 *
 * Portalled to <body>. A dialog is opened from wherever its trigger lives —
 * a chat row inside the nav, a tool card deep in a thread — and rendered in
 * place its `position: fixed` overlay is at the mercy of every ancestor:
 * the desktop nav column is `sticky`, which is a stacking context of its
 * own, so the page's positioned content painted over the dialog and took
 * its clicks; the phone drawer is a fixed, scrolling box that iOS Safari
 * treats as the containing block of fixed descendants, so the dialog was
 * clipped to the drawer's width. At <body> the overlay answers only to the
 * viewport, and z-50 sits above the nav in the documented z-budget (see
 * toast-stack.tsx). React events still bubble through the owner tree, so
 * callers' handlers see clicks exactly as before. Theme is `data-theme`
 * on <html>, so the panel keeps its dark styling outside the shell.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon, ICONS } from './icons';

export default function Modal({
  title,
  onClose,
  children,
  size = 'md',
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** 'lg' for a form with a list in it; 'wide' for content that needs the room — a diff side by side. */
  size?: 'md' | 'lg' | 'wide';
}) {
  // There is no document on the server; the portal target exists only once
  // this has mounted. A dialog is opened by a click, so nobody sees the
  // one-frame delay, and rendering nothing first keeps hydration honest.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!mounted) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center"
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className={`w-full ${size === 'wide' ? 'max-w-6xl' : size === 'lg' ? 'max-w-2xl' : 'max-w-md'} rounded-xl border border-gray-200 bg-white p-5 shadow-xl dark:border-gray-800 dark:bg-gray-950`}
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
    </div>,
    document.body
  );
}
