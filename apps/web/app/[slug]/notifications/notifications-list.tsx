'use client';

/**
 * The notification feed's interactive body.
 *
 * A client component because the feed finally acts like one: cards can be
 * deleted (one from an ellipsis menu or a swipe, many from a long-press /
 * shift-click selection with a sticky footer), and every delete passes
 * through one confirmation dialog. The server page still owns the query —
 * this component only renders the rows it was handed, minus the ones the
 * person deleted this visit.
 *
 * Interaction map:
 *  - Click a card         → opens the thing it is about (ref_url), new tab.
 *  - Shift/Cmd/Ctrl-click → toggles selection instead (desktop multi-select).
 *  - Long-press (touch)   → toggles selection (mobile multi-select).
 *  - Swipe left (touch)   → reveals a Delete button on that card.
 *  - Ellipsis menu        → Open <thing> / Show run / Delete, with icons.
 *  - Any Delete           → modal confirmation before the API call.
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import ConnectorIcon from '@/components/connector-icon';
import LocalTime from '@/components/local-time';
import { Icon, ICONS } from '@/components/icons';
import { useNotifications } from '@/components/notification-center';

export interface NotificationCard {
  id: string;
  connector: string | null;
  /** Singular noun for the linked thing — 'issue', 'note', 'meeting'. */
  entity: string | null;
  headline: string;
  refUrl: string | null;
  agentId: string | null;
  agentName: string | null;
  runId: string | null;
  unread: boolean;
  /** ISO timestamp — serialized by the server page. */
  createdAt: string;
}

