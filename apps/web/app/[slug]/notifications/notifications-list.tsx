'use client';

/**
 * The notification feed's interactive body.
 *
 * A client component because the feed finally acts like one: cards can be
 * deleted (one at a time or in bulk), and every delete passes through one
 * confirmation dialog. The server page still owns the query — this
 * component only renders the rows it was handed, minus the ones the
 * person deleted this visit.
 *
 * Interaction map — deliberately click-only. An earlier draft carried
 * swipe-to-delete and long-press selection; on real phones the touch
 * handlers fought scrolling and left cards stuck half-swiped, so every
 * action now lives in one place:
 *  - Click a card         → opens the thing it is about (ref_url), new tab,
 *    and marks the row read — tapping IS reading.
 *  - The ⋯ menu           → Open <thing> / Show run / Mark read or unread /
 *    Select / Delete.
 *  - "Select" (or shift/cmd-click on desktop) → selection mode with
 *    checkboxes and a sticky footer: Select all / Mark read / Mark unread /
 *    Delete.
 *  - Any Delete           → modal confirmation before the API call.
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import ConnectorIcon from '@/components/connector-icon';
import LocalTime from '@/components/local-time';
import { Icon, ICONS } from '@/components/icons';
import { useNotifications } from '@/components/notification-center';
import {
  batchNotificationHref,
  batchNotificationProgress,
  isBatchNotificationKind,
  notificationSourceLabel,
  parseBatchNotificationMeta,
} from '@/lib/notifications/batch-meta';

export interface NotificationCard {
  id: string;
  /**
   * 'run_started' | 'run_finished' | 'run_failed' | 'act' | 'agent_edited' |
   * 'agent_disabled' | 'batch_started' | 'batch_finished' | 'batch_failed'.
   */
  kind: string;
  connector: string | null;
  /** Singular noun for the linked thing — 'issue', 'note', 'meeting', 'batch'. */
  entity: string | null;
  headline: string;
  refUrl: string | null;
  agentId: string | null;
  agentName: string | null;
  runId: string | null;
  /** Batch-job rows carry their counts here — see lib/notifications/batch-meta.ts. */
  meta: unknown;
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
  const [confirming, setConfirming] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  const menuRef = useRef<HTMLDivElement | null>(null);

  const selectionMode = selected.size > 0;
  const visible = rows.filter((row) => !removed.has(row.id));
  const allSelected = selectionMode && selected.size === visible.length;

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

  // Read state changed this visit — id → is now read. Applied optimistically
  // so a tap dims the card at once; the server row catches up on refresh.
  const [readOverride, setReadOverride] = useState<ReadonlyMap<string, boolean>>(new Map());
  const isUnread = (row: NotificationCard) => {
    const override = readOverride.get(row.id);
    return override === undefined ? row.unread : !override;
  };

  async function setRead(ids: string[], read: boolean) {
    if (ids.length === 0) return;
    setReadOverride((current) => {
      const next = new Map(current);
      for (const id of ids) next.set(id, read);
      return next;
    });
    try {
      await fetch(`/api/tenant/${tenantId}/notifications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, ...(read ? {} : { unread: true }) }),
      });
      refresh();
      router.refresh();
    } catch {
      // The next poll or refresh reconciles; the optimistic state stands.
    }
  }

  /** Tapping a card is reading it — every open path funnels through here. */
  const markReadOnOpen = (row: NotificationCard) => {
    if (isUnread(row)) void setRead([row.id], true);
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
      setConfirming(null);
      refresh();
      router.refresh();
    } catch {
      // Nothing was deleted; the dialog stays up so the person can retry.
    } finally {
      setBusy(false);
    }
  }

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
              const unread = isUnread(row);
              const openLabel = `Open ${row.entity ?? 'link'}`;
              const runHref =
                row.runId && row.agentId
                  ? `/${slug}/agents/${row.agentId}/runs/${row.runId}`
                  : null;
              // A batch row points at the batch's own page — in-app, like
              // the agent links below, and rendered through the same
              // `agentHref` slot so the card's link/menu logic stays one path.
              const batch = isBatchNotificationKind(row.kind)
                ? parseBatchNotificationMeta(row.meta)
                : null;
              const batchProgress = batch ? batchNotificationProgress(batch) : '';
              // "Someone edited your agent" and "your agent was turned
              // off — update it" both point at the agent itself — in-app,
              // so no new tab.
              const agentHref = batch
                ? batchNotificationHref(slug, batch)
                : (row.kind === 'agent_edited' || row.kind === 'agent_disabled') && row.agentId
                  ? `/${slug}/agents/${row.agentId}`
                  : null;
              const inAppLabel = batch ? 'Open batch' : 'Open agent';
              return (
                <li key={row.id} className="relative">
                  <div
                    onClick={(event) => {
                      if (selectionMode || event.shiftKey || event.metaKey || event.ctrlKey) {
                        event.preventDefault();
                        toggle(row.id);
                        return;
                      }
                      markReadOnOpen(row);
                    }}
                    className={`relative flex items-start gap-3 rounded-lg border p-3 ${
                      isSelected
                        ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500 dark:border-blue-600 dark:bg-blue-950/40'
                        : unread
                          ? 'border-blue-200 bg-blue-50/40 dark:border-blue-900 dark:bg-blue-950/20'
                          : 'border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950'
                    } ${
                      row.refUrl || agentHref
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
                      ) : row.kind === 'agent_edited' ? (
                        <span
                          title="Someone edited this agent"
                          className="text-amber-600 dark:text-amber-400"
                        >
                          <Icon path={ICONS.pencil} className="h-[18px] w-[18px]" />
                        </span>
                      ) : isBatchNotificationKind(row.kind) ? (
                        // A batch is a stack of files being worked through;
                        // failed rows go red so a failure reads at a glance
                        // in a feed of finishes.
                        <span
                          title={batch ? batch.kindLabel : 'Batch job'}
                          className={
                            row.kind === 'batch_failed'
                              ? 'text-red-600 dark:text-red-400'
                              : 'text-blue-600 dark:text-blue-400'
                          }
                        >
                          <Icon path={ICONS.fileText} className="h-[18px] w-[18px]" />
                        </span>
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
                        tree, named by the headline. Selection clicks are
                        intercepted above before the anchor navigates.
                      */}
                      <p className="text-sm font-medium">
                        {row.refUrl ? (
                          <a
                            href={row.refUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(event) => {
                              if (
                                selectionMode ||
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
                        ) : agentHref ? (
                          <Link
                            href={agentHref}
                            onClick={(event) => {
                              if (
                                selectionMode ||
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
                          </Link>
                        ) : (
                          row.headline
                        )}
                      </p>
                      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                        {notificationSourceLabel(row)}
                        {batchProgress ? ` · ${batchProgress}` : ''} ·{' '}
                        <LocalTime at={row.createdAt} format="datetime" />
                      </p>
                    </div>
                    {/* `relative` puts the menu trigger above the stretched
                        pseudo-element, so it stays clickable on a linked
                        card. Every per-card action lives in this one menu. */}
                    <div className="relative shrink-0">
                      <button
                        type="button"
                        aria-haspopup="menu"
                        aria-expanded={menuFor === row.id}
                        aria-label={`Actions for "${row.headline}"`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setMenuFor((current) => (current === row.id ? null : row.id));
                        }}
                        className="rounded-md border border-gray-300 bg-white p-1.5 text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:border-gray-500 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600 dark:hover:text-white"
                      >
                        <Icon path={ICONS.moreHorizontal} className="h-4 w-4" strokeWidth={3} />
                      </button>
                      {menuFor === row.id ? (
                        <div
                          ref={menuRef}
                          role="menu"
                          onClick={(event) => event.stopPropagation()}
                          className="absolute right-0 top-8 z-40 w-44 rounded-lg border border-gray-200 bg-white py-1 text-sm shadow-lg dark:border-gray-700 dark:bg-gray-900"
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
                          {agentHref ? (
                            <Link
                              role="menuitem"
                              href={agentHref}
                              onClick={() => {
                                setMenuFor(null);
                                markReadOnOpen(row);
                              }}
                              className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-800"
                            >
                              <Icon path={ICONS.externalLink} className="h-4 w-4" />
                              {inAppLabel}
                            </Link>
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
                              void setRead([row.id], unread);
                            }}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-800"
                          >
                            <Icon
                              path={unread ? ICONS.check : ICONS.unreadDot}
                              className="h-4 w-4"
                            />
                            {unread ? 'Mark as read' : 'Mark as unread'}
                          </button>
                          <button
                            role="menuitem"
                            type="button"
                            onClick={() => {
                              setMenuFor(null);
                              toggle(row.id);
                            }}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-800"
                          >
                            <Icon path={ICONS.checkbox} className="h-4 w-4" />
                            Select
                          </button>
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
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {/* Sticky multi-select footer — appears with the first selected card.
          Three rows, three visual weights: select all/none is a neutral
          toggle, mark read/unread wear the primary tint, Cancel is a quiet
          ghost so it cannot be mistaken for an action, and Delete alone is
          red. */}
      {selectionMode ? (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-gray-200 bg-white/95 px-4 py-3 backdrop-blur dark:border-gray-800 dark:bg-gray-950/95">
          <div className="mx-auto max-w-3xl space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-gray-600 dark:text-gray-400">
                {selected.size} selected
              </span>
              {allSelected ? (
                <button
                  type="button"
                  onClick={() => setSelected(new Set())}
                  className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900"
                >
                  <Icon path={ICONS.checkbox} className="h-4 w-4" />
                  Select none
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setSelected(new Set(visible.map((row) => row.id)))}
                  className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900"
                >
                  <Icon path={ICONS.checkboxChecked} className="h-4 w-4" />
                  Select all
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  void setRead([...selected], true);
                  setSelected(new Set());
                }}
                className="flex items-center justify-center gap-1.5 rounded-md border border-blue-300 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300 dark:hover:bg-blue-950/70"
              >
                <Icon path={ICONS.check} className="h-4 w-4" />
                Mark as read
              </button>
              <button
                type="button"
                onClick={() => {
                  void setRead([...selected], false);
                  setSelected(new Set());
                }}
                className="flex items-center justify-center gap-1.5 rounded-md border border-blue-300 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300 dark:hover:bg-blue-950/70"
              >
                <Icon path={ICONS.unreadDot} className="h-4 w-4" />
                Mark as unread
              </button>
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="rounded-md px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => setConfirming([...selected])}
                className="flex items-center justify-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
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
