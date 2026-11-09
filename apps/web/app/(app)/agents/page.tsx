import React from 'react';
import ImportAgentButton from './import-agent-button';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { listAgents } from '@/lib/agents/store';
import { listAgentsSharedWith } from '@/lib/agents/access-grants';
import { AgentsList } from './agents-list';
import AgentsOverview from './agents-overview';
import { overviewOf } from './agents-overview.model';
import { agentsPageHref, cardsPage, listPage, pageFromParam } from './agents-page.model';
import { Pager } from '@/components/data-table';
import { listLiveRunCounts } from '@/lib/agents/runs-view';
import CoachTarget from '@/components/coach-marks/anchor';
import { ROLE_OPERATOR } from '@/lib/access';
import { countOrgQueue } from '@/lib/agents/org-queue';

/**
 * Your agents — every signed-in user's own list (agents are per-user
 * creations acting on their own grants; the org-wide view is the admin's
 * oversight page) — plus, grouped separately, the agents colleagues shared
 * with them through access grants.
 */
export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<{ inflight?: string; page?: string }>;
}): Promise<React.ReactNode> {
  const session = await getSessionFromCookies();
  if (!session) {
    redirect(signInUrl(`/agents`));
  }

  const [agents, shared] = await Promise.all([
    listAgents(session.subject),
    listAgentsSharedWith(session.subject),
  ]);

  // What every agent has in flight, above the cards: the viewer's own
  // agents and the ones shared with them, both access-resolved above.
  const overviewAgents = [
    ...agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      enabled: agent.enabled,
      shared: false,
    })),
    ...shared.map((listing) => ({
      id: listing.agent.id,
      name: listing.agent.name,
      enabled: listing.agent.enabled,
      shared: true,
    })),
  ];
  const liveCounts = await listLiveRunCounts(overviewAgents.map((agent) => agent.id));
  const overview = overviewOf(overviewAgents, liveCounts, Date.now());
  // An operator also gets the way to every agent's queue in the organization.
  const isOperator = session.roles.includes(ROLE_OPERATOR);
  const orgLive = isOperator
    ? (await countOrgQueue()).reduce((sum, row) => sum + row.count, 0)
    : null;

  // Ten to a page, the overview and the cards each with their own place.
  const requested = await searchParams;
  const inflightPage = listPage(overview.rows, pageFromParam(requested.inflight));
  const cards = cardsPage(agents, shared, pageFromParam(requested.page));
  const places = { inflight: inflightPage.page, page: cards.paging.page };
  const inflightHref = (to: number) => agentsPageHref({ ...places, inflight: to });
  const cardsHref = (to: number) => agentsPageHref({ ...places, page: to }, 'agents-list');

  return (
    <div className="mx-auto max-w-3xl">
      {/*
        The button belongs to the TITLE row, not to the title-plus-description
        block. Centring it against both put it level with the gap between
        them, so it read as floating next to the prose rather than as the
        action for the heading. The description then spans the full width
        beneath, where a line of prose wants to be anyway.
      */}
      <div className="mb-1 flex items-center justify-between gap-3">
        <h1 className="min-w-0 truncate text-xl font-bold">Agents</h1>
        <div className="flex shrink-0 items-center gap-2">
          <ImportAgentButton />
          <CoachTarget name="agents-new" as="span" className="inline-flex shrink-0">
            <Link
              href={`/agents/new`}
              className="shrink-0 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              New agent
            </Link>
          </CoachTarget>
        </div>
      </div>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Step-by-step helpers you draft yourself — they act with your own connections, on your
        triggers, and keep a full history of every run.
      </p>
      {orgLive !== null ? (
        <p className="mb-3 text-sm">
          <Link
            href="/admin/agents/queue"
            className="text-blue-700 hover:underline dark:text-blue-400"
          >
            Organization queue →
          </Link>{' '}
          <span className="text-gray-600 dark:text-gray-400">
            {orgLive === 0
              ? 'nothing in flight across the organization'
              : `${orgLive} unfinished ${orgLive === 1 ? 'run' : 'runs'} across every agent`}
          </span>
        </p>
      ) : null}
      <AgentsOverview
        overview={overview}
        page={inflightPage}
        previousHref={inflightPage.hasPrevious ? inflightHref(inflightPage.page - 1) : null}
        nextHref={inflightPage.hasNext ? inflightHref(inflightPage.page + 1) : null}
      />
      {/* The cards' pager lands here (#agents-list), not at the page top. */}
      <div id="agents-list" className="scroll-mt-4">
        <CoachTarget name="agents-list">
          <AgentsList
            agents={cards.agents}
            shared={cards.shared.map((listing) => ({
              agent: listing.agent,
              sharedBy: listing.ownerName || listing.ownerEmail || 'a colleague',
              expiresAt: listing.expiresAt,
            }))}
          />
        </CoachTarget>
        <Pager
          className="mt-2"
          label="Agent pages"
          range={cards.paging.range ? `Agents ${cards.paging.range}` : null}
          previousHref={cards.paging.hasPrevious ? cardsHref(cards.paging.page - 1) : null}
          nextHref={cards.paging.hasNext ? cardsHref(cards.paging.page + 1) : null}
        />
      </div>
    </div>
  );
}
