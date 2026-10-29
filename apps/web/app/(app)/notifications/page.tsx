import React from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getDataStore } from '@renkei/db';
import { wrapAsync } from '@campfhir/safe-functions/helpers';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import AutoRefresh from '@/components/auto-refresh';
import NotificationsList, { type NotificationCard } from './notifications-list';
import CoachTarget from '@/components/coach-marks/anchor';

/**
 * What your agents have been doing.
 *
 * A server component reading the database directly, and `<AutoRefresh/>`
 * rather than a second poller — the same reasoning the card feed uses: the
 * page stays a plain query, with no duplicate of it hiding in an API route
 * and no loading flash on refresh. The corner toasts are the live surface;
 * this is the one you come to on purpose. The rows render through a client
 * component (notifications-list) because the feed is interactive now —
 * selection, swipe-to-delete, per-card menus.
 */

const PAGE_SIZE = 100;

export default async function NotificationsPage(): Promise<React.ReactNode> {
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl(`/notifications`));

  // One extra row, never rendered, just to answer "is there more?" without
  // a second count query — PAGE_SIZE + 1 rows back means yes. Own rows
  // only, and structurally so: no parameter here can name another subject.
  //
  // A person can have more unread notifications than fit in PAGE_SIZE — the
  // ones past it never render, so they can never be clicked read one at a
  // time. "Mark all as read" has to reach every one of them, which means
  // knowing the true total, not just what's on the page.
  const store = getDataStore().notifications;
  const read = await wrapAsync(
    () =>
      Promise.all([
        store.list(session.subject, { limit: PAGE_SIZE + 1 }),
        store.countUnread(session.subject),
      ]),
    'DB_ERROR' as const
  );
  const [fetched, unreadCount] = read.ok ? read.val : [[], 0];
  const hasMore = fetched.length > PAGE_SIZE;
  const rows = hasMore ? fetched.slice(0, PAGE_SIZE) : fetched;

  const cards: NotificationCard[] = rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    connector: row.connector,
    entity: row.entity,
    headline: row.headline,
    refUrl: row.refUrl,
    agentId: row.agentId,
    agentName: row.agentName,
    runId: row.runId,
    meta: row.meta,
    unread: row.readAt === null,
    createdAt: row.createdAt.toISOString(),
  }));

  return (
    <div className="mx-auto max-w-3xl">
      <AutoRefresh />
      <h1 className="mb-1 text-xl font-bold">Notifications</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        What your agents and batch jobs did — the things that changed something, not every step they
        took.{' '}
        <CoachTarget name="notifications-preferences-link" as="span">
          <Link href={`/preferences`} className="text-blue-600 hover:underline dark:text-blue-400">
            Choose what appears here
          </Link>
        </CoachTarget>
        .
      </p>

      {cards.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500 dark:border-gray-700">
          Nothing yet. When one of your agents files a ticket or sends a message, it lands here.
        </p>
      ) : (
        <NotificationsList rows={cards} unreadCount={unreadCount} initialHasMore={hasMore} />
      )}
    </div>
  );
}