/** A day heading a person recognises without doing arithmetic. */
function dayLabel(when: Date, today: Date): string {
  const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diff = Math.round((day(today).getTime() - day(when).getTime()) / 86_400_000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return when.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

/** How far a swipe must travel (px) before it counts as "delete revealed". */
const SWIPE_REVEAL_PX = 72;
/** Movement past this (px) cancels a pending long-press. */
const PRESS_DRIFT_PX = 10;
const LONG_PRESS_MS = 450;

export default function NotificationsList({
  tenantId,
  slug,
  rows,
}: {
  tenantId: string;
  slug: string;
  rows: NotificationCard[];
}) {
  const router = useRouter();
  const { refresh } = useNotifications();

  // Rows deleted this visit — hidden immediately, gone for real once the
  // API call lands and the server page re-renders.
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** Card whose swipe revealed its Delete button. */
  const [revealed, setRevealed] = useState<string | null>(null);
  /** Live swipe offset, applied as a transform while the finger is down. */
  const [drag, setDrag] = useState<{ id: string; dx: number } | null>(null);
  const [confirming, setConfirming] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  const menuRef = useRef<HTMLDivElement | null>(null);
  const touch = useRef<{
    id: string;
    startX: number;
    startY: number;
    moved: boolean;
    pressTimer: ReturnType<typeof setTimeout> | null;
    pressed: boolean;
  } | null>(null);
  // Set when a long-press just toggled selection, so the click that the
  // browser fires afterwards must not also open the link.
  const suppressClick = useRef(false);

  const selectionMode = selected.size > 0;
  const visible = rows.filter((row) => !removed.has(row.id));

  // One open menu at a time; outside click or Escape closes it — the same
  // choreography as the nav's avatar menu.
  useEffect(() => {
    if (!menuFor) return;
    const onDown = (event: MouseEvent) => {
      if (
        menuRef.current &&
        event.target instanceof Node &&
        !menuRef.current.contains(event.target)
      ) {
        setMenuFor(null);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuFor(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuFor]);

  // Escape closes the confirm dialog (while it is not mid-delete).
  useEffect(() => {
    if (!confirming) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) setConfirming(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [confirming, busy]);

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  async function deleteIds(ids: string[]) {
    setBusy(true);
    try {
      await fetch(`/api/tenant/${tenantId}/notifications`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      setRemoved((current) => new Set([...current, ...ids]));
      setSelected(new Set());
      setRevealed(null);
      setConfirming(null);
      refresh();
      router.refresh();
    } catch {
      // Nothing was deleted; the dialog stays up so the person can retry.
    } finally {
      setBusy(false);
    }
  }

  const onTouchStart = (id: string) => (event: React.TouchEvent) => {
    const point = event.touches[0];
    if (!point) return;
    touch.current = {
      id,
      startX: point.clientX,
      startY: point.clientY,
      moved: false,
      pressed: false,
      pressTimer: setTimeout(() => {
        if (touch.current?.id === id && !touch.current.moved) {
          touch.current.pressed = true;
          suppressClick.current = true;
          toggle(id);
        }
      }, LONG_PRESS_MS),
    };
  };

  const onTouchMove = (id: string) => (event: React.TouchEvent) => {
    const state = touch.current;
    const point = event.touches[0];
    if (!state || state.id !== id || !point) return;
    const dx = point.clientX - state.startX;
    const dy = point.clientY - state.startY;
    if (!state.moved && Math.hypot(dx, dy) > PRESS_DRIFT_PX) {
      state.moved = true;
      if (state.pressTimer) clearTimeout(state.pressTimer);
    }
    // Horizontal-dominant drag to the left drags the card; vertical stays
    // the page's scroll.
    if (state.moved && Math.abs(dx) > Math.abs(dy) && dx < 0 && !selectionMode) {
      setDrag({ id, dx: Math.max(dx, -SWIPE_REVEAL_PX * 1.5) });
    }
  };

  const onTouchEnd = (id: string) => () => {
    const state = touch.current;
    if (state?.pressTimer) clearTimeout(state.pressTimer);
    if (state?.moved) suppressClick.current = true;
    const dx = drag?.id === id ? drag.dx : 0;
    setDrag(null);
    if (dx <= -SWIPE_REVEAL_PX) setRevealed(id);
    else setRevealed((current) => (current === id ? null : current));
    touch.current = null;
  };

  const confirmCount = confirming?.length ?? 0;

  if (visible.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500 dark:border-gray-700">
        Nothing here. When one of your agents files a ticket or sends a message, it lands here.
      </p>
    );
  }

  // Grouped in one pass, order preserved — the rows arrive sorted.
  const now = new Date();
  const days: { label: string; rows: NotificationCard[] }[] = [];
  for (const row of visible) {
    const label = dayLabel(new Date(row.createdAt), now);
    const last = days[days.length - 1];
    if (last && last.label === label) last.rows.push(row);
    else days.push({ label, rows: [row] });
  }

  return (
    <div className="space-y-6">
      {days.map((day) => (
        <section key={day.label}>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
            {day.label}
          </h2>
          <ul className="space-y-1.5">
            {day.rows.map((row) => {
              const isSelected = selected.has(row.id);
              const dx = drag?.id === row.id ? drag.dx : revealed === row.id ? -SWIPE_REVEAL_PX : 0;
              const openLabel = `Open ${row.entity ?? 'link'}`;
              const runHref =
                row.runId && row.agentId
                  ? `/${slug}/agents/${row.agentId}/runs/${row.runId}`
                  : null;
              return (
                <li key={row.id} className="relative rounded-lg">
                  {/* The swipe target: covered by the card until it slides
                      left (no overflow clipping here — the ellipsis menu
                      must be able to hang past the card's edge). Delete =
                      icon AND word, never icon alone. */}
                  <button
                    type="button"
                    tabIndex={revealed === row.id ? 0 : -1}
                    aria-hidden={revealed !== row.id}
                    onClick={() => setConfirming([row.id])}
                    className="absolute inset-y-0 right-0 flex w-[72px] flex-col items-center justify-center gap-0.5 rounded-r-lg bg-red-600 text-[11px] font-medium text-white"
                  >
                    <Icon path={ICONS.trash} className="h-4 w-4" />
                    Delete
                  </button>
                  <div
                    onClick={(event) => {
                      if (suppressClick.current) {
                        suppressClick.current = false;
                        event.preventDefault();
                        return;
                      }
                      if (revealed === row.id) {
                        setRevealed(null);
                        event.preventDefault();
                        return;
                      }
                      if (selectionMode || event.shiftKey || event.metaKey || event.ctrlKey) {
                        event.preventDefault();
                        toggle(row.id);
                      }
                    }}
                    onTouchStart={onTouchStart(row.id)}
                    onTouchMove={onTouchMove(row.id)}
                    onTouchEnd={onTouchEnd(row.id)}
                    style={{ transform: dx ? `translateX(${dx}px)` : undefined }}
                    className={`relative flex items-start gap-3 rounded-lg border p-3 ${
                      drag?.id === row.id ? '' : 'transition-transform duration-150'
                    } ${
                      isSelected
                        ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500 dark:border-blue-600 dark:bg-blue-950/40'
                        : row.unread
                          ? 'border-blue-200 bg-blue-50/40 dark:border-blue-900 dark:bg-blue-950/20'
                          : 'border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950'
                    } ${
                      row.refUrl
                        ? 'transition-colors hover:border-blue-400 dark:hover:border-blue-700'
                        : ''
                    }`}
                  >
                    <span className="mt-0.5 shrink-0">
                      {selectionMode ? (
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggle(row.id)}
                          onClick={(event) => event.stopPropagation()}
                          aria-label={`Select "${row.headline}"`}
                          className="relative z-10 h-4 w-4"
                        />
                      ) : row.connector ? (
                        <ConnectorIcon
                          capabilityKey={row.connector}
                          label={row.connector}
                          size={18}
                        />
                      ) : (
                        <span aria-hidden="true" className="text-gray-400">
                          ⚙
                        </span>
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      {/*
                        The headline IS the link, stretched over the whole row
                        by a pseudo-element — one link in the accessibility
                        tree, named by the headline. Selection clicks and the
                        post-long-press click are intercepted above before the
                        anchor navigates.
                      */}
                      <p className="text-sm font-medium">
                        {row.refUrl ? (
                          <a
                            href={row.refUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(event) => {
                              if (
                                suppressClick.current ||
                                selectionMode ||
                                revealed === row.id ||
                                event.shiftKey ||
                                event.metaKey ||
                                event.ctrlKey
                              ) {
                                event.preventDefault();
                              }
                            }}
                            className="hover:underline after:absolute after:inset-0 after:rounded-lg"
                          >
                            {row.headline}
                          </a>
                        ) : (
                          row.headline
                        )}
                      </p>
                      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                        {row.agentName ?? 'An agent'} ·{' '}
                        <LocalTime at={row.createdAt} format="datetime" />
                      </p>
                    </div>
                    {/* `relative` puts the controls above the stretched
                        pseudo-element, so they stay clickable on a linked
                        card. */}
                    <div className="relative flex shrink-0 items-center gap-2 text-xs">
                      {row.refUrl ? (
                        <span
                          aria-hidden="true"
                          title="Opens in the connector"
                          className="text-blue-600 dark:text-blue-400"
                        >
                          ↗
                        </span>
                      ) : null}
                      <button
                        type="button"
                        aria-haspopup="menu"
                        aria-expanded={menuFor === row.id}
                        aria-label={`More actions for "${row.headline}"`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setMenuFor((current) => (current === row.id ? null : row.id));
                        }}
                        className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-300"
                      >
                        <Icon path={ICONS.more} className="h-4 w-4" />
                      </button>
                      {menuFor === row.id ? (
                        <div
                          ref={menuRef}
                          role="menu"
                          className="absolute right-0 top-7 z-40 w-44 rounded-lg border border-gray-200 bg-white py-1 text-sm shadow-lg dark:border-gray-700 dark:bg-gray-900"
                        >
                          {row.refUrl ? (
                            <a
                              role="menuitem"
                              href={row.refUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={() => setMenuFor(null)}
                              className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-800"
                            >
                              <Icon path={ICONS.externalLink} className="h-4 w-4" />
                              {openLabel}
                            </a>
                          ) : null}
                          {runHref ? (
                            <Link
                              role="menuitem"
                              href={runHref}
                              onClick={() => setMenuFor(null)}
                              className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-800"
                            >
                              <Icon path={ICONS.play} className="h-4 w-4" />
                              Show run
                            </Link>
                          ) : null}
                          <button
                            role="menuitem"
                            type="button"
                            onClick={() => {
                              setMenuFor(null);
                              setConfirming([row.id]);
                            }}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
                          >
                            <Icon path={ICONS.trash} className="h-4 w-4" />
                            Delete
                          </button>
                        </div>
                      ) : null}
                      {runHref ? (
                        <Link href={runHref} className="text-gray-500 hover:underline">
                          Run
                        </Link>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {/* Sticky multi-select footer — appears with the first selected card. */}
      {selectionMode ? (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-gray-200 bg-white/95 px-4 py-3 backdrop-blur dark:border-gray-800 dark:bg-gray-950/95">
          <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
            <span className="text-sm text-gray-600 dark:text-gray-400">
              {selected.size} selected
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => setConfirming([...selected])}
                className="flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
              >
                <Icon path={ICONS.trash} className="h-4 w-4" />
                Delete
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Delete confirmation — every delete path funnels through here. */}
      {confirming ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-label="Confirm delete"
          onClick={() => {
            if (!busy) setConfirming(null);
          }}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-4 shadow-xl dark:border-gray-800 dark:bg-gray-950"
          >
            <h2 className="text-base font-semibold">
              Delete {confirmCount === 1 ? 'this notification' : `${confirmCount} notifications`}?
            </h2>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              {confirmCount === 1 ? 'It disappears' : 'They disappear'} from your feed for good.
              This doesn’t undo anything the agent did.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirming(null)}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void deleteIds(confirming)}
                className="flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                <Icon path={ICONS.trash} className="h-4 w-4" />
                {busy ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
