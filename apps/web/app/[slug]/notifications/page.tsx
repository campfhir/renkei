import React from 'react';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { getDatabase } from '@renkei/db';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import AutoRefresh from '@/components/auto-refresh';
import ConnectorIcon from '@/components/connector-icon';
import LocalTime from '@/components/local-time';
import MarkAllRead from './mark-all-read';

/**
 * What your agents have been doing.
 *
 * A server component reading the database directly, and `<AutoRefresh/>`
 * rather than a second poller — the same reasoning the card feed uses: the
 * page stays a plain query, with no duplicate of it hiding in an API route
 * and no loading flash on refresh. The corner toasts are the live surface;
 * this is the one you come to on purpose.
 */

const PAGE_SIZE = 100;

/** A day heading a person recognises without doing arithmetic. */
function dayLabel(when: Date, today: Date): string {
  const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diff = Math.round((day(today).getTime() - day(when).getTime()) / 86_400_000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return when.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

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
  const now = new Date();

  // Grouped in one pass, order preserved — the query already sorted.
  const days: { label: string; rows: typeof rows }[] = [];
  for (const row of rows) {
    const label = dayLabel(new Date(row.created_at), now);
    const last = days[days.length - 1];
    if (last && last.label === label) last.rows.push(row);
    else days.push({ label, rows: [row] });
  }

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

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500 dark:border-gray-700">
          Nothing yet. When one of your agents files a ticket or sends a message, it lands here.
        </p>
      ) : (
        <div className="space-y-6">
          {days.map((day) => (
            <section key={day.label}>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                {day.label}
              </h2>
              <ul className="space-y-1.5">
                {day.rows.map((row) => (
                  <li
                    key={row.id}
                    className={`relative flex items-start gap-3 rounded-lg border p-3 ${
                      row.read_at === null
                        ? 'border-blue-200 bg-blue-50/40 dark:border-blue-900 dark:bg-blue-950/20'
                        : 'border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950'
                    } ${
                      row.ref_url
                        ? 'transition-colors hover:border-blue-400 dark:hover:border-blue-700'
                        : ''
                    }`}
                  >
                    <span className="mt-0.5 shrink-0">
                      {row.connector ? (
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
                        The headline IS the link, stretched over the whole
                        row by a pseudo-element. A notification is about one
                        thing, so the obvious click — anywhere on the card —
                        should go to that thing rather than to a small "Open"
                        at the far right. Doing it this way keeps exactly one
                        link in the accessibility tree, named by the
                        headline, where wrapping the row in an anchor would
                        have swallowed the Run link inside it.
                      */}
                      <p className="text-sm font-medium">
                        {row.ref_url ? (
                          <a
                            href={row.ref_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:underline after:absolute after:inset-0 after:rounded-lg"
                          >
                            {row.headline}
                          </a>
                        ) : (
                          row.headline
                        )}
                      </p>
                      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                        {row.agent_name ?? 'An agent'} ·{' '}
                        <LocalTime at={row.created_at} format="datetime" />
                      </p>
                    </div>
                    {/* `relative` puts this above the stretched pseudo-element,
                        so the run link stays reachable on a linked card. */}
                    <div className="relative flex shrink-0 items-center gap-3 text-xs">
                      {row.ref_url ? (
                        <span
                          aria-hidden="true"
                          title="Opens in the connector"
                          className="text-blue-600 dark:text-blue-400"
                        >
                          ↗
                        </span>
                      ) : null}
                      {row.run_id ? (
                        <Link
                          href={`/${slug}/agents/${row.agent_id ?? ''}/runs/${row.run_id}`}
                          className="text-gray-500 hover:underline"
                        >
                          Run
                        </Link>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
