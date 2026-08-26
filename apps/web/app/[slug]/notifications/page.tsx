import React from 'react';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { getDatabase } from '@renkei/db';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import AutoRefresh from '@/components/auto-refresh';
import MarkAllRead from './mark-all-read';
import NotificationsList, { type NotificationCard } from './notifications-list';

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

export default async function NotificationsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactNode> {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();

  const session = await getSessionFromCookies(tenant.id);
  if (!session) redirect(signInUrl(tenant.id, `/${slug}/notifications`));

  const dbResult = getDatabase();
  const rows = dbResult.ok
    ? await dbResult.val
        .selectFrom('agent_notifications')
        .selectAll()
        // Own rows only, and structurally so: no parameter here can name
        // another subject.
        .where('tenant_id', '=', tenant.id)
        .where('subject', '=', session.subject)
        .orderBy('created_at', 'desc')
        .limit(PAGE_SIZE)
        .execute()
    : [];

  const unread = rows.filter((row) => row.read_at === null).length;

  const cards: NotificationCard[] = rows.map((row) => ({
    id: row.id,
    connector: row.connector,
    entity: row.entity,
    headline: row.headline,
    refUrl: row.ref_url,
    agentId: row.agent_id,
    agentName: row.agent_name,
    runId: row.run_id,
    unread: row.read_at === null,
    createdAt: new Date(row.created_at).toISOString(),
  }));

  return (
    <div className="mx-auto max-w-3xl">
      <AutoRefresh />
      <div className="mb-1 flex items-center justify-between gap-4">
        <h1 className="text-xl font-bold">Notifications</h1>
        {unread > 0 ? <MarkAllRead tenantId={tenant.id} /> : null}
      </div>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        What your agents did — the things that changed something, not every step they took.{' '}
        <Link
          href={`/${slug}/preferences`}
          className="text-blue-600 hover:underline dark:text-blue-400"
        >
          Choose what appears here
        </Link>
        .
      </p>

      {cards.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500 dark:border-gray-700">
          Nothing yet. When one of your agents files a ticket or sends a message, it lands here.
        </p>
      ) : (
        <NotificationsList tenantId={tenant.id} slug={slug} rows={cards} />
      )}
    </div>
  );
}
