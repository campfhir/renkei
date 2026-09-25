'use client';

/**
 * The title bar's "More" button: a menu of actions that either don't fit
 * beside the chat's name on a small screen — Share, and a code chat's
 * Environment, Add files and Changes, which are buttons of their own on a
 * wide screen instead — or apply to the chat itself and always live here —
 * Rename, Archive and Delete. Picking an item closes the menu; the item's
 * own dialog, if any, is the caller's and outlives the menu.
 */

import { useRef, useState, type ReactNode } from 'react';
import { Icon, ICONS } from '@/components/icons';
import { useDismiss } from '@/lib/use-dismiss';
import { useCoachAnchor } from '@/components/coach-marks/anchor';

export interface OverflowItem {
  label: string;
  icon: string;
  onSelect: () => void;
  /** Something beside the label — a diff's +added −deleted. */
  extra?: ReactNode;
  /** A destructive action (delete): rendered in red, like the sidebar's. */
  danger?: boolean;
}

export default function OverflowMenu({
  items,
  label = 'More',
  anchored = true,
}: {
  items: OverflowItem[];
  /** The button's accessible name and tooltip — several of these can sit
   * on one page (a file tree's per-row menu, say), so a caller with more
   * than one gives each a distinct label. */
  label?: string;
  /** Registers this button as the "chat-more" coach-mark tour step —
   * true only for the title bar's own menu, the one the tour means;
   * every other caller passes false so the tour does not latch onto
   * whichever instance happened to mount last. */
  anchored?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const moreAnchor = useCoachAnchor('chat-more');
  useDismiss(open, ref, () => setOpen(false));
  if (items.length === 0) return null;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        {...(anchored ? moreAnchor : null)}
        className="flex items-center rounded-md border border-gray-300 px-2 py-1 text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900"
      >
        <Icon path={ICONS.moreHorizontal} className="h-4 w-4" />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-40 mt-1 w-52 rounded-md border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-800 dark:bg-gray-950"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-900 ${item.danger ? 'text-red-600 dark:text-red-400' : ''}`}
            >
              <Icon
                path={item.icon}
                className={`h-4 w-4 shrink-0 ${item.danger ? 'text-red-500' : 'text-gray-500'}`}
              />
              <span className="flex-1">{item.label}</span>
              {item.extra}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
