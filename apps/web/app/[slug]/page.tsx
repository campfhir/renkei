import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import ActionableCards from './cards';
import ActionableFeed from './actionable-feed';
import AutoRefresh from '@/components/auto-refresh';

/** How many cards a page of the feed shows — a tenant's full history can
 * run into the hundreds, and rendering all of it (evidence blocks, action
 * buttons and all) on every toggle was most of what made the feed slow. */
const PAGE_SIZE = 10;

/**
 * Where a signed-in user lands: the actionable-item feed, which is the point
 * of the product. Everything else — connectors, logs, admin — hangs off the
 * nav in the layout, surfaced there by role. `?archived=1` widens the feed
 * to the full history, archived cards included; `?page=` pages through it,
 * PAGE_SIZE at a time.
 */
export default async function HomePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ archived?: string; page?: string }>;
}): Promise<React.ReactNode> {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();

  const session = await getSessionFromCookies(tenant.id);
  if (!session) {
    redirect(signInUrl(tenant.id, `/${slug}`));
  }

  const resolvedSearchParams = await searchParams;
  const showArchived = resolvedSearchParams.archived === '1';
  const requestedPage = Number.parseInt(resolvedSearchParams.page ?? '1', 10);
  const page = Number.isFinite(requestedPage) && requestedPage > 1 ? requestedPage : 1;

  const dbResult = getDatabase();
  // One extra row, never rendered, just to answer "is there another page?"
  // without a second count query — PAGE_SIZE + 1 rows back means yes.
  let query = dbResult.ok
    ? dbResult.val
        .selectFrom('actionable_items')
        .leftJoin('agents', 'agents.id', 'actionable_items.created_by_agent_id')
        .select([
          'actionable_items.id as id',
          'actionable_items.source as source',
          'actionable_items.kind as kind',
          'actionable_items.status as status',
          'actionable_items.title as title',
          'actionable_items.summary as summary',
          'actionable_items.evidence as evidence',
          'actionable_items.result as result',
          'actionable_items.suggested_action as suggested_action',
          'actionable_items.run_id as run_id',
          'actionable_items.created_by_agent_id as agent_id',
          'actionable_items.archived_at as archived_at',
          'agents.name as agent_name',
        ])
        .where('actionable_items.tenant_id', '=', tenant.id)
        .where((eb) =>
          eb.or([
            eb('actionable_items.owner_subject', 'is', null),
            eb('actionable_items.owner_subject', '=', session.subject),
          ])
        )
        .orderBy('actionable_items.created_at', 'desc')
        .limit(PAGE_SIZE + 1)
        .offset((page - 1) * PAGE_SIZE)
    : null;
  if (query && !showArchived) {
    query = query.where('actionable_items.archived_at', 'is', null);
  }
  const fetched = query ? await query.execute() : [];
  const hasMore = fetched.length > PAGE_SIZE;
  const items = hasMore ? fetched.slice(0, PAGE_SIZE) : fetched;

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
      <ActionableFeed slug={slug} showArchived={showArchived} page={page} hasMore={hasMore}>
        {dbResult.ok ? (
          <ActionableCards
            items={items}
            tenantId={tenant.id}
            subject={session.subject}
            slug={slug}
            showArchived={showArchived}
          />
        ) : (
          <p className="text-sm text-red-700 dark:text-red-300">
            Unable to connect to the database. Please try again later.
          </p>
        )}
      </ActionableFeed>
    </div>
  );
}
