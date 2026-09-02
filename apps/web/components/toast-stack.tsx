'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon, ICONS } from '@/components/icons';
import { useNotifications, type AppNotification } from '@/components/notification-center';
import { notificationSourceLabel } from '@/lib/notifications/batch-meta';

/**
 * Arrivals, stacked in a corner like a pile of cards.
 *
 * At most three, LAYERED rather than listed: the newest sits square on top
 * and the ones under it peek out by a few pixels, so the pile says "and
 * some more" without spending three cards' worth of screen saying it.
 * Hovering fans them apart.
 *
 * The corner, width and z-index (against the nav — the drawer is z-50 and
 * its menu is z-40, so a toast can never cover the menu somebody just
 * opened to get away from it) all live in the parent, `NotificationCorner`
 * — this renders as a plain block so it can share that one fixed-position
 * box with `NotificationPermissionNudge` instead of anchoring itself.
 *
 * Auto-dismiss PAUSES on hover and on focus. A card that carries a link and
 * then vanishes as the pointer reaches it is the classic toast failure, and
 * these carry links to the ticket that was just filed.
 */

const VISIBLE = 3;
const DISMISS_MS = 8_000;

/**
 * Newest first: offset, scale and opacity for each layer of the pile.
 *
 * The offsets go UP, not down. The stack is anchored to the bottom of the
 * screen, so pushing the older cards downward hides their edges off the
 * bottom of the viewport and the pile looks like a single card. Lifting
 * them instead puts a sliver of each above the newest one, which is the
 * only thing telling you there is more than one.
 */
const LAYERS = [
  'translate-y-0 scale-100 opacity-100 z-[3]',
  '-translate-y-2.5 scale-[0.97] opacity-90 z-[2]',
  '-translate-y-5 scale-[0.94] opacity-80 z-[1]',
];

/**
 * Collapse repeats of the same tool in the same run into one card.
 *
 * A foreach loop commenting on forty issues is forty notifications, and
 * without this it is also forty toasts. The page still lists those
 * individually — this is only about what the corner shows. (An act that is
 * itself a batch — a bulk mail job — is already ONE tallied row per run by
 * the time it gets here; see the worker's act-tally.ts.)
 */
function coalesce(arrivals: AppNotification[]): { entry: AppNotification; extra: number }[] {
  const groups = new Map<string, { entry: AppNotification; extra: number }>();
  for (const entry of arrivals) {
    const key = entry.runId && entry.tool ? `${entry.runId}:${entry.tool}` : entry.id;
    const existing = groups.get(key);
    if (existing) existing.extra += 1;
    else groups.set(key, { entry, extra: 0 });
  }
  return [...groups.values()];
}

export default function ToastStack() {
  const { arrivals, dismiss } = useNotifications();
  const [paused, setPaused] = useState(false);
  const [fanned, setFanned] = useState(false);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const shown = useMemo(() => coalesce(arrivals).slice(0, VISIBLE), [arrivals]);

  useEffect(() => {
    const running = timers.current;
    if (paused) {
      for (const timer of running.values()) clearTimeout(timer);
      running.clear();
      return;
    }
    for (const { entry } of shown) {
      if (running.has(entry.id)) continue;
      running.set(
        entry.id,
        setTimeout(() => {
          running.delete(entry.id);
          dismiss(entry.id);
        }, DISMISS_MS)
      );
    }
    // Anything no longer shown loses its timer.
    const live = new Set(shown.map(({ entry }) => entry.id));
    for (const [id, timer] of running) {
      if (!live.has(id)) {
        clearTimeout(timer);
        running.delete(id);
      }
    }
  }, [shown, paused, dismiss]);

  useEffect(() => {
    const running = timers.current;
    return () => {
      for (const timer of running.values()) clearTimeout(timer);
      running.clear();
    };
  }, []);

  if (shown.length === 0) return null;

  return (
    <div
      aria-live="polite"
      onMouseEnter={() => {
        setPaused(true);
        setFanned(true);
      }}
      onMouseLeave={() => {
        setPaused(false);
        setFanned(false);
      }}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
      className="pointer-events-auto w-full"
    >
      {/* Fixed height so the pile does not make the page jump as cards
          arrive and leave; the cards are absolutely positioned inside it. */}
      <div className={fanned ? 'relative' : 'relative h-24'}>
        {shown.map(({ entry, extra }, index) => (
          <article
            key={entry.id}
            className={`${fanned ? 'relative mb-2' : `absolute inset-x-0 bottom-0 ${LAYERS[index] ?? LAYERS[2]}`} rounded-lg border border-gray-200 bg-white p-3 shadow-lg transition-all motion-reduce:transition-none dark:border-gray-700 dark:bg-gray-950 ${
              entry.refUrl ? 'hover:border-blue-400 dark:hover:border-blue-700' : ''
            }`}
          >
            <div className="flex items-start gap-2">
              <span className="mt-0.5 shrink-0 text-gray-400">
                <Icon path={ICONS.bell} className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                {/*
                  The card is the link, stretched from the headline by a
                  pseudo-element rather than wrapped around everything — an
                  anchor around the whole card would swallow the dismiss
                  button inside it, and a toast you cannot dismiss without
                  navigating is worse than one with no link at all.

                  "and N more" stays OUTSIDE the anchor: the link goes to
                  one thing, and it should not be named after several.
                */}
                <p className="text-sm font-medium">
                  {entry.refUrl ? (
                    <a
                      href={entry.refUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline after:absolute after:inset-0 after:rounded-lg"
                    >
                      {entry.headline}
                    </a>
                  ) : (
                    entry.headline
                  )}
                  {extra > 0 ? (
                    <span className="ml-1 font-normal text-gray-500">and {extra} more</span>
                  ) : null}
                </p>
                <p className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">
                  {notificationSourceLabel(entry)}
                </p>
              </div>
              {entry.refUrl ? (
                <span
                  aria-hidden="true"
                  className="mt-0.5 shrink-0 text-xs text-blue-600 dark:text-blue-400"
                >
                  ↗
                </span>
              ) : null}
              {/* A plain close, NOT RemoveButton: that one is red and means
                  destructive, and dismissing a toast destroys nothing.
                  `relative` keeps it above the stretched link. */}
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => dismiss(entry.id)}
                className="relative shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800"
              >
                <Icon path={ICONS.close} className="h-3.5 w-3.5" />
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
