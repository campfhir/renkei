import React from 'react';
import { redirect } from 'next/navigation';
import { getDataStore, type ActionableItemRecord } from '@renkei/db';
import { wrapAsync } from '@campfhir/safe-functions/helpers';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import ActionableCards, { type ActionableItemRow } from './cards';
import ActionableFeed from './actionable-feed';
import AutoRefresh from '@/components/auto-refresh';

/** How many cards a page of the feed shows — a tenant's full history can
 * run into the hundreds, and rendering all of it (evidence blocks, action
 * buttons and all) on every toggle was most of what made the feed slow. */
const PAGE_SIZE = 10;

/** A stored card as the card component reads it. */
function toCardRow(item: ActionableItemRecord): ActionableItemRow {
  return {
    id: item.id,
    source: item.source,
    kind: item.kind,
    status: item.status,
    title: item.title,
    summary: item.summary,
    evidence: item.evidence,
    result: item.result,
    suggested_action: item.suggestedAction,
    run_id: item.runId,
    agent_id: item.agentId,
    archived_at: item.archivedAt,
    agent_name: item.agentName,
  };
}

/**
 * Where a signed-in user lands: the actionable-item feed, which is the point
 * of the product. Everything else — connectors, logs, admin — hangs off the
 * nav in the layout, surfaced there by role. `?archived=1` widens the feed
 * to the full history, archived cards included; `?page=` pages through it,
 * PAGE_SIZE at a time.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ archived?: string; page?: string }>;
}): Promise<React.ReactNode> {
  const session = await getSessionFromCookies();
  if (!session) {
    redirect(signInUrl(`/`));
  }

  const resolvedSearchParams = await searchParams;
  const showArchived = resolvedSearchParams.archived === '1';
  const requestedPage = Number.parseInt(resolvedSearchParams.page ?? '1', 10);
  const page = Number.isFinite(requestedPage) && requestedPage > 1 ? requestedPage : 1;

  // One extra row, never rendered, just to answer "is there another page?"
  // without a second count query — PAGE_SIZE + 1 rows back means yes.
  const read = await wrapAsync(
    () =>
      getDataStore().actionableItems.listVisible(session.subject, {
        limit: PAGE_SIZE + 1,
        offset: (page - 1) * PAGE_SIZE,
        includeArchived: showArchived,
      }),
    'DB_ERROR' as const
  );
  const fetched: ActionableItemRow[] = read.ok ? read.val.map(toCardRow) : [];
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
      <ActionableFeed showArchived={showArchived} page={page} hasMore={hasMore}>
        {read.ok ? (
          <ActionableCards items={items} subject={session.subject} showArchived={showArchived} />
        ) : (
          <p className="text-sm text-red-700 dark:text-red-300">
            Unable to connect to the database. Please try again later.
          </p>
        )}
      </ActionableFeed>
    </div>
  );
}
