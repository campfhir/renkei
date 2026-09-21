import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import ActionableCards from './cards';
import ActionableFeed from './actionable-feed';
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
      {/*
        The feed changes from OUTSIDE this page — a connector sweep, an
        agent finishing, a colleague's approval — so a view opened five
        minutes ago is quietly wrong. Refreshing the server component keeps
        the cards a direct database read rather than a duplicated query
        behind an API route.
      */}
      <AutoRefresh />
      <ActionableFeed slug={slug} showArchived={showArchived}>
        <ActionableCards
          tenantId={tenant.id}
          slug={slug}
          subject={session.subject}
          showArchived={showArchived}
        />
      </ActionableFeed>
    </div>
  );
}
