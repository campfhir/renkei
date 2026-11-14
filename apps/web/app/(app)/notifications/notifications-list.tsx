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

import { useEffect, useReducer, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import ConnectorIcon from '@/components/connector-icon';
import LocalTime from '@/components/local-time';
import { Icon, ICONS } from '@/components/icons';
import { useNotifications } from '@/components/notification-center';
import { isBatchNotificationKind, notificationSourceLabel } from '@/lib/notifications/batch-meta';
import { useCoachAnchor } from '@/components/coach-marks/anchor';
import { reportFetchFailure } from '@/lib/fetch-json';
import {
  MARK_ALL_REQUEST,
  allRows,
  allSelected as allSelectedOf,
  confirmWording,
  deleteRequest,
  feedReducer,
  groupByDay,
  initFeed,
  isUnread as isUnreadIn,
  markAllBanner,
  moreQuery,
  parseMorePage,
  readRequest,
  refLinkAttrs,
  rowClick,
  rowLinks,
  selectionMode as selectionModeOf,
  showMoreVisible,
  visibleRows,
  type NotificationCard,
} from './notifications-list.model';
import { useHydrated } from '@/components/hydration-mark';

export type { NotificationCard } from './notifications-list.model';

export default function NotificationsList({
  rows,
  unreadCount,
  initialHasMore,
}: {
  rows: NotificationCard[];
  /**
   * The TRUE unread total, not just how many of the loaded rows are
   * unread — the page only ever fetches the newest PAGE_SIZE, so beyond
   * that this is the only number that reflects reality, and the only way
   * "Mark all as read" can promise to reach rows that never rendered.
   */
  unreadCount: number;
  /** Whether the server page's own query was cut off at PAGE_SIZE. */
  initialHasMore: boolean;
}) {
  const hydrated = useHydrated();
  const router = useRouter();
  const { refresh } = useNotifications();
  // Everything the feed decides lives in notifications-list.model.ts.
  const [state, dispatch] = useReducer(feedReducer, initialHasMore, initFeed);
  const { selected, menuFor, confirming } = state;
  const busy = state.deleting;
  const markAllAnchor = useCoachAnchor('notifications-mark-all');

  // The "Show more" pill only shows once the person has actually scrolled
  // to the end of what's loaded — see the sentinel effect below.
  const [nearBottom, setNearBottom] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const selectionMode = selectionModeOf(state);
  const visible = visibleRows(state, rows);
  const allSelected = allSelectedOf(state, rows);
  const isUnread = (row: NotificationCard) => isUnreadIn(state, row);

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
        dispatch({ type: 'menuClosed' });
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dispatch({ type: 'menuClosed' });
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuFor]);

  // Escape closes the confirm dialog (the reducer ignores it mid-delete).
  useEffect(() => {
    if (!confirming) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dispatch({ type: 'deleteCancelled' });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [confirming]);

  // The "Show more" pill floats over the viewport, so it must not appear
  // until there's blank space under the list for it to float over — the
  // spacer below IS that space, and doubles as the scroll trigger: once
  // the person scrolls it into view, they've reached the end of what's
  // loaded, which is exactly when the pill should show up. The browser
  // keeps tracking the same element's position as the page grows (a
  // "Show more" click adds rows above it), so this only needs to
  // reattach when the sentinel itself is mounted or unmounted.
  const hasMore = state.hasMore;
  useEffect(() => {
    const element = sentinelRef.current;
    if (!element || !hasMore || typeof IntersectionObserver === 'undefined') {
      setNearBottom(false);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setNearBottom(entry.isIntersecting));
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasMore]);

  const toggle = (id: string) => dispatch({ type: 'toggle', id });

  /** POST /api/notifications; answers whether the server took it. */
  async function post(body: unknown): Promise<boolean> {
    try {
      const response = await fetch(`/api/notifications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok)
        reportFetchFailure(
          'POST',
          '/api/notifications',
          response.status,
          `Request failed (${response.status})`
        );
      return response.ok;
    } catch (error) {
      reportFetchFailure('POST', '/api/notifications', 0, 'Could not reach the server', error);
      return false;
    }
  }

  /** Optimistic: the row dims (or brightens) at once; the server catches up on refresh. */
  async function setRead(ids: string[], read: boolean) {
    if (ids.length === 0) return;
    dispatch({ type: 'readChanged', ids, read });
    // A refusal leaves the optimistic state; the next poll or refresh reconciles.
    await post(readRequest(ids, read));
    refresh();
    router.refresh();
  }

  /** Tapping a card is reading it — every open path funnels through here. */
  const markReadOnOpen = (row: NotificationCard) => {
    if (isUnread(row)) void setRead([row.id], true);
  };

  /**
   * Reaches every unread notification, including the ones past PAGE_SIZE
   * that never made it into `rows` — the one action in this file that is
   * NOT scoped to what's loaded, because it exists specifically for the
   * rows that can't be.
   */
  async function markAllRead() {
    dispatch({ type: 'markAllSent' });
    if (await post(MARK_ALL_REQUEST)) {
      dispatch({ type: 'markedAll', ids: allRows(state, rows).map((row) => row.id) });
      refresh();
      router.refresh();
    } else {
      dispatch({ type: 'markAllFailed' });
    }
  }

  /** "Show more": one page further back than whatever's currently loaded. */
  async function loadMore() {
    const query = moreQuery(state, rows);
    if (!query) return;
    dispatch({ type: 'moreSent' });
    try {
      const url = new URL(`/api/notifications`, window.location.origin);
      url.searchParams.set('before', query.before);
      url.searchParams.set('limit', query.limit);
      const response = await fetch(url.toString());
      if (!response.ok) {
        reportFetchFailure(
          'GET',
          '/api/notifications',
          response.status,
          `Request failed (${response.status})`
        );
        dispatch({ type: 'moreFailed' });
        return;
      }
      dispatch({ type: 'moreLoaded', rows: parseMorePage(await response.json()) });
    } catch (error) {
      reportFetchFailure('GET', '/api/notifications', 0, 'Could not reach the server', error);
      dispatch({ type: 'moreFailed' });
    }
  }

  async function deleteIds(ids: string[]) {
    dispatch({ type: 'deleteSent' });
    try {
      const response = await fetch(`/api/notifications`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deleteRequest(ids)),
      });
      if (!response.ok) {
        reportFetchFailure(
          'DELETE',
          '/api/notifications',
          response.status,
          `Request failed (${response.status})`
        );
        // Nothing was deleted; the dialog stays up so the person can retry.
        dispatch({ type: 'deleteFailed' });
        return;
      }
      dispatch({ type: 'deleted', ids });
      refresh();
      router.refresh();
    } catch (error) {
      reportFetchFailure('DELETE', '/api/notifications', 0, 'Could not reach the server', error);
      dispatch({ type: 'deleteFailed' });
    }
  }

  const confirmCount = confirming?.length ?? 0;
  const wording = confirmWording(confirmCount);

  if (visible.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500 dark:border-gray-700">
        Nothing here. When one of your agents files a ticket or sends a message, it lands here.
      </p>
    );
  }

  const days = groupByDay(visible, new Date());
  const banner = markAllBanner(state, rows, unreadCount);

  return (
    <div className="space-y-6" data-hydrated={hydrated ? 'notifications' : undefined}>
      {banner ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-gray-500 dark:text-gray-400">{banner}</span>
          <button
            type="button"
            disabled={state.markingAll}
            onClick={() => void markAllRead()}
            {...markAllAnchor}
            className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
          >
            <Icon path={ICONS.check} className="h-4 w-4" />
            {state.markingAll ? 'Marking…' : 'Mark all as read'}
          </button>
        </div>
      ) : null}
      {days.map((day) => (
        <section key={day.label}>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
            {day.label}
          </h2>
          <ul className="space-y-1.5">
            {day.rows.map((row) => {
              const isSelected = selected.has(row.id);
              const unread = isUnread(row);
              const {
                openLabel,
                runHref,
                agentHref,
                inAppLabel,
                primaryInAppHref,
                runIsPrimary,
                batch,
                batchProgress,
              } = rowLinks(row);
              return (
                <li key={row.id} className="relative">
                  <div
                    onClick={(event) => {
                      if (rowClick(state, event) === 'select') {
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
                      row.refUrl || primaryInAppHref
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
                      ) : row.kind === 'approval' ? (
                        <span
                          title="Needs your approval"
                          className="text-amber-600 dark:text-amber-400"
                        >
                          <Icon path={ICONS.approval} className="h-[18px] w-[18px]" />
                        </span>
                      ) : row.kind === 'question' ? (
                        <span
                          title="Has a question for you"
                          className="text-amber-600 dark:text-amber-400"
                        >
                          <Icon path={ICONS.question} className="h-[18px] w-[18px]" />
                        </span>
                      ) : row.kind === 'chat_shared' ||
                        row.kind === 'agent_shared' ||
                        row.kind === 'artifact_shared' ||
                        row.kind === 'artifact_transferred' ? (
                        <span title="Shared with you" className="text-blue-600 dark:text-blue-400">
                          <Icon path={ICONS.share} className="h-[18px] w-[18px]" />
                        </span>
                      ) : row.kind === 'artifact_copied' ? (
                        <span
                          title="Copied a file of yours"
                          className="text-blue-600 dark:text-blue-400"
                        >
                          <Icon path={ICONS.copy} className="h-[18px] w-[18px]" />
                        </span>
                      ) : row.kind === 'chat_permission' ? (
                        <span
                          title="A chat is waiting for your permission"
                          className="text-amber-600 dark:text-amber-400"
                        >
                          <Icon path={ICONS.approval} className="h-[18px] w-[18px]" />
                        </span>
                      ) : row.kind === 'chat_reply' ? (
                        <span
                          title="Replied in a chat"
                          className="text-blue-600 dark:text-blue-400"
                        >
                          <Icon path={ICONS.chat} className="h-[18px] w-[18px]" />
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
                      ) : row.kind === 'change_request' || row.kind === 'change_result' ? (
                        // Our own glyph, not the Salesforce or Jira logo: a change
                        // request must not read as one more Salesforce/Jira event.
                        <span
                          data-testid="change-notification-icon"
                          title={
                            row.kind === 'change_request'
                              ? 'A change request is waiting'
                              : 'A change request finished'
                          }
                          className={
                            row.kind === 'change_request'
                              ? 'text-amber-600 dark:text-amber-400'
                              : 'text-blue-600 dark:text-blue-400'
                          }
                        >
                          <Icon path={ICONS.changeRequest} className="h-[18px] w-[18px]" />
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
                      <p className="break-words text-sm font-medium">
                        {row.refUrl ? (
                          <a
                            href={row.refUrl}
                            {...refLinkAttrs(row.refUrl)}
                            onClick={(event) => {
                              if (rowClick(state, event) === 'select') event.preventDefault();
                            }}
                            className="hover:underline after:absolute after:inset-0 after:rounded-lg"
                          >
                            {row.headline}
                          </a>
                        ) : primaryInAppHref ? (
                          <Link
                            href={primaryInAppHref}
                            onClick={(event) => {
                              if (rowClick(state, event) === 'select') event.preventDefault();
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
                          dispatch({ type: 'menuToggled', id: row.id });
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
                              {...refLinkAttrs(row.refUrl)}
                              onClick={() => dispatch({ type: 'menuClosed' })}
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
                                dispatch({ type: 'menuClosed' });
                                markReadOnOpen(row);
                              }}
                              className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-800"
                            >
                              <Icon path={ICONS.externalLink} className="h-4 w-4" />
                              {inAppLabel}
                            </Link>
                          ) : null}
                          {runHref && !runIsPrimary ? (
                            <Link
                              role="menuitem"
                              href={runHref}
                              onClick={() => dispatch({ type: 'menuClosed' })}
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
                              dispatch({ type: 'menuClosed' });
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
                              dispatch({ type: 'menuClosed' });
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
                              dispatch({ type: 'deleteAsked', ids: [row.id] });
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

      {/* The sentinel IS the padding: blank space under the last card so
          the floating pill below never lands on top of content, and the
          trigger for showing it — scrolling this into view means the
          person has actually reached the end of the list. */}
      {hasMore ? <div ref={sentinelRef} className="h-16" aria-hidden="true" /> : null}

      {/* Floating "Show more" — the same pill as chat's "Jump to latest"
          (message-list.tsx), same styling, different positioning: that one
          is `sticky` inside a bounded, scrolling message pane; this page
          has no such pane, the whole document scrolls, so this is `fixed`
          to the viewport instead — a floating CTA rather than a sticky
          footer. Hidden in selection mode so it never competes with the
          fixed multi-select footer below, and hidden until the sentinel
          above says the person has actually scrolled down to it. */}
      {showMoreVisible(state, nearBottom) ? (
        <div className="fixed inset-x-0 bottom-4 z-20 flex justify-center">
          <button
            type="button"
            disabled={state.loadingMore}
            onClick={() => void loadMore()}
            className="rounded-full border border-gray-300 bg-white px-4 py-1.5 text-xs font-medium shadow-lg hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:hover:bg-gray-800"
          >
            {state.loadingMore ? 'Loading…' : 'Show more'}
          </button>
        </div>
      ) : null}

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
                  onClick={() => dispatch({ type: 'selectNone' })}
                  className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900"
                >
                  <Icon path={ICONS.checkbox} className="h-4 w-4" />
                  Select none
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => dispatch({ type: 'selectAll', ids: visible.map((row) => row.id) })}
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
                  dispatch({ type: 'selectNone' });
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
                  dispatch({ type: 'selectNone' });
                }}
                className="flex items-center justify-center gap-1.5 rounded-md border border-blue-300 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300 dark:hover:bg-blue-950/70"
              >
                <Icon path={ICONS.unreadDot} className="h-4 w-4" />
                Mark as unread
              </button>
              <button
                type="button"
                onClick={() => dispatch({ type: 'selectNone' })}
                className="rounded-md px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => dispatch({ type: 'deleteAsked', ids: [...selected] })}
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
            dispatch({ type: 'deleteCancelled' });
          }}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-4 shadow-xl dark:border-gray-800 dark:bg-gray-950"
          >
            <h2 className="text-base font-semibold">{wording.title}</h2>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              {wording.body} from your feed for good. This doesn’t undo anything the agent did.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => dispatch({ type: 'deleteCancelled' })}
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
