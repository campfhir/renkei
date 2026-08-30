import React from 'react';
import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import ActionableCards from './cards';
import AutoRefresh from '@/components/auto-refresh';

/**
 * Where a signed-in user lands: the actionable-item feed, which is the point
 * of the product. Everything else — connectors, logs, admin — hangs off the
 * nav in the layout, surfaced there by role. `?archived=1` widens the feed
 * to the full history, archived cards included.
 */
export default async function HomePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ archived?: string }>;
}): Promise<React.ReactNode> {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();

  const session = await getSessionFromCookies(tenant.id);
  if (!session) {
    redirect(signInUrl(tenant.id, `/${slug}`));
  }

  const showArchived = (await searchParams).archived === '1';

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-1 flex items-baseline justify-between gap-4">
        <h1 className="text-xl font-bold">Actionable items</h1>
        <Link
          href={showArchived ? `/${slug}` : `/${slug}?archived=1`}
          className="whitespace-nowrap text-sm text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
        >
          {showArchived ? 'Hide archived' : 'Show archived'}
        </Link>
      </div>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        {showArchived
          ? 'The full history, archived cards included.'
          : 'Suggestions from your connected tools. Approving executes the action as you.'}
      </p>
      {/*
        The feed changes from OUTSIDE this page — a connector sweep, an
        agent finishing, a colleague's approval — so a view opened five
        minutes ago is quietly wrong. Refreshing the server component keeps
        the cards a direct database read rather than a duplicated query
        behind an API route.
      */}
      <AutoRefresh />
      <ActionableCards
        tenantId={tenant.id}
        slug={slug}
        subject={session.subject}
        showArchived={showArchived}
      />
    </div>
  );
}
